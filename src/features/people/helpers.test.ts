// People feature helpers, checked against the Ledgerlark sample at its anchor date (Fri 2026-10-09).
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { resolveViewer } from '@/app/useViewer'
import type { Checklist, Contractor, DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { produce } from 'immer'
import { openJobFromPlan } from '@/domain/lifecycle'
import {
  ab5Result,
  backfillJobSummary,
  backfillPlanFor,
  backfillTargetStart,
  buildOrgTree,
  canActOnTask,
  convertedPerson,
  de542Status,
  directoryRows,
  dueExplanation,
  dueLine,
  endReminder,
  equityAtExit,
  filterDirectory,
  form1099Flag,
  groupByPhase,
  inFlightSummary,
  isMyTask,
  nextAnniversary,
  nextFriday,
  nextMonday,
  phaseOf,
  prepareBackfillSlot,
  releaseTerms,
  releaseText,
  splitName,
  startsInText,
  titleFromScope,
  visibleOrgNodes,
  visibleTasks,
  wallSeats,
} from './helpers'

const TODAY = '2026-10-09'
let db: DB

beforeAll(() => {
  setClockOverride(TODAY)
  db = buildSampleDB()
})

afterAll(() => setClockOverride(null))

const checklistOf = (personId: string, kind: Checklist['kind']) => {
  const c = db.checklists.find((x) => x.personId === personId && x.kind === kind)
  if (!c) throw new Error(`no ${kind} checklist for ${personId}`)
  return c
}

describe('dates', () => {
  it('finds the next work anniversary', () => {
    expect(nextAnniversary('2025-05-12', '2026-10-09')).toEqual({ date: '2027-05-12', years: 2 })
    expect(nextAnniversary('2025-10-09', '2026-10-09')).toEqual({ date: '2026-10-09', years: 1 })
    expect(nextAnniversary('2026-10-19', '2026-10-09')).toEqual({ date: '2027-10-19', years: 1 })
  })
  it('picks the next Monday and this Friday', () => {
    expect(nextMonday('2026-10-09')).toBe('2026-10-12')
    expect(nextMonday('2026-10-12')).toBe('2026-10-19')
    expect(nextFriday('2026-10-09')).toBe('2026-10-09')
    expect(nextFriday('2026-10-12', 2)).toBe('2026-10-30')
  })
  it('says when someone starts', () => {
    expect(startsInText('2026-10-19', TODAY)).toBe('starts in 10 days')
    expect(startsInText('2026-10-10', TODAY)).toBe('starts tomorrow')
    expect(startsInText(TODAY, TODAY)).toBe('starts today')
  })
})

describe('directory', () => {
  it('lists employees in hire order with statuses, then contractors and advisors', () => {
    const rows = directoryRows(db, TODAY)
    const lucas = rows.find((r) => r.id === 'p-lucas')
    const omar = rows.find((r) => r.id === 'p-omar')
    expect(rows[0].number).toBe(1)
    expect(lucas?.status).toBe('starting')
    expect(omar?.status).toBe('alumni')
    expect(rows.find((r) => r.id === 'k-fieldnote')?.status).toBe('alumni')
    expect(rows.find((r) => r.id === 'k-adv-osei')?.kind).toBe('advisor')
  })
  it('filters by status, kind and search', () => {
    const rows = directoryRows(db, TODAY)
    const active = filterDirectory(rows, { statuses: ['active'], kinds: ['employee'], departmentId: '', location: '', query: '' })
    expect(active).toHaveLength(14)
    const alumni = filterDirectory(rows, { statuses: ['alumni'], kinds: ['employee'], departmentId: '', location: '', query: '' })
    expect(alumni.map((r) => r.id)).toEqual(['p-omar'])
    const search = filterDirectory(rows, { statuses: [], kinds: [], departmentId: '', location: '', query: '#16' })
    expect(search.map((r) => r.id)).toEqual(['p-lucas'])
  })
})

describe('org chart', () => {
  it('builds the tree from managerId with incoming people and planned roles', () => {
    const roots = buildOrgTree(db, TODAY, { planned: true, contractors: false })
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe('p-founder')
    const tomas = roots[0].children.find((n) => n.id === 'p-tomas')
    expect(tomas?.children.map((n) => n.id)).toContain('p-lucas')
    const planned = roots[0].children.flatMap((n) => [n, ...n.children]).filter((n) => n.kind === 'planned')
    expect(planned.length).toBeGreaterThan(0)
    expect(JSON.stringify(roots)).not.toContain('"id":"p-omar"')
  })
  it('lists only expanded branches', () => {
    const roots = buildOrgTree(db, TODAY, { planned: false, contractors: false })
    expect(visibleOrgNodes(roots, new Set())).toHaveLength(1)
    const open = visibleOrgNodes(roots, new Set(['p-founder']))
    expect(open[0].level).toBe(1)
    expect(open.slice(1).every((x) => x.level === 2 && x.parentId === 'p-founder')).toBe(true)
  })
  it('can include contractors under their manager', () => {
    const roots = buildOrgTree(db, TODAY, { planned: false, contractors: true })
    const elena = roots[0].children.find((n) => n.id === 'p-elena')
    expect(elena?.children.some((n) => n.id === 'k-marisol')).toBe(true)
  })
})

describe('first twenty wall', () => {
  it('keeps hire order, alumni seats, planned roles and at least 20 seats', () => {
    const seats = wallSeats(db, TODAY)
    expect(seats.length).toBeGreaterThanOrEqual(20)
    expect(seats[0].person?.hireNumber).toBe(1)
    expect(seats.find((s) => s.person?.id === 'p-omar')?.kind).toBe('alumni')
    expect(seats.find((s) => s.person?.id === 'p-lucas')?.kind).toBe('incoming')
    expect(seats.some((s) => s.kind === 'planned')).toBe(true)
    seats.forEach((s, i) => expect(s.n).toBe(i + 1))
  })
})

describe('checklist phases and due dates', () => {
  it('groups onboarding tasks into phases', () => {
    expect(phaseOf('onboarding', '2026-10-14', '2026-10-19').label).toBe('Before day 1')
    expect(phaseOf('onboarding', '2026-10-19', '2026-10-19').label).toBe('Day 1')
    expect(phaseOf('onboarding', '2026-10-22', '2026-10-19').label).toBe('Week 1')
    expect(phaseOf('onboarding', '2026-11-08', '2026-10-19').label).toBe('Month 1')
    expect(phaseOf('onboarding', '2027-04-19', '2026-10-19').label).toBe('Later')
    expect(phaseOf('offboarding', '2026-08-31', '2026-08-28').label).toBe('Within 72 hours')
  })
  it('explains where a due date comes from, weekend-aware', () => {
    const cl = checklistOf('p-lucas', 'onboarding')
    const i9 = cl.tasks.find((t) => t.templateTaskId === 'on-i9-section2')
    if (!i9) throw new Error('no I-9 task')
    expect(i9.dueOn).toBe('2026-10-22')
    expect(dueExplanation(db, cl, i9)).toBe('3 business days after Mon Oct 19')
    const de34 = cl.tasks.find((t) => t.templateTaskId === 'on-de34')
    if (!de34) throw new Error('no DE 34 task')
    // Oct 19 + 20 days = Sun Nov 8: statutory, so it keeps the date and gets a file-by day.
    const line = dueLine(db, cl, de34)
    expect(line.label).toBe('Due Sun Nov 8, file by Fri Nov 6')
    expect(line.explain).toBe('20 days after Mon Oct 19')
    const day1 = cl.tasks.find((t) => t.templateTaskId === 'on-i9-section1')
    if (!day1) throw new Error('no I-9 section 1 task')
    expect(dueExplanation(db, cl, day1)).toBe('on the start date, Mon Oct 19')
  })
  it('sorts groups in phase order', () => {
    const cl = checklistOf('p-lucas', 'onboarding')
    const groups = groupByPhase(cl, cl.tasks)
    expect(groups[0].label).toBe('Before day 1')
    expect(groups.map((g) => g.order)).toEqual([...groups.map((g) => g.order)].sort((a, b) => a - b))
  })
})

describe('checklists in flight', () => {
  it('summarizes an incoming hire, an overdue statutory item and an exit', () => {
    const lucasCl = checklistOf('p-lucas', 'onboarding')
    const lucas = inFlightSummary(lucasCl, lucasCl.tasks, '2026-10-19', TODAY)
    expect(lucas.incoming).toBe(true)
    expect(lucas.text).toMatch(/^pre-start \d+ of \d+, starts in 10 days/)
    const aishaCl = checklistOf('p-aisha', 'onboarding')
    const aisha = inFlightSummary(aishaCl, aishaCl.tasks, undefined, TODAY)
    expect(aisha.text).toContain('DE 34 overdue')
    expect(aisha.statutoryOverdue).toBe(true)
    const omarCl = checklistOf('p-omar', 'offboarding')
    const omar = inFlightSummary(omarCl, omarCl.tasks, undefined, TODAY)
    expect(omar.text).toContain('laptop return')
  })
})

describe('checklist access', () => {
  it('shows a manager only the manager tasks on a report leave checklist', () => {
    const leave = checklistOf('p-tomas', 'leave')
    const maya = resolveViewer(db, 'manager', 'p-founder')
    const tasks = visibleTasks(maya, db, leave)
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t) => t.ownerRole === 'manager')).toBe(true)
    const admin = resolveViewer(db, 'admin', null)
    expect(visibleTasks(admin, db, leave)).toHaveLength(leave.tasks.length)
  })
  it('lets managers act on manager tasks for their reports and employees on their own tasks', () => {
    const cl = checklistOf('p-lucas', 'onboarding')
    const tomas = resolveViewer(db, 'manager', 'p-tomas')
    const managerTask = cl.tasks.find((t) => t.ownerRole === 'manager')
    const adminTask = cl.tasks.find((t) => t.ownerRole === 'admin')
    if (!managerTask || !adminTask) throw new Error('missing tasks')
    expect(canActOnTask(tomas, db, cl, managerTask)).toBe(true)
    expect(canActOnTask(tomas, db, cl, adminTask)).toBe(false)
    const lucas = resolveViewer(db, 'employee', 'p-lucas')
    const own = cl.tasks.find((t) => t.ownerRole === 'employee')
    if (!own) throw new Error('no employee task')
    expect(canActOnTask(lucas, db, cl, own)).toBe(true)
    expect(visibleTasks(resolveViewer(db, 'employee', 'p-aisha'), db, cl)).toHaveLength(0)
  })
  it('counts as Mine only the tasks the viewer owns, not everything Admin may act on', () => {
    const cl = checklistOf('p-lucas', 'onboarding')
    const admin = resolveViewer(db, 'admin', null)
    const mine = cl.tasks.filter((t) => isMyTask(admin, db, cl, t))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.length).toBeLessThan(cl.tasks.length)
    expect(mine.every((t) => (t.assigneeId ? t.assigneeId === admin.personId : t.ownerRole === 'admin'))).toBe(true)
    expect(cl.tasks.every((t) => canActOnTask(admin, db, cl, t))).toBe(true)
    const managerTask = cl.tasks.find((t) => t.ownerRole === 'manager')
    const lucas = db.people.find((p) => p.id === 'p-lucas')
    const owner = managerTask?.assigneeId ?? lucas?.managerId
    if (!managerTask || !owner) throw new Error('missing manager task')
    expect(isMyTask(resolveViewer(db, 'manager', owner), db, cl, managerTask)).toBe(true)
    expect(isMyTask(admin, db, cl, managerTask)).toBe(admin.personId === owner)
    const own = cl.tasks.find((t) => t.ownerRole === 'employee' && (t.assigneeId ?? 'p-lucas') === 'p-lucas')
    if (!own) throw new Error('no employee task')
    expect(isMyTask(resolveViewer(db, 'employee', 'p-lucas'), db, cl, own)).toBe(true)
    expect(isMyTask(admin, db, cl, own)).toBe(false)
  })
})

describe('AB5 check', () => {
  it('needs all three prongs without an exemption', () => {
    expect(ab5Result({ exemption: 'none', a: true, b: true, c: true }).outcome).toBe('likely_ok')
    const marisol = ab5Result({ exemption: 'none', a: false, b: false, c: true })
    expect(marisol.outcome).toBe('likely_employee')
    expect(marisol.askCounsel).toBe(true)
    expect(marisol.reasons.join(' ')).toContain('A fails')
    expect(ab5Result({ exemption: 'none', a: true, b: true, c: false }).outcome).toBe('likely_employee')
  })
  it('reads review when an exemption is claimed but a prong fails', () => {
    const r = ab5Result({ exemption: 'b2b', a: true, b: true, c: false })
    expect(r.outcome).toBe('review')
    expect(r.askCounsel).toBe(true)
    expect(ab5Result({ exemption: 'professional_services', a: true, b: true, c: true }).outcome).toBe('likely_ok')
  })
  it('waits for every answer', () => {
    expect(ab5Result({ exemption: 'none', a: true, b: null, c: true }).outcome).toBe('incomplete')
  })
})

describe('contractor paperwork', () => {
  const k = (id: string) => db.contractors.find((c) => c.id === id) as Contractor
  it('needs DE 542 only for individuals', () => {
    expect(de542Status(db, k('k-northline'), TODAY).state).toBe('not_needed')
    expect(de542Status(db, k('k-marisol'), TODAY).state).toBe('filed')
    const fresh: Contractor = { ...k('k-marisol'), id: 'k-new', de542FiledOn: undefined, startOn: '2026-10-01' }
    const s = de542Status(db, fresh, TODAY)
    expect(s.state).toBe('due')
    if (s.state === 'due') expect(s.dueOn).toBe('2026-10-21')
  })
  it('flags 1099-NEC at the threshold and moves a weekend Jan 31', () => {
    const f = form1099Flag(db, k('k-marisol'), TODAY)
    expect(f.needed).toBe(true)
    expect(f.threshold).toBe(2000)
    expect(f.dueOn).toBe('2027-02-01')
    expect(form1099Flag(db, k('k-adv-osei'), TODAY).needed).toBe(false)
  })
  it('reminds about contract end dates', () => {
    expect(endReminder({ startOn: '2026-01-01', endOn: '2026-10-20' }, TODAY).kind).toBe('soon')
    expect(endReminder({ startOn: '2025-11-01', endOn: '2026-02-28' }, TODAY).kind).toBe('ended')
    expect(endReminder({ startOn: '2026-01-01', endOn: null }, TODAY).kind).toBe('none')
  })
  it('splits names for the convert prefill', () => {
    expect(splitName('Marisol Vega')).toEqual({ first: 'Marisol', last: 'Vega' })
    expect(splitName('Dr. Daniel Osei')).toEqual({ first: 'Daniel', last: 'Osei' })
  })
  it('guesses a job title from the contract scope for the convert prefill', () => {
    expect(titleFromScope(k('k-marisol').scope)).toBe('Close-agent output reviewer')
    expect(titleFromScope('Fractional CFO: monthly close review, board reporting.')).toBe('Fractional CFO')
    expect(titleFromScope('Writes release notes and API docs.')).toBe('Release note writer')
    expect(titleFromScope('Brand identity and marketing website project.')).toBe('Brand identity')
    expect(titleFromScope('  ')).toBe('')
  })
  it('links a converted contractor to the employee only while that record exists', () => {
    const c = k('k-marisol')
    expect(convertedPerson(db, c)).toBeUndefined()
    expect(convertedPerson(db, { convertedToPersonId: 'p-lucas' })?.id).toBe('p-lucas')
    expect(convertedPerson(db, { convertedToPersonId: 'p-gone' })).toBeUndefined()
  })
})

describe('equity at exit', () => {
  it('keeps vested options with a 90-day window and returns the rest', () => {
    // Kofi: 52,000 ISOs from Oct 6, 2025 with a 1-year cliff; the cliff vested 13,000.
    const e = equityAtExit(db, 'p-kofi', '2026-10-23')
    expect(e.vested).toBe(13_000)
    expect(e.returned).toBe(39_000)
    expect(e.deadline).toBe('2027-01-21')
  })
  it('returns everything before the cliff and promised grants', () => {
    const lucas = equityAtExit(db, 'p-lucas', '2026-12-31')
    expect(lucas.vested).toBe(0)
    expect(lucas.deadline).toBeUndefined()
    expect(lucas.returned).toBeGreaterThan(0)
  })
})

describe('severance release', () => {
  it('uses the California minimum below the ADEA and 21/7 (45/7 for groups) for everyone once it applies', () => {
    expect(releaseTerms(false, false)).toMatchObject({ considerDays: 5, considerUnit: 'business days', revokeDays: 0 })
    expect(releaseTerms(true, false)).toMatchObject({ considerDays: 21, considerUnit: 'days', revokeDays: 7 })
    expect(releaseTerms(true, true)).toMatchObject({ considerDays: 45, revokeDays: 7 })
  })
  it('drafts the required statements without amounts or ages', () => {
    const small = releaseText({ company: 'Ledgerlark, Inc.', name: 'Elena Vasquez', lastDay: '2026-10-30', terms: releaseTerms(false, false) })
    expect(small).toContain('You have 5 business days from the day you receive this agreement')
    expect(small).toContain('right to consult an attorney')
    expect(small).toContain('Nothing in this agreement prevents you from discussing or disclosing information about unlawful acts in the workplace')
    expect(small).toContain('October 30, 2026')
    expect(small).not.toContain('revoke')
    expect(small).not.toMatch(/\$\d/)
    const big = releaseText({ company: 'Ledgerlark, Inc.', name: 'Elena Vasquez', lastDay: '2026-10-30', terms: releaseTerms(true, true) })
    expect(big).toContain('You have 45 days')
    expect(big).toContain('7 days to revoke')
    expect(big).toContain('Age Discrimination in Employment Act')
    expect(big).not.toContain('—')
  })
})

describe('backfill plan line', () => {
  it('adds a fresh backfill line instead of reopening the line the leaver still holds', () => {
    // Ravi filled ps-q3-staff-swe (Q3, Aug 3). His last day is Fri Oct 30.
    const plan = backfillPlanFor(db, 'p-ravi', '2026-10-30', TODAY)
    expect(plan.kind).toBe('add')
    if (plan.kind !== 'add') return
    expect(plan.filled?.id).toBe('ps-q3-staff-swe')
    expect(plan.targetStart).toBe(backfillTargetStart('2026-10-30'))
    expect(plan.targetStart).toBe('2026-12-14')
    let slotId = ''
    let jobId = ''
    const next = produce(db, (d) => {
      slotId = prepareBackfillSlot(d, 'p-ravi', '2026-10-30', TODAY)
      jobId = openJobFromPlan(d, slotId, { date: TODAY, hiringManagerId: 'p-tomas' })
    })
    const old = next.plan.find((s) => s.id === 'ps-q3-staff-swe')!
    expect(old.personId).toBe('p-ravi')
    expect(old.status).toBe('filled')
    expect(old.targetStart).toBe('2026-08-03')
    const line = next.plan.find((s) => s.id === slotId)!
    expect(line.id).not.toBe('ps-q3-staff-swe')
    expect(line).toMatchObject({ quarter: '2026-Q4', targetStart: '2026-12-14', isBackfill: true, backfillForPersonId: 'p-ravi', jobId })
    const job = next.jobs.find((j) => j.id === jobId)!
    expect(job).toMatchObject({ targetStart: '2026-12-14', isBackfill: true, backfillForPersonId: 'p-ravi', status: 'draft' })
    // Asking again finds the live job instead of adding another line.
    const again = backfillPlanFor(next, 'p-ravi', '2026-10-30', TODAY)
    expect(again).toMatchObject({ kind: 'live', jobId })
  })
  it('reuses a backfill line planned earlier and moves a stale start out', () => {
    const base = produce(db, (d) => {
      d.plan.push({ id: 'ps-kofi-bf', quarter: '2026-Q3', title: 'Senior ML engineer', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-09-01', status: 'planned', isBackfill: true, backfillForPersonId: 'p-kofi' })
    })
    expect(backfillPlanFor(base, 'p-kofi', '2026-10-30', TODAY)).toMatchObject({ kind: 'reopen', targetStart: '2026-12-14' })
    const next = produce(base, (d) => {
      expect(prepareBackfillSlot(d, 'p-kofi', '2026-10-30', TODAY)).toBe('ps-kofi-bf')
    })
    expect(next.plan.find((s) => s.id === 'ps-kofi-bf')).toMatchObject({ quarter: '2026-Q4', targetStart: '2026-12-14' })
    // A deliberate later start stays.
    const later = produce(base, (d) => {
      d.plan.find((s) => s.id === 'ps-kofi-bf')!.targetStart = '2027-01-11'
    })
    expect(backfillPlanFor(later, 'p-kofi', '2026-10-30', TODAY)).toMatchObject({ kind: 'reopen', targetStart: '2027-01-11' })
  })
})

describe('backfill job summary', () => {
  it('names what the reopened plan line carried over and what is left before posting', () => {
    const slot = db.plan.find((s) => s.personId && s.status === 'filled' && db.bands.some((b) => b.familyId === s.familyId && b.levelId === s.levelId))
    if (!slot) throw new Error('no filled plan line with a band in the sample')
    let jobId = ''
    const next = produce(db, (d) => {
      jobId = openJobFromPlan(d, slot.id, { date: TODAY, hiringManagerId: 'p-founder' })
    })
    const job = next.jobs.find((j) => j.id === jobId)!
    const s = backfillJobSummary(job)
    expect(job.status).toBe('draft')
    expect(s.title).toBe('Backfill job opened as a draft')
    // The band fills the range, so the copy never asks for it.
    expect(s.carried).toMatch(/^Title, level, pay range from the band/)
    expect(s.next).not.toContain('pay range')
    expect(s.next).toMatch(/then post it\.$/)
    if (job.interviewPlan.length) expect(s.next).toMatch(/^pick the interviewers/)
  })
  it('asks for the range, the interviews and the description when nothing filled them', () => {
    const s = backfillJobSummary({ status: 'draft', payMin: null, payMax: null, stages: [], interviewPlan: [], description: ' ' })
    expect(s.carried).toBe('Title and level carried over.')
    expect(s.next).toBe('add the pay range, plan the interviews and write the description, then post it.')
    expect(backfillJobSummary({ status: 'open', payMin: 1, payMax: 2, stages: [], interviewPlan: [], description: 'x' }).title).toBe('The backfill job is already live')
  })
})
