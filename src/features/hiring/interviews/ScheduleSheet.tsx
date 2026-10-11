// Schedule an interview without integrations: pick the step from the job's interview plan, one of 3
// proposed times (Pacific plus the candidate's zone) or Pick, the duration, the panel and the format.
// Saving creates the interview and its owed scorecards, then shows the scheduling message (Copy, Open
// in mail app) and .ics files for the candidate and the panel (Copy as text when downloads are blocked).
// "Already happened" logs a past interview instead (Today, Yesterday or an earlier day): it is saved as
// completed and the logger's scorecard opens right away.
// Proposed times follow the panel, the length and the candidate's zone (conflicts.ts): they skip times a
// panelist is busy or out and times the candidate already has an interview. Any picked time that still
// clashes shows a warning naming who and why; it can be scheduled anyway.
import { useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { type DraftMessage, formatDual, interviewICS, proposeTimesFor, scheduleInterview, schedulingMessage } from '@/domain/hiring/scheduling'
import { stageById } from '@/domain/hiring/pipeline'
import { candidateName, dbHolidays, lowerFirst } from '@/domain/hiring/util'
import { founder, fullName, getPerson, isEmployedOn, personNameById } from '@/domain/people'
import type { ID, Interview } from '@/domain/types'
import { addBusinessDays, nowISO, today } from '@/lib/dates'
import { mailtoHref } from '@/lib/email'
import { slug } from '@/lib/files'
import { listJoin } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, ChipMulti, DateChips, Field, focusFirstInvalid, rovingKeyDown, rovingTabIndex, Segmented, Select, Sheet, TextInput } from '@/ui'
import { act, copyWithToast, downloadOrCopy, InvalidChips, Note, TextPreview } from './common'
import { proposedSlots, slotWarnings } from './conflicts'
import { confirmationBody, defaultStepFor, durationChoices, formatForStage, orderedSteps, pickedStart, pickTimes } from './logic'
import { latestStartedTime, logPastInterview, pastDayPresets, pastStart, pastTimes } from './pastInterview'
import { ScorecardSheet } from './ScorecardSheet'

export type ScheduleMode = 'schedule' | 'log'

const FORMAT_OPTIONS: Array<{ value: Interview['format']; label: string }> = [
  { value: 'video', label: 'Video' },
  { value: 'onsite', label: 'On site' },
  { value: 'phone', label: 'Phone' },
]

export function ScheduleSheet({ applicationId, open, onClose, mode = 'schedule' }: { applicationId: ID; open: boolean; onClose: () => void; mode?: ScheduleMode }) {
  const [scheduledId, setScheduledId] = useState<ID | null>(null)
  const [scorecardId, setScorecardId] = useState<ID | null>(null)
  if (!open) return null
  const close = () => {
    setScheduledId(null)
    setScorecardId(null)
    onClose()
  }
  if (scorecardId) return <ScorecardSheet scorecardId={scorecardId} open onClose={close} />
  return scheduledId ? (
    <InviteSheet interviewId={scheduledId} open onClose={close} justScheduled />
  ) : (
    <ScheduleForm
      applicationId={applicationId}
      initialMode={mode}
      onClose={close}
      onScheduled={setScheduledId}
      onLogged={(cardId) => (cardId ? setScorecardId(cardId) : close())}
    />
  )
}

function ScheduleForm({
  applicationId,
  initialMode,
  onClose,
  onScheduled,
  onLogged,
}: {
  applicationId: ID
  initialMode: ScheduleMode
  onClose: () => void
  onScheduled: (id: ID) => void
  onLogged: (scorecardId: ID | null) => void
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const date = today()
  const interviews = useMemo(() => db.interviews.filter((i) => i.applicationId === applicationId), [db.interviews, applicationId])
  const steps = job ? orderedSteps(job) : []
  const initial = job && app ? defaultStepFor(job, app, interviews) : undefined

  const [stepId, setStepId] = useState<string>(initial?.id ?? 'custom')
  const step = steps.find((s) => s.id === stepId)
  const stageFor = (sid: string | undefined) => (job && sid ? stageById(job, sid) : undefined)
  const [customName, setCustomName] = useState('')
  const [time, setTime] = useState<string>('')
  const [picking, setPicking] = useState(false)
  const [pickDate, setPickDate] = useState<string>(() => addBusinessDays(date, 1, dbHolidays(db)))
  const [pickIdx, setPickIdx] = useState(1)
  const [duration, setDuration] = useState<number>(initial?.durationMin ?? 45)
  const defaultPanel = (sid: string): ID[] => {
    const s = steps.find((x) => x.id === sid)
    const ids = s?.interviewerIds.length ? s.interviewerIds : job ? [job.hiringManagerId] : []
    return ids.filter((id) => {
      const p = getPerson(db, id)
      return !!p && (isEmployedOn(p, date) || p.startDate > date)
    })
  }
  const viewerCanInterview = !!viewer.personId && db.people.some((p) => p.id === viewer.personId && (isEmployedOn(p, date) || p.startDate > date))
  const [panel, setPanel] = useState<ID[]>(() => (initialMode === 'log' && viewerCanInterview && viewer.personId ? [viewer.personId] : defaultPanel(initial?.id ?? '')))
  const [format, setFormat] = useState<Interview['format']>(formatForStage(stageFor(initial?.stageId ?? app?.stageId)?.kind))
  const [mode, setMode] = useState<ScheduleMode>(initialMode)
  const [tried, setTried] = useState(false)
  // Proposed times avoid the panel's interviews and days off, the candidate's own interviews and
  // hours outside 9 to 5 in the candidate's zone. They move when the panel or the length changes.
  const candTz = cand?.timezone ?? null
  const proposals = useMemo(
    () => proposedSlots(db, date, { panelIds: panel, candidateTz: candTz, durationMin: duration, applicationId }),
    [db, date, panel, candTz, duration, applicationId],
  )
  // The chosen proposal, or the first one when the list moved on.
  const chosen = proposals.includes(time) ? time : (proposals[0] ?? '')
  const timeItems = [...proposals.map((t) => ({ on: !picking && t === chosen })), { on: picking }]
  // Logging a past interview: default to the latest hour that has started today, else yesterday.
  const now = nowISO()
  const startedToday = latestStartedTime(date, now)
  const [pastDate, setPastDate] = useState<string>(() => (startedToday >= 0 ? date : pastDayPresets(date)[1].date))
  const [pastIdx, setPastIdx] = useState<number>(() => (startedToday >= 0 ? startedToday : 3))
  const chooseMode = (m: ScheduleMode) => {
    setMode(m)
    // The person logging a past call usually held it.
    if (m === 'log' && viewerCanInterview && viewer.personId && !panel.includes(viewer.personId)) setPanel([viewer.personId])
  }

  if (!app || !job || !cand) {
    return (
      <Sheet open onClose={onClose} title="Schedule interview">
        <p className="text-[14px] text-ink-2">This application is no longer on file.</p>
      </Sheet>
    )
  }

  const name = `${cand.firstName} ${cand.lastName}`
  const people = db.people.filter((p) => isEmployedOn(p, date) || (p.startDate > date && !p.endDate))
  const suggestedIds = [...new Set([job.hiringManagerId, ...job.panelIds, ...steps.flatMap((s) => s.interviewerIds), ...panel])].filter((id) =>
    people.some((p) => p.id === id),
  )
  const others = people.filter((p) => !suggestedIds.includes(p.id)).sort((a, b) => fullName(a).localeCompare(fullName(b)))
  const logging = mode === 'log'
  const pastOptions = pastTimes().map((t, i) => ({ ...t, i, future: pastStart(pastDate, t.hour, t.minute) > now }))
  const pastPick = pastOptions[pastIdx] && !pastOptions[pastIdx].future ? pastOptions[pastIdx] : undefined
  const startsAt = logging
    ? pastPick
      ? pastStart(pastDate, pastPick.hour, pastPick.minute)
      : ''
    : picking
      ? pickedStart(pickDate, pickTimes()[pickIdx].hour, pickTimes()[pickIdx].minute)
      : chosen
  const stage = step ? stageFor(step.stageId) : stageFor(app.stageId)
  const interviewName = step ? step.name : customName.trim() || (stage ? stage.name : 'Interview')

  const chooseStep = (sid: string) => {
    setStepId(sid)
    const s = steps.find((x) => x.id === sid)
    if (s) {
      setDuration(s.durationMin)
      if (mode !== 'log') setPanel(defaultPanel(sid))
      setFormat(formatForStage(stageFor(s.stageId)?.kind))
    }
  }

  const input = {
    applicationId: app.id,
    ...(step ? { stepId: step.id } : {}),
    stageId: step?.stageId ?? app.stageId,
    name: interviewName,
    startsAt,
    durationMin: duration,
    interviewerIds: panel,
    format,
    attributes: step?.attributes ?? [],
  }
  const myCardAfterLog = !!viewer.personId && panel.includes(viewer.personId)
  const warnings = logging ? [] : slotWarnings(db, startsAt, { panelIds: panel, durationMin: duration, applicationId: app.id })
  const panelError = tried && panel.length === 0 ? 'Pick at least one interviewer.' : null
  const timeError = tried && !startsAt ? (logging ? 'Pick a start time that has already passed, or an earlier day.' : 'Pick a time.') : null
  const save = () => {
    if (!startsAt || panel.length === 0) {
      setTried(true)
      focusFirstInvalid()
      return
    }
    if (logging) {
      const res = act(`Logged the ${lowerFirst(interviewName)} with ${name}`, (d) => logPastInterview(d, input, { date, now: nowISO() }))
      if (!res) return
      const cards = useDB.getState().db.scorecards.filter((sc) => sc.interviewId === res.value && !sc.submittedAt)
      const mine = cards.find((sc) => sc.interviewerId === viewer.personId)
      onLogged(mine?.id ?? (viewer.role === 'admin' ? (cards[0]?.id ?? null) : null))
      return
    }
    const res = act(`Scheduled ${lowerFirst(interviewName)} with ${name}`, (d) => scheduleInterview(d, input, { date }))
    if (res) onScheduled(res.value)
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={logging ? `Log a past interview: ${name}` : `Schedule interview: ${name}`}
      subtitle={
        logging
          ? `${job.title}. Saved as completed, with scorecards owed by the panel.`
          : `${job.title}. Times in Pacific${cand.timezone && cand.timezone !== 'America/Los_Angeles' ? " and the candidate's time zone" : ''}.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {logging ? (
            <Button variant="primary" size="lg" icon={myCardAfterLog ? 'edit' : 'check'} onClick={save}>
              {myCardAfterLog ? 'Log it and fill my scorecard' : 'Log interview'}
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon="calendar-check" onClick={save}>
              {warnings.length ? 'Schedule anyway' : 'Schedule interview'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Segmented
          label="Is the interview coming up or already done"
          value={mode}
          onChange={chooseMode}
          options={[
            { value: 'schedule', label: 'Schedule ahead' },
            { value: 'log', label: 'Already happened' },
          ]}
        />
        <Field label="Interview step">
          {() =>
            steps.length ? (
              <ChipGroup
                label="Interview step"
                value={stepId}
                onChange={chooseStep}
                options={[
                  ...steps.map((s) => ({ value: s.id, label: `${stageFor(s.stageId)?.name ?? 'Step'}: ${s.name}` })),
                  { value: 'custom', label: 'Other' },
                ]}
              />
            ) : (
              <p className="text-[13.5px] text-ink-3">This job has no interview plan yet. Name the interview below.</p>
            )
          }
        </Field>
        {(stepId === 'custom' || steps.length === 0) && (
          <Field label="Interview name" hint="For example: Reference call with the hiring manager">
            {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} value={customName} onChange={(e) => setCustomName(e.target.value)} />}
          </Field>
        )}
        {logging ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1.5 text-[13.5px] font-semibold text-ink-2">When it happened</legend>
            <InvalidChips id="sch-past" error={timeError}>
              <DateChips label="Interview date" value={pastDate} onChange={setPastDate} presets={pastDayPresets(date)} max={date} />
              <ChipGroup
                label="Start time (Pacific)"
                value={pastPick ? String(pastIdx) : null}
                onChange={(v) => setPastIdx(Number(v))}
                options={pastOptions.map((t) => ({ value: String(t.i), label: `${t.label} PT`, disabled: t.future, ...(t.future ? { hint: 'Later than now' } : {}) }))}
              />
            </InvalidChips>
            <p className="num text-[13.5px] font-semibold text-ink" aria-live="polite">
              {startsAt ? formatDual(startsAt, cand.timezone) : 'Pick a start time that has already passed.'}
            </p>
          </fieldset>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13.5px] font-semibold text-ink-2">When</legend>
            {/* One Tab stop; arrows, Home and End move focus and Space or Enter picks the time. */}
            <div role="radiogroup" aria-label="Proposed times" onKeyDown={(e) => rovingKeyDown(e)} className="flex flex-col gap-2">
              {proposals.map((t, i) => {
                const on = !picking && t === chosen
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={rovingTabIndex(i, timeItems)}
                    onClick={() => {
                      setPicking(false)
                      setTime(t)
                    }}
                    className={`flex min-h-12 items-center rounded-xl border px-4 text-left text-[14.5px] font-semibold transition-colors ${
                      on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface text-ink hover:border-ink-3'
                    }`}
                  >
                    {formatDual(t, cand.timezone)}
                  </button>
                )
              })}
              <button
                type="button"
                role="radio"
                aria-checked={picking}
                tabIndex={rovingTabIndex(proposals.length, timeItems)}
                onClick={() => setPicking(true)}
                className={`flex min-h-12 items-center rounded-xl border px-4 text-left text-[14.5px] font-semibold transition-colors ${
                  picking ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-line-strong bg-surface text-ink hover:border-ink-3'
                }`}
              >
                Pick another day and time
              </button>
            </div>
            {picking && (
              <div className="mt-2 flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
                <DateChips label="Interview date" value={pickDate} onChange={setPickDate} min={date} weekdaysOnly />
                <ChipGroup
                  size="sm"
                  label="Time (Pacific)"
                  value={String(pickIdx)}
                  onChange={(v) => setPickIdx(Number(v))}
                  options={pickTimes().map((t, i) => ({ value: String(i), label: `${t.label} PT` }))}
                />
                <p className="num text-[13.5px] font-semibold text-ink">{formatDual(startsAt, cand.timezone)}</p>
              </div>
            )}
            <div aria-live="polite">
              {warnings.length > 0 && (
                <Callout tone="warn" title={warnings.length === 1 ? 'This time clashes' : `This time clashes in ${warnings.length} ways`} className="mt-2">
                  <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <span className="mt-1 block">Pick another time or change the panel, or schedule it anyway.</span>
                </Callout>
              )}
            </div>
          </fieldset>
        )}
        <Field label="Length">
          {() => (
            <ChipGroup
              size="sm"
              label="Length in minutes"
              value={String(duration)}
              onChange={(v) => setDuration(Number(v))}
              options={durationChoices(step?.durationMin).map((m) => ({ value: String(m), label: `${m} min` }))}
            />
          )}
        </Field>
        <Field
          label="Panel"
          hint={
            panel.length
              ? `Scorecards are created for ${listJoin(panel.map((id) => personNameById(db, id)))}, due ${db.settings.scorecardDueHours} hours after the interview${logging ? ' (or from now, for a call logged late)' : ''}.`
              : panelError
                ? undefined
                : 'Pick at least one interviewer.'
          }
        >
          {() => (
            <div className="flex flex-col gap-2">
              <InvalidChips id="sch-panel" error={panelError}>
                <ChipMulti
                  label="Interviewers"
                  values={panel}
                  onChange={setPanel}
                  options={suggestedIds.map((id) => ({ value: id, label: personNameById(db, id) }))}
                />
              </InvalidChips>
              {others.length > 0 && (
                <Select
                  aria-label="Add another interviewer"
                  placeholder="Add someone else"
                  value=""
                  onChange={(v) => v && setPanel((p) => [...new Set([...p, v])])}
                  options={others.map((p) => ({ value: p.id, label: `${fullName(p)}, ${p.title}` }))}
                />
              )}
            </div>
          )}
        </Field>
        <Field label="Format">
          {() => <ChipGroup size="sm" label="Format" value={format} onChange={setFormat} options={FORMAT_OPTIONS} />}
        </Field>
      </div>
    </Sheet>
  )
}

/** Scheduling message and calendar files for an interview (after scheduling, or from the list). */
export function InviteSheet({ interviewId, open, onClose, justScheduled }: { interviewId: ID; open: boolean; onClose: () => void; justScheduled?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [mode, setMode] = useState<'this' | 'three' | 'calendly'>('this')
  const interview = db.interviews.find((i) => i.id === interviewId)
  const app = interview ? db.applications.find((a) => a.id === interview.applicationId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const proposals = useMemo(
    () =>
      interview && cand
        ? proposeTimesFor(db, today(), 3, { panelIds: interview.interviewerIds, candidateTz: cand.timezone ?? null, durationMin: interview.durationMin, applicationId: interview.applicationId })
        : [],
    [db, interview, cand],
  )
  if (!open) return null
  if (!interview || !app || !cand) {
    return (
      <Sheet open onClose={onClose} title="Interview">
        <p className="text-[14px] text-ink-2">This interview is no longer on file.</p>
      </Sheet>
    )
  }
  const calendly = db.company.linkOuts.calendly
  const sender = viewer.personId ?? founder(db)?.id ?? ''
  const times = mode === 'three' ? proposals : []
  const hq = db.company.hq
  const confirm = (): DraftMessage => {
    const subject = `Confirmed: ${interview.name} with ${db.company.name}, ${formatDual(interview.startsAt, cand.timezone).split(',').slice(0, 2).join(',')}`
    const body = confirmationBody({
      firstName: cand.firstName,
      interviewName: interview.name,
      when: formatDual(interview.startsAt, cand.timezone),
      durationMin: interview.durationMin,
      format: interview.format,
      panel: interview.interviewerIds.map((id) => personNameById(db, id)),
      companyName: db.company.name,
      address: [hq.street, hq.suite, hq.city].filter(Boolean).join(', '),
      senderName: personNameById(db, sender, db.company.name),
    })
    return { to: cand.email, subject, body, mailto: mailtoHref(cand.email, subject, body) }
  }
  const msg = mode === 'this' ? confirm() : schedulingMessage(db, app.id, times, { senderId: sender, stageId: interview.stageId, durationMin: interview.durationMin })
  const name = candidateName(db, app.candidateId)
  const fileStem = slug(`${interview.name} ${name}`)
  const panelNames = interview.interviewerIds.map((id) => personNameById(db, id))
  const ics = (aud: 'candidate' | 'panel') => interviewICS(db, interview.id, aud) ?? ''

  return (
    <Sheet
      open
      onClose={onClose}
      title={justScheduled ? `Scheduled: ${interview.name}` : `Invite: ${interview.name}`}
      subtitle={`${name}, ${formatDual(interview.startsAt, cand.timezone)}, ${interview.durationMin} min`}
      footer={
        <Button variant="primary" size="lg" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {justScheduled && (
          <Note icon="check">
            Owed scorecards created for {listJoin(panelNames)}, due {db.settings.scorecardDueHours} hours after the interview ends.
          </Note>
        )}
        <section aria-labelledby="inv-msg" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="inv-msg" className="text-[15px] font-bold text-ink">
              Message to {cand.firstName}
            </h3>
            <Segmented
              size="sm"
              label="Times in the message"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'this', label: 'Confirm this time' },
                { value: 'three', label: 'Offer 3 times' },
                ...(calendly ? [{ value: 'calendly' as const, label: 'Calendly link' }] : []),
              ]}
            />
          </div>
          {msg ? (
            <>
              <p className="text-[13.5px] text-ink-2">
                To <span className="font-semibold text-ink">{msg.to}</span>. Subject: <span className="font-semibold text-ink">{msg.subject}</span>
              </p>
              <TextPreview text={msg.body} label="Scheduling message" />
              <div className="flex flex-wrap gap-2">
                <Button icon="copy" onClick={() => void copyWithToast(`Subject: ${msg.subject}\n\n${msg.body}`, 'the scheduling message')}>
                  Copy message
                </Button>
                <a
                  href={msg.mailto}
                  className="ft-btn ft-btn--secondary ft-btn--md inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2"
                >
                  Open in mail app
                </a>
              </div>
            </>
          ) : (
            <p className="text-[13.5px] text-ink-3">The message could not be built for this candidate.</p>
          )}
        </section>
        <section aria-labelledby="inv-ics" className="flex flex-col gap-3">
          <h3 id="inv-ics" className="text-[15px] font-bold text-ink">
            Calendar files
          </h3>
          <p className="text-[13.5px] text-ink-3">The candidate&apos;s copy lists who they will meet. The panel&apos;s copy names the candidate and the scorecard attributes.</p>
          <div className="flex flex-wrap gap-2">
            <Button icon="download" onClick={() => void downloadOrCopy(`${fileStem}-candidate.ics`, ics('candidate'), 'text/calendar;charset=utf-8', 'the candidate calendar file')}>
              Download for {cand.firstName}
            </Button>
            <Button icon="download" onClick={() => void downloadOrCopy(`${fileStem}-panel.ics`, ics('panel'), 'text/calendar;charset=utf-8', 'the panel calendar file')}>
              Download for the panel
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyWithToast(ics('candidate'), 'the candidate calendar file as text')}>
              Copy candidate file as text
            </Button>
            <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyWithToast(ics('panel'), 'the panel calendar file as text')}>
              Copy panel file as text
            </Button>
          </div>
        </section>
      </div>
    </Sheet>
  )
}
