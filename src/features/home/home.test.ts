import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { addContractor, addPerson, makeDB } from '@/domain/compliance/testkit'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { firstHireKit, firstHireStarting, kitProgress, setKitItemDone } from './firstHireKit'
import { growthView, headcountSummary } from './growth'
import { dualTime, thisWeek, weekEvents } from './thisWeek'

const FRI = '2026-10-09'

beforeAll(() => setClockOverride(FRI))
afterAll(() => setClockOverride(null))

const solo = () => blankDB({ companyName: 'Solo', founderFirstName: 'Sam', founderLastName: 'Solo', foundedOn: '2026-09-01' })

describe('first hire kit', () => {
  it('lists employer #1 items with a why and a link, none done in a fresh workspace', () => {
    const items = firstHireKit(solo(), FRI)
    expect(items.map((i) => i.key)).toEqual([
      'edd-registration',
      'workers-comp',
      'iipp',
      'paid-sick-leave',
      'posters-federal',
      'posters-california',
      'posters-san-jose',
      'kit-payroll',
      'kit-templates',
      'kit-409a',
    ])
    expect(items.every((i) => i.why && i.link.url.startsWith('https://'))).toBe(true)
    expect(kitProgress(items)).toEqual({ done: 0, total: 10 })
  })

  it('leaves out the San Jose bulletin outside San Jose', () => {
    const db = blankDB({ companyName: 'Oak', founderFirstName: 'O', founderLastName: 'K', foundedOn: '2026-09-01', hqCity: 'Oakland' })
    expect(firstHireKit(db, FRI).some((i) => i.key === 'posters-san-jose')).toBe(false)
  })

  it('says what is needed before a pre-start first hire begins', () => {
    const db = solo()
    addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-10-26' })
    expect(firstHireStarting(db, FRI)?.id).toBe('p-sam')
    const items = firstHireKit(db, FRI)
    expect(items.find((i) => i.key === 'workers-comp')?.neededBy).toBe('Before Sam Rivera starts Mon, Oct 26')
    expect(items.find((i) => i.key === 'kit-payroll')?.neededBy).toBe('Before Sam Rivera starts Mon, Oct 26')
    expect(items.find((i) => i.key === 'posters-federal')?.neededBy).toBeUndefined()
    // Nobody incoming: no dates.
    expect(firstHireKit(solo(), FRI).some((i) => i.neededBy)).toBe(false)
  })

  it('stores done toggles in complianceStatus and reads data that is already on file', () => {
    let db = solo()
    const kit = firstHireKit(db, FRI)
    db = produce(db, (d) => {
      setKitItemDone(d, kit.find((i) => i.key === 'iipp')!, true, FRI)
      setKitItemDone(d, kit.find((i) => i.key === 'kit-templates')!, true, FRI)
      d.company.payrollProvider.url = 'https://peo.example.com'
    })
    expect(db.complianceStatus.iipp).toMatchObject({ status: 'done', doneOn: FRI })
    expect(db.complianceStatus['kit-templates']).toMatchObject({ status: 'done' })
    const after = firstHireKit(db, FRI)
    expect(after.find((i) => i.key === 'iipp')?.done).toBe(true)
    expect(after.find((i) => i.key === 'kit-payroll')).toMatchObject({ done: true, onFile: 'Link saved in Settings' })
    db = produce(db, (d) => setKitItemDone(d, kit.find((i) => i.key === 'kit-templates')!, false, FRI))
    expect(db.complianceStatus['kit-templates']).toBeUndefined()
  })
})

function team(): DB {
  const db = makeDB('2025-01-06')
  addPerson(db, { id: 'p-tomas', firstName: 'Tomas', lastName: 'Herrera', startDate: '2025-10-12' })
  addPerson(db, { id: 'p-kofi', firstName: 'Kofi', lastName: 'Boateng', startDate: '2025-10-06', managerId: 'p-tomas' })
  addPerson(db, { id: 'p-lee', firstName: 'Lee', lastName: 'Park', startDate: '2026-10-12', managerId: 'p-tomas' })
  addContractor(db, { id: 'k-1', startOn: '2026-01-01' })
  addContractor(db, { id: 'k-adv', kind: 'advisor', startOn: '2026-01-01' })
  db.holidays = [{ id: 'h1', date: '2026-10-14', name: 'Founders day' }]
  db.grants.push({
    id: 'g-tomas',
    personId: 'p-tomas',
    holderType: 'employee',
    type: 'ISO',
    shares: 48000,
    strikePrice: 0.25,
    vestingStart: '2025-10-12',
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'approved',
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
  })
  db.jobs.push({
    id: 'j-1',
    title: 'Senior engineer',
    departmentId: 'd-eng',
    familyId: 'f-swe',
    levelId: 'lv-l3',
    hiringManagerId: 'p-tomas',
    panelIds: [],
    locationIds: ['loc-hq'],
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payMin: 180000,
    payMax: 220000,
    status: 'open',
    stages: [
      { id: 'new', kind: 'new', name: 'New' },
      { id: 'onsite', kind: 'onsite', name: 'Onsite' },
    ],
    interviewPlan: [],
    description: '',
    sponsorship: 'no',
    backgroundCheck: true,
    priority: 'normal',
  })
  db.candidates.push({ id: 'c-1', firstName: 'Priya', lastName: 'Nair', email: 'p@x.dev', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' })
  db.applications.push({ id: 'a-1', candidateId: 'c-1', jobId: 'j-1', stageId: 'onsite', status: 'active', appliedOn: '2026-09-01', stageEnteredOn: '2026-10-05', history: [] })
  db.interviews.push({
    id: 'i-1',
    applicationId: 'a-1',
    stageId: 'onsite',
    name: 'Onsite loop',
    startsAt: '2026-10-13T17:00:00.000Z',
    durationMin: 180,
    interviewerIds: ['p-kofi'],
    format: 'onsite',
    status: 'scheduled',
    attributes: [],
  })
  return db
}

const viewer = (db: DB, role: Viewer['role'], id: string): Viewer => ({ role, person: db.people.find((p) => p.id === id), personId: id })

describe('this week', () => {
  it('lists starts, interviews, anniversaries, cliffs and holidays by day for Admin', () => {
    const db = team()
    const view = thisWeek(db, viewer(db, 'admin', 'p-founder'), FRI)
    expect(view.days[0].date).toBe(FRI)
    // Weekend days without events are skipped.
    expect(view.days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
    const all = view.days.flatMap((d) => d.events)
    expect(all.find((e) => e.kind === 'start')?.text).toBe('Lee Park starts (#4, Engineer)')
    expect(all.find((e) => e.kind === 'interview')).toMatchObject({ date: '2026-10-13', time: '10:00 AM PT', text: 'Priya Nair onsite (Senior engineer)' })
    expect(all.find((e) => e.kind === 'anniversary')?.text).toBe('Tomas Herrera: 1 year at Testco')
    expect(all.find((e) => e.kind === 'cliff')).toMatchObject({ date: '2026-10-12', shares: 12000 })
    expect(all.find((e) => e.kind === 'holiday')?.text).toBe('Holiday: Founders day')
  })

  it('keeps cliffs from Hiring managers and shows interviews they are on or for their jobs', () => {
    const db = team()
    const mgr = weekEvents(db, viewer(db, 'manager', 'p-tomas'), FRI, '2026-10-15')
    expect(mgr.some((e) => e.kind === 'cliff')).toBe(false)
    expect(mgr.some((e) => e.kind === 'interview')).toBe(true)
    const kofi = weekEvents(db, viewer(db, 'employee', 'p-kofi'), FRI, '2026-10-15', { scope: 'personal' })
    expect(kofi.find((e) => e.kind === 'interview')?.text).toContain('you are on the panel')
    const lee = weekEvents(db, viewer(db, 'employee', 'p-lee'), FRI, '2026-10-15', { scope: 'personal' })
    expect(lee.some((e) => e.kind === 'interview')).toBe(false)
  })
})

describe('interview times', () => {
  it('shows Pacific and the candidate zone side by side', () => {
    expect(dualTime('2026-10-13T17:00:00.000Z', 'America/New_York')).toBe('10:00 AM PT (1:00 PM ET)')
    expect(dualTime('2026-10-13T17:00:00.000Z', 'America/Los_Angeles')).toBe('10:00 AM PT')
    expect(dualTime('2026-10-13T17:00:00.000Z')).toBe('10:00 AM PT')
    expect(dualTime('2026-10-13T17:00:00.000Z', 'Not/AZone')).toBe('10:00 AM PT')
    // A different day there gets its weekday.
    expect(dualTime('2026-10-13T22:30:00.000Z', 'Asia/Kolkata')).toMatch(/^3:30 PM PT \(Wed 4:00 AM .+\)$/)
  })
})

describe('headcount vs plan', () => {
  it('summarizes people, contractors and advisors', () => {
    const db = team()
    expect(headcountSummary(db, FRI)).toBe('3 employees, 1 starting, 1 contractor, 1 advisor.')
    const g = growthView(db, FRI)
    expect(g.current).toBe(3)
    expect(g.actual[g.actual.length - 1]).toEqual({ date: FRI, value: 3 })
    expect(g.from).toBe('2025-01-06')
    expect(g.to > FRI).toBe(true)
  })

  it('shows a single founder dot for a solo workspace', () => {
    const g = growthView(solo(), FRI)
    expect(g.current).toBe(1)
    expect(g.hasPlan).toBe(false)
    expect(headcountSummary(solo(), FRI)).toBe('1 employee.')
  })
})
