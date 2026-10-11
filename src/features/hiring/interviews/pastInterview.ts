// Logging an interview that already happened ("after the call, fill a scorecard"): the interview is
// created as completed, its scorecards are owed right away and due a full window from now (a call
// logged two days late is not born overdue), and the debrief step is never due in the past.
import type { Draft } from 'immer'
import { formatDual, scheduleInterview, type ScheduleInput } from '@/domain/hiring/scheduling'
import { addHoursISO, candidateName, lowerFirst, pacificToUTC } from '@/domain/hiring/util'
import type { DB, ID } from '@/domain/types'
import { addDays, fmtDay, type ISODate, type ISODateTime } from '@/lib/dates'
import { clockLabel } from './logic'

/** Pacific wall-clock times offered when logging a past interview (7 AM to 6 PM). */
export function pastTimes(): Array<{ hour: number; minute: number; label: string }> {
  const out: Array<{ hour: number; minute: number; label: string }> = []
  for (let hour = 7; hour <= 18; hour++) out.push({ hour, minute: 0, label: clockLabel(hour, 0) })
  return out
}

/** UTC start for a past interview: the Pacific date and time as picked (no weekend snapping). */
export function pastStart(date: ISODate, hour: number, minute = 0): ISODateTime {
  return pacificToUTC(date, hour, minute)
}

/** Day chips for a past interview: Today, Yesterday, then the four days before by name. */
export function pastDayPresets(date: ISODate): Array<{ label: string; date: ISODate }> {
  const out = [
    { label: 'Today', date },
    { label: 'Yesterday', date: addDays(date, -1) },
  ]
  for (let i = 2; i <= 5; i++) {
    const d = addDays(date, -i)
    out.push({ label: fmtDay(d), date: d })
  }
  return out
}

/** Index of the latest past time on `date` that has started by `now`; -1 when none has. */
export function latestStartedTime(date: ISODate, now: ISODateTime): number {
  const times = pastTimes()
  let idx = -1
  times.forEach((t, i) => {
    if (pastStart(date, t.hour, t.minute) <= now) idx = i
  })
  return idx
}

/**
 * Records an interview that already took place. Creates it through scheduleInterview (owed scorecards,
 * debrief next step), then marks it completed with one activity row. Returns the interview id.
 */
export function logPastInterview(draft: Draft<DB>, input: ScheduleInput, opts: { date: ISODate; now: ISODateTime }): ID {
  if (input.startsAt > opts.now) throw new Error('That time has not happened yet. Pick an earlier time, or schedule it instead.')
  const before = draft.activity.length
  const id = scheduleInterview(draft, input, { date: opts.date })
  const interview = draft.interviews.find((i) => i.id === id)
  if (interview) interview.status = 'completed'
  const due = addHoursISO(opts.now, draft.settings.scorecardDueHours)
  for (const s of draft.scorecards) if (s.interviewId === id && !s.submittedAt && s.dueAt < due) s.dueAt = due
  const app = draft.applications.find((a) => a.id === input.applicationId)
  if (app?.nextStep && app.nextStep.text === 'Debrief and decide' && app.nextStep.dueOn < opts.date) app.nextStep.dueOn = opts.date
  // scheduleInterview logged 'Scheduled ... for <a past time>'; say what happened instead.
  const row = draft.activity.slice(before).find((a) => a.kind === 'interview_scheduled' && a.entityId === input.applicationId)
  if (row && app) {
    row.kind = 'interview_completed'
    row.text = `Logged the ${lowerFirst(input.name)} with ${candidateName(draft, app.candidateId)}, held ${formatDual(input.startsAt)}`
  }
  return id
}
