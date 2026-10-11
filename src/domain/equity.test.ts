import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import {
  approveGrants,
  boardConsentQueue,
  cliffDate,
  consentTableText,
  exerciseDeadline,
  grantSummary,
  monthsVested,
  nextVestDate,
  poolSummary,
  scheduleText,
  sharesHeld,
  upcomingCliffs,
  upcomingVests,
  valuationWarnings,
  vestedHeld,
  vestedShares,
  vestingPoints,
} from '@/domain/equity'
import type { DB, EquityGrant, Offer, Person } from '@/domain/types'

const D = '2026-10-09'

function mkPerson(id: string, firstName: string, startDate: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName,
    lastName: 'Test',
    workEmail: `${id}@test.com`,
    title: 'Engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    startDate,
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

function mkGrant(id: string, personId: string, shares: number, vestingStart: string, over: Partial<EquityGrant> = {}): EquityGrant {
  return {
    id,
    personId,
    holderType: 'employee',
    type: 'ISO',
    shares,
    strikePrice: 0.25,
    vestingStart,
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'approved',
    boardApprovedOn: vestingStart,
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    ...over,
  }
}

function equityDB(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.equity.poolShares = 1_200_000
  db.equity.poolIncreases = [{ id: 'pi-seed', date: '2026-02-24', shares: 500_000, note: 'Seed top-up' }]
  db.equity.valuations = [
    { id: 'v-1', effectiveOn: '2025-05-01', fmvPerShare: 0.25, provider: 'Meridian', expiresOn: '2026-05-01' },
    { id: 'v-2', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'Meridian', expiresOn: '2027-03-20' },
  ]
  db.company.fundingRounds = [{ id: 'fr-seed', name: 'Seed', closedOn: '2026-02-24', amount: 14_000_000, instrument: 'Priced' }]
  db.people.push(
    mkPerson('p-tomas', 'Tomas', '2025-05-12'),
    mkPerson('p-kofi', 'Kofi', '2025-10-06'),
    mkPerson('p-ben', 'Ben', '2025-08-18', { endDate: '2026-09-18' }),
    mkPerson('p-omar', 'Omar', '2026-05-04', { endDate: '2026-08-28' }),
    mkPerson('p-aisha', 'Aisha', '2026-09-08'),
    mkPerson('p-gone', 'Gwen', '2025-10-06', { endDate: '2026-09-01' }),
  )
  db.candidates.push(
    { id: 'c-dan', firstName: 'Daniel', lastName: 'Reyes', email: 'd@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    { id: 'c-dee', firstName: 'Dee', lastName: 'Brooks', email: 'e@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
  )
  db.grants.push(
    mkGrant('g-tomas', 'p-tomas', 150_000, '2025-05-12', { exercisedShares: 10_000 }),
    mkGrant('g-kofi', 'p-kofi', 52_000, '2025-10-06'),
    mkGrant('g-ben', 'p-ben', 60_000, '2025-08-18', { cancelledShares: 43_750, cancelledOn: '2026-09-18' }),
    mkGrant('g-omar', 'p-omar', 30_000, '2026-05-04', { status: 'cancelled', cancelledShares: 30_000, cancelledOn: '2026-08-28', strikePrice: 1.15 }),
    mkGrant('g-aisha', 'p-aisha', 12_000, '2026-09-08', { status: 'promised', boardApprovedOn: undefined, strikePrice: 1.15, proposedOn: '2026-09-02' }),
    mkGrant('g-dan', 'c-dan', 50_000, '2026-11-02', { holderType: 'candidate', status: 'reserved', boardApprovedOn: undefined, fromOfferId: 'o-dan', strikePrice: 1.15 }),
    mkGrant('g-declined', 'c-old', 20_000, '2026-06-01', { holderType: 'candidate', status: 'cancelled', boardApprovedOn: undefined, cancelledShares: 20_000 }),
    mkGrant('g-gone', 'p-gone', 24_000, '2025-10-06'),
  )
  const offer: Offer = {
    id: 'o-dee',
    applicationId: 'a-dee',
    candidateId: 'c-dee',
    jobId: 'j-se',
    version: 1,
    title: 'Solutions engineer',
    levelId: 'lv-l3',
    familyId: 'f-solutions',
    departmentId: 'd-gtm',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payType: 'salary',
    salary: 165_000,
    equityType: 'ISO',
    equityShares: 18_000,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: '2026-11-09',
    expiresOn: '2026-10-14',
    contingencies: [],
    status: 'sent',
    createdOn: '2026-10-07',
    approvals: [],
  }
  db.offers.push(offer)
  return db
}

describe('existing vesting helpers', () => {
  const g = mkGrant('g', 'p', 48_000, '2025-10-06')
  it('vests nothing before the cliff, a quarter at the cliff, then monthly', () => {
    expect(monthsVested(g, '2026-10-05')).toBe(0)
    expect(vestedShares(g, '2026-10-05')).toBe(0)
    expect(vestedShares(g, '2026-10-06')).toBe(12_000)
    expect(vestedShares(g, '2026-11-06')).toBe(13_000)
    expect(vestedShares(g, '2030-01-01')).toBe(48_000)
    expect(cliffDate(g)).toBe('2026-10-06')
    expect(nextVestDate(g, '2026-10-09')).toBe('2026-11-06')
  })

  it('vests a 31st start on the last day of shorter months everywhere', () => {
    const g31 = mkGrant('g31', 'p-x', 48_000, '2025-01-31')
    expect(vestedShares(g31, '2026-01-30')).toBe(0)
    expect(vestedShares(g31, '2026-01-31')).toBe(12_000)
    expect(vestedShares(g31, '2026-02-27')).toBe(12_000)
    expect(vestedShares(g31, '2026-02-28')).toBe(13_000)
    expect(vestedShares(g31, '2026-04-29')).toBe(14_000)
    expect(vestedShares(g31, '2026-04-30')).toBe(15_000)
    expect(nextVestDate(g31, '2026-02-27')).toBe('2026-02-28')
    expect(nextVestDate(g31, '2026-02-28')).toBe('2026-03-31')
    expect(vestingPoints(g31)[13]).toEqual({ date: '2026-02-28', vested: 13_000 })

    const db = equityDB()
    db.people.push(mkPerson('p-x', 'Xia', '2025-01-31'))
    db.grants.push(g31)
    expect(upcomingVests(db, '2026-02-28', '2026-02-28').filter((v) => v.grantId === 'g31')).toEqual([
      { personId: 'p-x', grantId: 'g31', date: '2026-02-28', shares: 1_000, cumulative: 13_000, isCliff: false, awaitingBoard: false },
    ])
    expect(upcomingVests(db, '2026-04-30', '2026-04-30').find((v) => v.grantId === 'g31')?.cumulative).toBe(15_000)
    expect(grantSummary(db, 'p-x', '2026-02-28')).toMatchObject({ vested: 13_000, nextVest: { date: '2026-03-31', shares: 1_000 } })
    expect(grantSummary(db, 'p-x', '2026-04-30')).toMatchObject({ vested: 15_000, nextVest: { date: '2026-05-31', shares: 1_000 } })
    expect(grantSummary(db, 'p-x', '2026-04-29')).toMatchObject({ vested: 14_000, nextVest: { date: '2026-04-30', shares: 1_000 } })
  })

  it('counts held shares after cancellation', () => {
    expect(sharesHeld(mkGrant('a', 'p', 60_000, '2025-08-18', { cancelledShares: 43_750 }))).toBe(16_250)
    expect(sharesHeld(mkGrant('b', 'p', 30_000, '2026-05-04', { status: 'cancelled' }))).toBe(0)
  })
})

describe('pool summary', () => {
  it('splits the pool into granted, awaiting board, reserved, returned and available', () => {
    const s = poolSummary(equityDB(), D)
    expect(s.poolShares).toBe(1_700_000)
    expect(s.increases).toBe(500_000)
    // Tomas 150,000 (10,000 exercised still count), Kofi 52,000, Ben's 16,250 kept.
    expect(s.grantedOutstanding).toBe(150_000 + 52_000 + 16_250)
    expect(s.exercised).toBe(10_000)
    expect(s.awaitingBoard).toBe(12_000)
    // Daniel's reserved grant plus Dee's offer, which has no grant row yet.
    expect(s.reservedByOffers).toBe(50_000 + 18_000)
    // Ben's 43,750 unvested, Omar's 30,000, and Gwen's 24,000: she left Sep 1, before her cliff, and no
    // cancellation was recorded. The declined offer's reservation never left the pool.
    expect(s.returned).toBe(43_750 + 30_000 + 24_000)
    expect(s.unrecordedForfeitures).toBe(24_000)
    expect(s.unrecordedGrantIds).toEqual(['g-gone'])
    expect(s.available).toBe(1_700_000 - 218_250 - 12_000 - 68_000)
    expect(s.usedPct).toBeCloseTo((218_250 + 12_000 + 68_000) / 1_700_000, 6)
  })

  it('keeps what vested before an unrecorded departure, or what was exercised', () => {
    const db = equityDB()
    db.people = db.people.map((p) => (p.id === 'p-gone' ? { ...p, endDate: '2026-11-15' } : p))
    // Cliff on Oct 6 (6,000) and Nov 6 (500 more): 6,500 kept, 17,500 back to the pool.
    const s = poolSummary(db, '2026-12-01')
    expect(s.unrecordedForfeitures).toBe(17_500)
    expect(s.grantedOutstanding).toBe(150_000 + 52_000 + 16_250 + 6_500)
    // Still employed on the end date itself: nothing is returned yet.
    expect(poolSummary(db, '2026-11-15').unrecordedForfeitures).toBe(0)
    db.grants = db.grants.map((g) => (g.id === 'g-gone' ? { ...g, earlyExercise: true, exercisedShares: 10_000 } : g))
    expect(poolSummary(db, '2026-12-01').unrecordedForfeitures).toBe(14_000)
  })

  it('stops holding shares for offers past their expiry date', () => {
    const db = equityDB()
    // Dee's offer expires Oct 14; Daniel's reserved grant came from an offer that lapsed Oct 1.
    db.offers.push({ ...db.offers[0], id: 'o-dan', applicationId: 'a-dan', candidateId: 'c-dan', equityShares: 50_000, expiresOn: '2026-10-01' })
    expect(poolSummary(db, D).reservedByOffers).toBe(18_000)
    expect(poolSummary(db, '2026-10-15').reservedByOffers).toBe(0)
  })

  it("returns a leaver's unvested shares on their last day, not when offboarding starts", () => {
    const db = equityDB()
    // Offboarding recorded today for a last day of Oct 30: Kofi keeps vesting until then.
    db.grants = db.grants.map((g) => (g.id === 'g-kofi' ? { ...g, cancelledShares: 30_000, cancelledOn: '2026-10-30' } : g))
    const before = poolSummary(db, D)
    expect(before.grantedOutstanding).toBe(150_000 + 52_000 + 16_250)
    expect(before.returned).toBe(43_750 + 30_000 + 24_000)
    const after = poolSummary(db, '2026-10-30')
    expect(after.grantedOutstanding).toBe(150_000 + 22_000 + 16_250)
    expect(after.returned).toBe(43_750 + 30_000 + 24_000 + 30_000)
    const kofi = db.grants.find((g) => g.id === 'g-kofi') as EquityGrant
    expect(sharesHeld(kofi, D)).toBe(52_000)
    expect(sharesHeld(kofi, '2026-10-30')).toBe(22_000)
  })

  it('counts pool increases only from their date', () => {
    expect(poolSummary(equityDB(), '2026-01-01').poolShares).toBe(1_200_000)
  })
})

describe('409A warnings', () => {
  it('stays quiet while the 409A is current and no round followed it', () => {
    expect(valuationWarnings(equityDB(), D)).toEqual([])
  })

  it('warns 60 days before expiry and after it', () => {
    const soon = valuationWarnings(equityDB(), '2027-02-01')
    expect(soon.map((w) => w.kind)).toEqual(['expiring'])
    expect(soon[0].text).toBe('The 409A from Mar 20, 2026 expires in 47 days (Mar 20, 2027). Plan the next valuation now so grants keep safe harbor.')
    expect(valuationWarnings(equityDB(), '2027-01-19').map((w) => w.kind)).toEqual(['expiring'])
    expect(valuationWarnings(equityDB(), '2027-01-18')).toEqual([])
    const late = valuationWarnings(equityDB(), '2027-03-21')
    expect(late.map((w) => w.kind)).toEqual(['expired'])
    expect(late[0].text).toContain('expired on Mar 20, 2027')
  })

  it('warns when a round closed after the 409A in effect', () => {
    // Aisha's promised $1.15 strike also differs from the $0.25 409A in effect that day.
    const w = valuationWarnings(equityDB(), '2026-03-01')
    expect(w.map((x) => x.kind)).toEqual(['financing', 'strike'])
    expect(w[0].text).toContain('The Seed round closed on Feb 24, 2026, after the current 409A (May 1, 2025)')
  })

  it('warns about a missing 409A and a promised strike that differs from it', () => {
    const none = equityDB()
    none.equity.valuations = []
    expect(valuationWarnings(none, D).map((w) => w.kind)).toEqual(['missing'])
    const stale = equityDB()
    const g = stale.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    const w = valuationWarnings(stale, D)
    expect(w.map((x) => x.kind)).toEqual(['strike'])
    expect(w[0].text).toContain('$0.25 strike, but the 409A in effect is $1.15')
  })
})

describe('vesting points, cliffs and vests', () => {
  it('builds monthly cumulative points with the cliff jump', () => {
    const pts = vestingPoints(mkGrant('g', 'p', 48_000, '2025-10-06'))
    expect(pts).toHaveLength(49)
    expect(pts[0]).toEqual({ date: '2025-10-06', vested: 0 })
    expect(pts[11].vested).toBe(0)
    expect(pts[12]).toEqual({ date: '2026-10-06', vested: 12_000 })
    expect(pts[13].vested).toBe(13_000)
    expect(pts[48]).toEqual({ date: '2029-10-06', vested: 48_000 })
  })

  it('flattens after a cancellation', () => {
    const pts = vestingPoints(mkGrant('g', 'p', 60_000, '2025-08-18', { cancelledShares: 43_750, cancelledOn: '2026-09-18' }))
    expect(pts[13].vested).toBe(16_250)
    expect(pts[14].vested).toBe(16_250)
    expect(pts[48].vested).toBe(16_250)
  })

  it('lists cliffs in range for people still here', () => {
    const cliffs = upcomingCliffs(equityDB(), '2026-10-01', '2026-10-31')
    // Gwen left Sep 1, before her Oct 6 cliff.
    expect(cliffs).toEqual([{ personId: 'p-kofi', grantId: 'g-kofi', date: '2026-10-06', shares: 13_000, awaitingBoard: false }])
    expect(upcomingCliffs(equityDB(), '2027-09-01', '2027-09-30')).toEqual([
      { personId: 'p-aisha', grantId: 'g-aisha', date: '2027-09-08', shares: 3_000, awaitingBoard: true },
    ])
  })

  it('lists monthly vests with shares and running totals', () => {
    const vests = upcomingVests(equityDB(), '2026-11-01', '2026-11-30').filter((v) => v.personId === 'p-kofi')
    expect(vests).toEqual([
      { personId: 'p-kofi', grantId: 'g-kofi', date: '2026-11-06', shares: 1_083, cumulative: 14_083, isCliff: false, awaitingBoard: false },
    ])
  })

  it('writes schedules in plain words', () => {
    expect(scheduleText({ cliffMonths: 12, vestingMonths: 48 })).toBe('4-year vesting, 1-year cliff, then monthly')
    expect(scheduleText({ cliffMonths: 0, vestingMonths: 24 })).toBe('Monthly over 2 years, no cliff')
    expect(scheduleText({ cliffMonths: 6, vestingMonths: 30 })).toBe('30-month vesting, 6-month cliff, then monthly')
  })
})

describe('board consent', () => {
  it('queues promised grants and copies a tab-separated consent table', () => {
    const db = equityDB()
    expect(boardConsentQueue(db).map((g) => g.id)).toEqual(['g-aisha'])
    const text = consentTableText(db, ['g-aisha', 'missing'], D)
    expect(text.split('\n')).toEqual([
      'Name\tShares\tType\tStrike\tVest start\tSchedule',
      'Aisha Test\t12,000\tISO\t$1.15\t2026-09-08\t4-year vesting, 1-year cliff, then monthly',
    ])
  })

  it('fills a missing strike from the 409A in effect', () => {
    const db = equityDB()
    const g = db.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$1.15\t')
  })

  it('prints the strike a promised grant will get at the board date', () => {
    const db = equityDB()
    const g = db.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    // A stale $0.25 strike from before the seed round: approveGrants will set $1.15, so the table says $1.15.
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$1.15\t')
    expect(consentTableText(db, ['g-aisha'], D, { keepStrike: true })).toContain('\t$0.25\t')
    // Approved grants keep their recorded strike.
    expect(consentTableText(db, ['g-kofi'], D)).toContain('\t$0.25\t')
    db.equity.valuations = []
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$0.25\t')
  })

  it('approves promised grants, prices them at the board-date 409A and starts the 25102(o) clock once', () => {
    const start = equityDB()
    // A company with no earlier board approvals.
    start.grants = start.grants.filter((x) => !x.boardApprovedOn)
    const g = start.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(start, (d) => {
      result = approveGrants(d, ['g-aisha', 'g-kofi'], '2026-10-09', { date: D })
    })
    expect(result?.approved).toEqual(['g-aisha'])
    expect(result?.skipped).toEqual(['g-kofi'])
    expect(result?.firstIssuance).toBe(true)
    expect(result?.notice25102oDueOn).toBe('2026-11-08')
    const approved = next.grants.find((x) => x.id === 'g-aisha')
    expect(approved).toMatchObject({ status: 'approved', boardApprovedOn: '2026-10-09', strikePrice: 1.15 })
    expect(next.equity.firstIssuanceOn).toBe('2026-10-09')
    expect(next.activity.map((a) => a.text)).toEqual([
      'Board approved the option grant for Aisha Test (board date Oct 9, 2026)',
      'First option grants recorded on Oct 9, 2026. The California 25102(o) notice is due by Nov 8, 2026.',
    ])

    const again = produce(next, (d) => {
      d.grants.push(mkGrant('g-new', 'p-kofi', 5_000, '2026-10-09', { status: 'promised', boardApprovedOn: undefined }))
      result = approveGrants(d, ['g-new'], '2027-04-01', { date: D })
    })
    expect(result?.firstIssuance).toBe(false)
    expect(again.equity.firstIssuanceOn).toBe('2026-10-09')
    expect(result?.warnings.some((w) => w.includes('expired on Mar 20, 2027'))).toBe(true)
    expect(result?.warnings.some((w) => w.includes('after today'))).toBe(true)
  })

  it('dates the first issuance from earlier board approvals when it was never recorded', () => {
    // Tomas's grant was approved May 12, 2025; firstIssuanceOn was never set.
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(equityDB(), (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-09', { date: D })
    })
    expect(result?.firstIssuance).toBe(false)
    expect(result?.notice25102oDueOn).toBeUndefined()
    expect(next.equity.firstIssuanceOn).toBe('2025-05-12')
    expect(result?.warnings).toContain(
      'The California 25102(o) notice was due by Jun 11, 2025, 30 days after the first option grants on May 12, 2025. No filing is recorded, so file it now or record the filing date.',
    )
    expect(next.activity.at(-1)?.text).toBe(
      'First option grants recorded as of May 12, 2025, the earliest board approval on file. The California 25102(o) notice was due by Jun 11, 2025.',
    )

    // A filing on record: no warning. A grant cancelled after board approval still counts as issued.
    const filed = equityDB()
    filed.equity.filing25102oOn = '2025-06-01'
    filed.grants = filed.grants.filter((x) => x.status !== 'approved')
    const after = produce(filed, (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-09', { date: D })
    })
    expect(after.equity.firstIssuanceOn).toBe('2026-05-04')
    expect(result?.firstIssuance).toBe(false)
    expect(result?.warnings.some((w) => w.includes('25102(o)'))).toBe(false)
  })

  it('will not approve an option grant at a $0 strike when no 409A is in effect', () => {
    const db = equityDB()
    db.equity.valuations = []
    db.grants.push(mkGrant('g-zero', 'p-kofi', 5_000, '2026-10-09', { status: 'promised', boardApprovedOn: undefined, strikePrice: 0 }))
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(db, (d) => {
      result = approveGrants(d, ['g-zero', 'g-aisha'], '2026-10-09', { date: D })
    })
    expect(result?.approved).toEqual(['g-aisha'])
    expect(result?.skipped).toEqual(['g-zero'])
    expect(result?.warnings.some((w) => w.includes('Add a 409A first'))).toBe(true)
    expect(next.grants.find((g) => g.id === 'g-zero')?.status).toBe('promised')
  })

  it('gives 90 days to exercise after the last day', () => {
    expect(exerciseDeadline({ postTerminationExerciseDays: 90 }, '2026-09-18')).toBe('2026-12-17')
  })
})

describe('grant summary', () => {
  it('summarizes a vesting grant with the next vest', () => {
    const s = grantSummary(equityDB(), 'p-kofi', D)
    expect(s).toMatchObject({ totalShares: 52_000, vested: 13_000, unvested: 39_000, status: 'vesting' })
    expect(s.nextVest).toEqual({ date: '2026-11-06', shares: 1_083 })
    expect(s.cliff).toEqual({ date: '2026-10-06', shares: 13_000, passed: true })
    expect(s.text).toBe('13,000 of 52,000 vested; next 1,083 on Nov 6')
  })

  it('counts down to the cliff', () => {
    const s = grantSummary(equityDB(), 'p-kofi', '2026-09-01')
    expect(s.status).toBe('pre_cliff')
    expect(s.nextVest).toEqual({ date: '2026-10-06', shares: 13_000 })
    expect(s.text).toBe('13,000 options vest at the cliff on Oct 6, 2026')
  })

  it('shows grants waiting for the board and grants kept after leaving', () => {
    expect(grantSummary(equityDB(), 'p-aisha', D)).toMatchObject({ status: 'awaiting_board', awaitingBoard: 12_000, text: 'Grant awaiting board consent' })
    const ben = grantSummary(equityDB(), 'p-ben', D)
    expect(ben).toMatchObject({ status: 'ended', totalShares: 16_250, vested: 16_250, nextVest: null })
    expect(vestedHeld(equityDB(), equityDB().grants.find((g) => g.id === 'g-ben') as EquityGrant, '2027-06-01')).toBe(16_250)
    expect(grantSummary(equityDB(), 'p-founder', D).status).toBe('none')
  })
})
