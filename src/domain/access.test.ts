// Access rules that protect pay and independent scorecards, checked on the Ledgerlark sample.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { canSeeCandidatePay, canSeeOffer, canSeeOthersScorecards, isHiredApplication } from '@/domain/access'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'

let db: DB

beforeAll(() => {
  setClockOverride('2026-10-09')
  db = buildSampleDB()
})

afterAll(() => setClockOverride(null))

const viewer = (role: Viewer['role'], personId: string): Viewer => {
  const person = db.people.find((p) => p.id === personId) ?? null
  return { role, personId, person } as Viewer
}
const appFor = (candidateId: string) => {
  const app = db.applications.find((a) => a.candidateId === candidateId)
  if (!app) throw new Error(`no application for ${candidateId}`)
  return app
}

describe('pay on hired applications', () => {
  it('hides a past hire’s offer and desired pay from their hiring manager, but not from admin', () => {
    const app = appFor('c-hire-ravi')
    const job = db.jobs.find((j) => j.id === app.jobId)
    expect(isHiredApplication(db, app)).toBe(true)
    const hm = viewer('manager', job?.hiringManagerId ?? '')
    expect(canSeeCandidatePay(hm, db, app)).toBe(false)
    expect(canSeeOffer(hm, db, app)).toBe(false)
    expect(canSeeCandidatePay(viewer('admin', 'p-founder'), db, app)).toBe(true)
  })

  it('still shows an active candidate’s desired pay to the job’s hiring manager', () => {
    const app = db.applications.find((a) => a.status === 'active' && db.jobs.find((j) => j.id === a.jobId)?.hiringManagerId === 'p-tomas')
    expect(app).toBeDefined()
    if (!app) return
    expect(isHiredApplication(db, app)).toBe(false)
    expect(canSeeCandidatePay(viewer('manager', 'p-tomas'), db, app)).toBe(true)
  })
})

describe('independent scorecards per interview', () => {
  it('an earlier round’s card does not unlock a later round the viewer has not written up yet', () => {
    const app = appFor('c-ananya-krishnan')
    const hannah = viewer('employee', 'p-hannah')
    const mineSubmitted = db.scorecards.some((s) => s.applicationId === app.id && s.interviewerId === 'p-hannah' && s.submittedAt)
    const later = db.interviews.find((i) => i.applicationId === app.id && i.interviewerIds.includes('p-hannah') && i.status === 'scheduled')
    expect(mineSubmitted).toBe(true)
    expect(later).toBeDefined()
    if (!later) return
    // Before the later round starts, her submitted earlier card lets her read the panel.
    expect(canSeeOthersScorecards(hannah, db, app, { nowISO: new Date(Date.parse(later.startsAt) - 3_600_000).toISOString() })).toBe(true)
    // Once it has started and her card for it is still open, others' cards stay hidden.
    expect(canSeeOthersScorecards(hannah, db, app, { nowISO: new Date(Date.parse(later.startsAt) + 26 * 3_600_000).toISOString() })).toBe(false)
  })
})
