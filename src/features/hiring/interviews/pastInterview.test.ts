import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { fixtureDB } from '@/domain/hiring/testkit'
import type { ScheduleInput } from '@/domain/hiring/scheduling'
import { latestStartedTime, logPastInterview, pastDayPresets, pastStart, pastTimes } from './pastInterview'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

const SAT = '2026-10-10'

function input(startsAt: string): ScheduleInput {
  return { applicationId: 'a-chen', stageId: 'new', name: 'Phone screen', startsAt, durationMin: 30, interviewerIds: ['p-tomas'], format: 'phone', attributes: ['Communication'] }
}

describe('past interview choices', () => {
  it('offers Today, Yesterday and the four days before, weekends included', () => {
    const days = pastDayPresets(SAT)
    expect(days.map((d) => d.date)).toEqual(['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05'])
    expect(days.slice(0, 3).map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Thu, Oct 8'])
  })

  it('keeps the picked day, even on a weekend (no snapping to Monday)', () => {
    expect(pastStart(SAT, 9)).toBe('2026-10-10T16:00:00.000Z') // 9:00 AM PDT on Saturday
    expect(pastTimes()[0].label).toBe('7:00 AM')
  })

  it('finds the latest hour that has started', () => {
    expect(latestStartedTime(SAT, '2026-10-10T07:06:00.000Z')).toBe(-1) // 12:06 AM PT: nothing yet today
    expect(latestStartedTime(SAT, '2026-10-10T17:30:00.000Z')).toBe(3) // 10:30 AM PT: 10:00 AM
    expect(latestStartedTime('2026-10-09', '2026-10-10T07:06:00.000Z')).toBe(pastTimes().length - 1)
  })
})

describe('logPastInterview', () => {
  it('records the interview as completed with a scorecard due a full window from now', () => {
    const db = fixtureDB()
    const now = '2026-10-10T07:06:00.000Z'
    let id = ''
    const next = produce(db, (d) => {
      id = logPastInterview(d, input(pastStart('2026-10-08', 14)), { date: SAT, now })
    })
    const iv = next.interviews.find((i) => i.id === id)
    expect(iv?.status).toBe('completed')
    expect(iv?.startsAt).toBe('2026-10-08T21:00:00.000Z')
    const cards = next.scorecards.filter((s) => s.interviewId === id)
    expect(cards).toHaveLength(1)
    expect(cards[0].interviewerId).toBe('p-tomas')
    expect(cards[0].dueAt).toBe('2026-10-11T07:06:00.000Z')
    const app = next.applications.find((a) => a.id === 'a-chen')
    expect(app?.nextStep?.text).toBe('Debrief and decide')
    expect(app?.nextStep?.dueOn).toBe(SAT)
    const rows = next.activity.filter((a) => a.entityId === 'a-chen')
    expect(rows.map((a) => a.kind)).toEqual(['interview_completed'])
    expect(rows[0].text).toMatch(/^Logged the phone screen with Chen Wu, held Thu, Oct 8, 2:00 PM PT/)
  })

  it('keeps the normal due time (24 hours after the end) when logged during the call', () => {
    const db = fixtureDB()
    const now = '2026-10-09T21:10:00.000Z'
    let id = ''
    const next = produce(db, (d) => {
      id = logPastInterview(d, input('2026-10-09T21:00:00.000Z'), { date: '2026-10-09', now })
    })
    expect(next.scorecards.find((s) => s.interviewId === id)?.dueAt).toBe('2026-10-10T21:30:00.000Z')
  })

  it('refuses a time that has not happened yet', () => {
    const db = fixtureDB()
    expect(() => produce(db, (d) => void logPastInterview(d, input('2026-10-12T17:00:00.000Z'), { date: SAT, now: '2026-10-10T17:00:00.000Z' }))).toThrow(/has not happened yet/)
  })
})
