import { describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { canSeeApplication, canSeeCandidate } from '@/domain/access'
import { application, candidate, fixtureDB, FRI } from '@/domain/hiring/testkit'
import type { DB, Job, Viewer } from '@/domain/types'
import {
  candidateOfferOn,
  candidateRows,
  candidateTimeline,
  compareJobs,
  emptySweepCounts,
  filterCandidateRows,
  guessTimezone,
  jobAgeText,
  lastActivityFor,
  moveStage,
  plannedRows,
  quickAddMatches,
  quickAddProblems,
  rejectReasons,
  slaBadge,
  stageRemovalBlock,
  stepToSchedule,
  sweepQueue,
  sweepSummaryText,
  talentPool,
  textIssueError,
  textIssues,
  visibleApplicationIds,
  visibleCandidateIds,
  visibleDuplicates,
  withCustomStage,
  withdrawReasons,
  withRecruiterScreen,
} from './logic'

function viewer(db: DB, role: Viewer['role'], personId: string | null): Viewer {
  return { role, personId, person: db.people.find((p) => p.id === personId) }
}

function job(db: DB, id = 'j-fullstack'): Job {
  return db.jobs.find((j) => j.id === id) as Job
}

describe('visibility', () => {
  it('matches access.canSeeApplication and canSeeCandidate on the sample', () => {
    const db = buildSampleDB()
    for (const v of [viewer(db, 'admin', 'p-founder'), viewer(db, 'manager', 'p-tomas'), viewer(db, 'manager', 'p-elena'), viewer(db, 'employee', 'p-hannah')]) {
      const apps = visibleApplicationIds(v, db)
      for (const a of db.applications) expect(apps.has(a.id), `${v.personId} ${a.id}`).toBe(canSeeApplication(v, db, a))
      const cands = visibleCandidateIds(v, db, apps)
      for (const c of db.candidates.slice(0, 120)) expect(cands.has(c.id), `${v.personId} ${c.id}`).toBe(canSeeCandidate(v, db, c.id))
    }
  })

  it('gives a panel-only manager just the applications they interview for', () => {
    const db = buildSampleDB()
    const tomas = viewer(db, 'manager', 'p-tomas')
    const apps = visibleApplicationIds(tomas, db)
    const staffMl = db.applications.filter((a) => a.jobId === 'j-staff-ml')
    const seen = staffMl.filter((a) => apps.has(a.id))
    expect(seen.length).toBeLessThan(staffMl.length)
    for (const a of seen) expect(db.interviews.some((i) => i.applicationId === a.id && i.interviewerIds.includes('p-tomas'))).toBe(true)
    expect(db.applications.filter((a) => a.jobId === 'j-fullstack').every((a) => apps.has(a.id))).toBe(true)
  })
})

describe('job list', () => {
  it('orders open jobs first, high priority before normal', () => {
    const base = fixtureDB().jobs[0]
    const list: Job[] = [
      { ...base, id: 'a', status: 'filled' },
      { ...base, id: 'b', status: 'open', priority: 'normal' },
      { ...base, id: 'c', status: 'draft' },
      { ...base, id: 'd', status: 'open', priority: 'high' },
      { ...base, id: 'e', status: 'on_hold' },
    ]
    expect([...list].sort(compareJobs).map((j) => j.id)).toEqual(['d', 'b', 'c', 'e', 'a'])
  })

  it('shows plan lines with no live job as planned rows, scoped by department for managers', () => {
    const db = fixtureDB()
    db.plan.push(
      { id: 'ps-pm', quarter: '2027-Q1', title: 'Product manager', departmentId: 'd-product', familyId: 'f-product', levelId: 'lv-l4', targetStart: '2027-01-11', status: 'planned' },
      { id: 'ps-eng', quarter: '2026-Q4', title: 'Platform engineer', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-12-01', status: 'planned' },
      { id: 'ps-live', quarter: '2026-Q4', title: 'Full-stack', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-12-01', status: 'open', jobId: 'j-fullstack' },
      { id: 'ps-cut', quarter: '2026-Q4', title: 'Cut', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-12-01', status: 'cut' },
    )
    expect(plannedRows(db, viewer(db, 'admin', 'p-founder')).map((s) => s.id)).toEqual(['ps-eng', 'ps-pm'])
    expect(plannedRows(db, viewer(db, 'manager', 'p-tomas')).map((s) => s.id)).toEqual(['ps-eng'])
  })
})

describe('job age', () => {
  const fmt = (d: string) => d
  it('says Draft since for drafts (never posted), days open otherwise', () => {
    expect(jobAgeText({ status: 'draft', openedOn: '2026-10-05' }, '2026-10-10', fmt)).toBe('Draft since 2026-10-05')
    expect(jobAgeText({ status: 'draft' }, '2026-10-10', fmt)).toBeNull()
    expect(jobAgeText({ status: 'open', openedOn: '2026-09-15' }, '2026-10-09', fmt)).toBe('24 days open')
    expect(jobAgeText({ status: 'open', openedOn: '2026-10-08' }, '2026-10-09', fmt)).toBe('1 day open')
  })
  it('says Requested for a job request waiting on Admin', () => {
    const requisition = { requestedById: 'p-tomas', requestedOn: '2026-10-10', quarter: '2027-Q1', reason: 'x', status: 'pending' as const }
    expect(jobAgeText({ status: 'draft', requisition }, '2026-10-12', fmt)).toBe('Requested 2026-10-10')
  })
})

describe('schedule after a move', () => {
  it('offers the first interview step of the new stage that is not booked yet', () => {
    const db = fixtureDB()
    const j = job(db)
    j.interviewPlan = [
      { id: 'st-intro', stageId: 'intro', name: 'Intro call', durationMin: 30, interviewerIds: ['p-tomas'], attributes: [] },
      { id: 'st-tech', stageId: 'technical', name: 'Technical deep dive', durationMin: 60, interviewerIds: ['p-tomas'], attributes: [] },
    ]
    db.candidates.push(candidate('c-zed', 'Zed', 'Ray'))
    const app = application('a-zed', 'c-zed', j.id, { stageId: 'technical', stageEnteredOn: FRI })
    db.applications.push(app)
    expect(stepToSchedule(db, app)?.id).toBe('st-tech')
    db.interviews.push({ id: 'i-1', applicationId: 'a-zed', stepId: 'st-tech', stageId: 'technical', name: 'Technical deep dive', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 60, interviewerIds: ['p-tomas'], format: 'video', status: 'scheduled', attributes: [] })
    expect(stepToSchedule(db, app)).toBeUndefined()
    // A cancelled one does not count; a stage with no step offers nothing.
    db.interviews[db.interviews.length - 1].status = 'cancelled'
    expect(stepToSchedule(db, app)?.id).toBe('st-tech')
    expect(stepToSchedule(db, { ...app, stageId: 'onsite' })).toBeUndefined()
    expect(stepToSchedule(db, { ...app, status: 'rejected' })).toBeUndefined()
  })
})

describe('quick add duplicates', () => {
  it('never names or attaches a match the viewer cannot see', () => {
    const db = buildSampleDB()
    const daniel = db.candidates.find((c) => c.email === 'daniel.reyes@example.com')
    expect(daniel).toBeDefined()
    const id = daniel?.id as string
    expect(visibleDuplicates(db, viewer(db, 'admin', 'p-founder'), [id])).toEqual({ visible: [id], hidden: false })
    // Daniel is only on another team's job: a hiring manager learns nothing about him.
    const caleb = viewer(db, 'manager', 'p-caleb')
    expect(canSeeCandidate(caleb, db, id)).toBe(false)
    expect(visibleDuplicates(db, caleb, [id])).toEqual({ visible: [], hidden: true })
    expect(visibleDuplicates(db, caleb, [])).toEqual({ visible: [], hidden: false })
  })
})

describe('SLA badge', () => {
  it('pairs a word and an icon with the tone, and never uses red (red is for statutory deadlines)', () => {
    expect(slaBadge({ state: 'over', days: 7, sla: 5, dueOn: '2026-10-01' })).toMatchObject({ tone: 'warn', icon: 'alert', text: '7 days in stage, past SLA' })
    expect(slaBadge({ state: 'due_soon', days: 4, sla: 5, dueOn: '2026-10-12' })).toMatchObject({ tone: 'warn', icon: 'clock', text: '4 days in stage, 1 day left' })
    expect(slaBadge({ state: 'due_soon', days: 5, sla: 5, dueOn: '2026-10-12' })).toMatchObject({ text: '5 days in stage, last day' })
    expect(slaBadge({ state: 'ok', days: 1, sla: 5, dueOn: '2026-10-15' })).toMatchObject({ tone: 'good', text: '1 day in stage, on track' })
    expect(slaBadge({ state: 'ok', days: 2 })).toMatchObject({ tone: 'neutral', text: '2 days in stage', word: '' })
    expect(slaBadge({ state: 'over', days: 3, dueOn: '2026-10-08' })).toMatchObject({ tone: 'warn', text: '3 days in stage, offer expired' })
  })

  it('spells out the limit for screen readers', () => {
    expect(slaBadge({ state: 'over', days: 7, sla: 5, dueOn: '2026-10-01' }).detail).toBe('Counted in business days. The SLA for this stage is 5 business days.')
  })
})

describe('sweep', () => {
  it('queues candidates who need attention, past SLA first', () => {
    const db = fixtureDB()
    // a-chen has sat in New since Sep 21 and a-ben in Intro call since Oct 1: both past SLA, Chen longer.
    db.applications.push(application('a-dee', 'c-dee', 'j-fullstack', { stageId: 'new', stageEnteredOn: FRI, appliedOn: FRI, history: [{ stageId: 'new', at: FRI }] }))
    db.candidates.push(candidate('c-dee', 'Dee', 'Fox'))
    const q = sweepQueue(db, job(db), '2026-10-12')
    expect(q.slice(0, 2)).toEqual(['a-chen', 'a-ben'])
    expect(q).not.toContain('a-dee')
    expect(sweepQueue(db, job(db), '2026-10-12', 'all')).toContain('a-dee')
  })

  it('leaves accepted offers out of the sweep', () => {
    const db = fixtureDB()
    const app = db.applications.find((a) => a.id === 'a-alex')
    if (app) app.conditionalOfferOn = '2026-10-08'
    expect(sweepQueue(db, job(db), '2026-10-20', 'all')).not.toContain('a-alex')
  })

  it('writes the summary line', () => {
    expect(sweepSummaryText({ ...emptySweepCounts(), advanced: 2, closedNotified: 4, snoozed: 3 })).toBe('9 touched: 2 advanced, 4 closed with notes, 3 snoozed')
    expect(sweepSummaryText({ ...emptySweepCounts(), advanced: 1, skipped: 2 })).toBe('1 touched: 1 advanced. 2 skipped.')
    expect(sweepSummaryText({ ...emptySweepCounts(), skipped: 1 })).toBe('Nothing changed. 1 skipped.')
    expect(sweepSummaryText(emptySweepCounts())).toBe('Nothing changed.')
  })
})

describe('talent pool', () => {
  it('resurfaces keep-warm candidates from the same role family', () => {
    const db = fixtureDB()
    const old: Job = { ...job(db), id: 'j-old', status: 'filled' }
    const other: Job = { ...job(db), id: 'j-other', familyId: 'f-gtm', status: 'filled' }
    db.jobs.push(old, other)
    db.candidates.push(
      candidate('c-warm', 'Wendy', 'Arm', { tags: ['keep warm'] }),
      candidate('c-silver', 'Sil', 'Ver', { tags: ['Silver medalist'] }),
      candidate('c-gtm', 'Gina', 'Tim', { tags: ['keep warm'] }),
      candidate('c-plain', 'Pat', 'Lane'),
    )
    db.applications.push(
      application('a-warm', 'c-warm', 'j-old', { status: 'rejected', closedOn: '2026-05-01' }),
      application('a-silver', 'c-silver', 'j-old', { status: 'rejected', closedOn: '2026-05-01' }),
      application('a-gtm', 'c-gtm', 'j-other', { status: 'rejected', closedOn: '2026-05-01' }),
      application('a-plain', 'c-plain', 'j-old', { status: 'rejected', closedOn: '2026-05-01' }),
    )
    const pool = talentPool(db, job(db))
    expect(pool.map((p) => p.candidate.id)).toEqual(['c-warm', 'c-silver'])
    expect(pool[0].fromJob?.id).toBe('j-old')
  })

  it("shows a hiring manager only candidates they can already see; admins see the whole pool", () => {
    const db = fixtureDB()
    const base = job(db)
    // Same family, but Priya's job: Tomas is not its hiring manager and never interviewed for it.
    const priyas: Job = { ...base, id: 'j-priya', hiringManagerId: 'p-priya', panelIds: ['p-priya'], interviewPlan: base.interviewPlan.map((s) => ({ ...s, interviewerIds: ['p-priya'] })), status: 'filled' }
    const mine: Job = { ...base, id: 'j-mine', status: 'filled' }
    db.jobs.push(priyas, mine)
    db.candidates.push(
      candidate('c-hidden', 'Hidden', 'Person', { tags: ['keep warm'] }),
      candidate('c-mine', 'Mine', 'Too', { tags: ['silver medalist'] }),
      candidate('c-both', 'Both', 'Jobs', { tags: ['keep warm'] }),
    )
    db.applications.push(
      application('a-hidden', 'c-hidden', 'j-priya', { status: 'rejected', closedOn: '2026-05-01' }),
      application('a-mine', 'c-mine', 'j-mine', { status: 'rejected', closedOn: '2026-05-01' }),
      application('a-both-p', 'c-both', 'j-priya', { status: 'rejected', closedOn: '2026-06-01', appliedOn: '2026-05-01' }),
      application('a-both-m', 'c-both', 'j-mine', { status: 'rejected', closedOn: '2026-04-01', appliedOn: '2026-03-01' }),
    )
    const admin = talentPool(db, base, viewer(db, 'admin', 'p-founder'))
    expect(admin.map((p) => p.candidate.id).sort()).toEqual(['c-both', 'c-hidden', 'c-mine'])
    expect(admin.find((p) => p.candidate.id === 'c-both')?.fromJob?.id).toBe('j-priya')
    const tomas = viewer(db, 'manager', 'p-tomas')
    const forTomas = talentPool(db, base, tomas)
    expect(forTomas.map((p) => p.candidate.id).sort()).toEqual(['c-both', 'c-mine'])
    for (const p of forTomas) expect(canSeeCandidate(tomas, db, p.candidate.id)).toBe(true)
    // 'from' names the job Tomas can see, never Priya's.
    expect(forTomas.find((p) => p.candidate.id === 'c-both')?.fromJob?.id).toBe('j-mine')
  })
})

describe('candidates list', () => {
  it('filters by search, source, flags and stage, and hides archived by default', () => {
    const db = fixtureDB()
    db.candidates.push(candidate('c-arch', 'Arch', 'Ived', { archived: true }))
    const v = viewer(db, 'admin', 'p-founder')
    const apps = visibleApplicationIds(v, db)
    const rows = candidateRows(db, visibleCandidateIds(v, db, apps), apps)
    const f = { q: '', stage: '' as const, jobId: '', source: '' as const, flags: [] }
    expect(filterCandidateRows(db, rows, f).map((r) => r.candidate.id).sort()).toEqual(['c-alex', 'c-ben', 'c-chen'])
    expect(filterCandidateRows(db, rows, { ...f, flags: ['archived'] }).map((r) => r.candidate.id)).toEqual(['c-arch'])
    expect(filterCandidateRows(db, rows, { ...f, flags: ['referral'] }).map((r) => r.candidate.id)).toEqual(['c-ben'])
    expect(filterCandidateRows(db, rows, { ...f, source: 'outbound' }).map((r) => r.candidate.id)).toEqual(['c-chen'])
    expect(filterCandidateRows(db, rows, { ...f, stage: 'onsite' }).map((r) => r.candidate.id)).toEqual(['c-alex'])
    expect(filterCandidateRows(db, rows, { ...f, q: 'full-stack ortiz' }).map((r) => r.candidate.id)).toEqual(['c-ben'])
    const alex = rows.find((r) => r.candidate.id === 'c-alex')
    expect(alex?.status).toBe('active')
    expect(rows.find((r) => r.candidate.id === 'c-arch')?.status).toBe('pool')
  })
})

describe('timeline', () => {
  it('merges logged activity with stage history and outcomes, newest first', () => {
    const db = fixtureDB()
    const app = db.applications.find((a) => a.id === 'a-ben')
    if (app) {
      app.status = 'rejected'
      app.outcomeReason = 'skills_gap'
      app.closedOn = '2026-10-08'
    }
    db.activity.push({ id: 'act-1', at: '2026-10-05T17:00:00.000Z', entityType: 'candidate', entityId: 'c-ben', kind: 'note', text: 'Strong on APIs' })
    db.activity.push({ id: 'act-2', at: '2026-10-01T17:00:00.000Z', entityType: 'application', entityId: 'a-ben', relatedId: 'c-ben', kind: 'stage_moved', text: 'Moved Ben Ortiz to Intro call' })
    const t = candidateTimeline(db, 'c-ben', ['a-ben'])
    expect(t.map((i) => i.kind)).toEqual(['rejected', 'note', 'stage_moved', 'applied'])
    expect(t[0].text).toBe('Rejected for Senior full-stack engineer (skills gap)')
    expect(t[2].text).toBe('Moved Ben Ortiz to Intro call')
  })

  it('matches logged events to history by local date (activity is stored in UTC)', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const db = fixtureDB()
      // 10 PM Pacific on Sep 21 is already Sep 22 in UTC.
      db.activity.push({ id: 'act-add', at: '2026-09-22T05:00:00.000Z', entityType: 'application', entityId: 'a-chen', relatedId: 'c-chen', kind: 'application_added', text: 'Added Chen Wu to Senior full-stack engineer in New' })
      const t = candidateTimeline(db, 'c-chen', ['a-chen'])
      expect(t.map((i) => i.kind)).toEqual(['application_added'])
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('last activity compares a Pacific evening note with the stage move by local date', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const db = fixtureDB()
      const app = db.applications.find((a) => a.id === 'a-ben')
      if (!app) throw new Error('fixture')
      app.history = [{ stageId: 'intro', at: '2026-10-09' }]
      // 8:30 PM Pacific on Oct 8 is already Oct 9 in UTC: the Oct 9 stage move is still newer.
      db.activity.push({ id: 'act-eve', at: '2026-10-09T03:30:00.000Z', entityType: 'application', entityId: 'a-ben', relatedId: 'c-ben', kind: 'note', text: 'Evening note' })
      expect(lastActivityFor(db, app)?.text).toMatch(/^Moved to /)
      // A note on the morning of Oct 9 Pacific wins over the move that day.
      db.activity.push({ id: 'act-am', at: '2026-10-09T16:00:00.000Z', entityType: 'application', entityId: 'a-ben', relatedId: 'c-ben', kind: 'note', text: 'Morning note' })
      expect(lastActivityFor(db, app)?.text).toBe('Morning note')
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('leaves out applications the viewer cannot see', () => {
    const db = fixtureDB()
    expect(candidateTimeline(db, 'c-ben', [])).toEqual([])
  })
})

describe('reasons', () => {
  it('splits reject and withdraw reasons', () => {
    const db = fixtureDB()
    expect(rejectReasons(db)).not.toContain('withdrew')
    expect(rejectReasons(db)).not.toContain('position_filled')
    expect(rejectReasons(db)).toContain('skills_gap')
    expect(withdrawReasons(db)[0]).toBe('withdrew')
    expect(withdrawReasons(db)).not.toContain('skills_gap')
  })
})

describe('stage editing', () => {
  it('adds a recruiter screen after New once, and custom stages before Offer', () => {
    const db = fixtureDB()
    const stages = job(db).stages
    const withRs = withRecruiterScreen(stages)
    expect(withRs.map((s) => s.id).slice(0, 3)).toEqual(['new', 'recruiter_screen', 'intro'])
    expect(withRecruiterScreen(withRs)).toBe(withRs)
    const custom = withCustomStage(stages, 'Reference check')
    const offerAt = custom.findIndex((s) => s.kind === 'offer')
    expect(custom[offerAt - 1]).toMatchObject({ id: 'custom-1', kind: 'custom', name: 'Reference check' })
  })

  it('blocks removing fixed stages and stages with candidates', () => {
    const db = fixtureDB()
    const j = job(db)
    expect(stageRemovalBlock(db, j, j.stages, 'new')).toMatch(/every pipeline/)
    expect(stageRemovalBlock(db, j, j.stages, 'onsite')).toMatch(/1 candidate is in Onsite/)
    expect(stageRemovalBlock(db, j, j.stages, 'technical')).toBeNull()
  })

  it('keeps New first and Offer last when reordering', () => {
    const db = fixtureDB()
    const s = job(db).stages
    expect(moveStage(s, 'intro', -1)).toBe(s)
    expect(moveStage(s, 'onsite', 1)).toBe(s)
    expect(moveStage(s, 'technical', -1).map((x) => x.id).slice(0, 3)).toEqual(['new', 'technical', 'intro'])
  })
})

describe('quick add helpers', () => {
  const empty = { firstName: '', lastName: '', email: '', phone: '', linkedin: '', github: '', location: '', currentTitle: '', currentCompany: '' }
  it('needs a name and one way to reach the person', () => {
    expect(quickAddProblems(empty)).toHaveLength(2)
    expect(quickAddProblems({ ...empty, firstName: 'Ana', linkedin: 'https://www.linkedin.com/in/ana' })).toEqual([])
    expect(quickAddProblems({ ...empty, firstName: 'Ana', email: 'ana@' })).toEqual(['The email does not look right.'])
  })

  it('guesses a US time zone from the location', () => {
    expect(guessTimezone('Austin, TX')).toBe('America/Chicago')
    expect(guessTimezone('Brooklyn, New York')).toBe('America/New_York')
    expect(guessTimezone('San Francisco Bay Area')).toBe('America/Los_Angeles')
    expect(guessTimezone('Berlin')).toBeUndefined()
  })
})

describe('quick add matches', () => {
  it('treats a phone-only match as soft and email or profile matches as strong', () => {
    const db = buildSampleDB()
    const admin = viewer(db, 'admin', 'p-founder')
    const grace = db.candidates.find((c) => c.id === 'c-grace-okafor')
    expect(grace?.phone).toBeTruthy()
    const none = { email: '', linkedin: '', github: '', phone: '' }
    // A different person on a shared line: never a strong match.
    const shared = quickAddMatches(db, admin, { ...none, email: 'zara.quinlan@example.com', phone: grace?.phone ?? '' })
    expect(shared.strong).toEqual([])
    expect(shared.phoneOnly).toEqual(['c-grace-okafor'])
    // Same email: strong, and not repeated as phone-only.
    const same = quickAddMatches(db, admin, { ...none, email: grace?.email ?? '', phone: grace?.phone ?? '' })
    expect(same.strong).toEqual(['c-grace-okafor'])
    expect(same.phoneOnly).toEqual([])
  })
})

describe('free-text guardrails', () => {
  it('blocks criminal history before a conditional offer and only warns after one', () => {
    const before = textIssues('Mentioned a felony conviction from 2019 during the call')
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ law: 'criminal', blocks: true })
    expect(textIssueError(before)).toMatch(/conditional offer/)
    const after = textIssues('Background check flagged a DUI', { conditionalOfferOn: '2026-10-01' })
    expect(after[0]).toMatchObject({ law: 'criminal', blocks: false })
    expect(textIssueError(after)).toBeUndefined()
  })

  it('warns on pay history, or blocks it when asked, and reports both laws together', () => {
    expect(textIssues('She makes $180k now at Intuit')).toEqual([expect.objectContaining({ law: 'pay', blocks: false })])
    const both = textIssues('She makes $180k now at Intuit. Had a DUI conviction in 2020 but great engineer.', { blockPay: true })
    expect(both.map((i) => [i.law, i.blocks])).toEqual([
      ['pay', true],
      ['criminal', true],
    ])
    expect(textIssues('Great track record shipping agents to controllers')).toEqual([])
    expect(textIssues('We never ask about arrests')).toEqual([])
  })

  it('reads the conditional offer from any application of the candidate', () => {
    const db = buildSampleDB()
    const withOffer = db.applications.find((a) => a.conditionalOfferOn)
    expect(withOffer).toBeDefined()
    expect(candidateOfferOn(db, withOffer?.candidateId as string)).toBe(withOffer?.conditionalOfferOn)
    expect(candidateOfferOn(db, 'c-mateo-molina')).toBeNull()
  })
})
