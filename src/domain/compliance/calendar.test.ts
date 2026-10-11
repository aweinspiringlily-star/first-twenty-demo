import { describe, expect, it } from 'vitest'
import { calendarICS, complianceCalendar, contractors1099, estimatePaidInYear, nextBusinessDay } from './calendar'
import { addContractor, addMany, addPerson, ledgerlarkLite, makeDB } from './testkit'

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id)

describe('recurring items', () => {
  it('expands a quarterly item, shows the last completion, and replaces the built-in SOC 2 reminder', () => {
    const db = makeDB()
    db.company.soc2Enabled = true
    db.recurring.push({
      id: 'r-access',
      title: 'Quarterly access review (SOC 2)',
      cadence: 'quarterly',
      nextDueOn: '2026-10-31',
      lastDoneOn: '2026-07-28',
      ruleId: 'soc2-access-review',
    })
    const items = complianceCalendar(db, '2026-07-01', '2027-06-30').filter((i) => i.kind === 'recurring' || i.kind === 'soc2_access_review')
    expect(items.map((i) => [i.date, i.done ?? false])).toEqual([
      ['2026-07-28', true],
      ['2026-10-31', false],
      ['2027-01-31', false],
      ['2027-04-30', false],
    ])
    expect(items.every((i) => i.statutory === false)).toBe(true)
  })

  it('adds quarter-end SOC 2 access reviews when SOC 2 is on and no recurring item exists', () => {
    const db = makeDB()
    db.company.soc2Enabled = true
    db.complianceStatus['soc2-access-review'] = { actionsDone: { '2026-Q4': '2026-12-10' } }
    const items = complianceCalendar(db, '2026-10-01', '2027-03-31').filter((i) => i.kind === 'soc2_access_review')
    expect(items.map((i) => [i.id, i.date, i.done])).toEqual([
      ['soc2-access-review-2026-Q4', '2026-12-31', true],
      ['soc2-access-review-2027-Q1', '2027-03-31', false],
    ])
    db.company.soc2Enabled = false
    expect(complianceCalendar(db, '2026-10-01', '2027-03-31').some((i) => i.kind === 'soc2_access_review')).toBe(false)
  })
})

describe('1099-NEC', () => {
  it('estimates payments from rate and dates', () => {
    const db = makeDB()
    const monthly = addContractor(db, { id: 'k-m', startOn: '2026-01-01', rate: 6500, rateUnit: 'month' })
    const hourly = addContractor(db, { id: 'k-h', startOn: '2026-04-01', rate: 85, rateUnit: 'hour', hoursPerWeek: 25 })
    const project = addContractor(db, { id: 'k-p', startOn: '2025-11-01', endOn: '2026-02-28', rate: 38000, rateUnit: 'project' })
    expect(estimatePaidInYear(monthly, 2026)).toBe(78000)
    expect(estimatePaidInYear(hourly, 2026)).toBe(83482) // 275 days (39.3 weeks) of 25 hours at $85
    expect(estimatePaidInYear(project, 2025) + estimatePaidInYear(project, 2026)).toBe(38000)
    expect(estimatePaidInYear(monthly, 2025)).toBe(0)
  })

  it('lists contractors at or above the threshold, skips corporations, and moves a Sunday Jan 31 to Monday', () => {
    const db = makeDB()
    addContractor(db, { id: 'k-llc', entityName: 'Northline Finance Partners LLC', entityType: 'llc', startOn: '2025-06-01', rate: 6500 })
    addContractor(db, { id: 'k-ind', name: 'Marisol Vega', startOn: '2026-04-01', rate: 85, rateUnit: 'hour', hoursPerWeek: 25 })
    addContractor(db, { id: 'k-corp', name: 'Studio Fieldnote', entityType: 'corporation', startOn: '2025-11-01', endOn: '2026-02-28', rate: 38000, rateUnit: 'project' })
    addContractor(db, { id: 'k-small', name: 'Tiny Gig', startOn: '2026-05-01', endOn: '2026-05-31', rate: 1500, rateUnit: 'project' })
    expect(contractors1099(db, 2026).map((x) => x.contractor.id)).toEqual(['k-llc', 'k-ind'])
    const item = complianceCalendar(db, '2027-01-01', '2027-02-28').find((i) => i.kind === 'form_1099')
    expect(item).toMatchObject({
      id: '1099-2027',
      date: '2027-02-01',
      title: 'File 1099-NEC for 2 contractors paid $2,000 or more in 2026',
      statutory: true,
      ruleId: 'first-contractor',
    })
    expect(item?.detail).toContain('Northline Finance Partners LLC (about $78,000)')
    expect(item?.detail).toContain('Jan 31 falls on a weekend, so the deadline moves to Feb 1, 2027.')
  })

  it('uses the $600 threshold for 2025 payments (due Mon Feb 2, 2026)', () => {
    const db = makeDB()
    addContractor(db, { id: 'k-small', name: 'Small Job', startOn: '2025-12-01', endOn: '2025-12-31', rate: 1000, rateUnit: 'project' })
    const item = complianceCalendar(db, '2026-01-15', '2026-02-15').find((i) => i.kind === 'form_1099')
    expect(item).toMatchObject({ date: '2026-02-02', title: 'File 1099-NEC for 1 contractor paid $600 or more in 2025' })
    expect(nextBusinessDay('2026-01-31')).toBe('2026-02-02')
  })
})

describe('dated obligations', () => {
  it('collects notices, reviews, valuations, I-9 dates, contracts, DE 542, leave notices and rule deadlines', () => {
    const db = makeDB('2026-10-05')
    db.company.soc2Enabled = false
    db.equity.valuations.push({ id: 'v1', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'X', expiresOn: '2027-03-20' })
    db.company.fundingRounds.push({ id: 'fr-a', name: 'Series A', closedOn: '2027-02-15', amount: 30_000_000, instrument: 'Priced' })
    addPerson(db, { id: 'p-visa', firstName: 'Mei', lastName: 'Tanaka', startDate: '2026-10-05', i9ReverifyOn: '2027-02-10' })
    addPerson(db, { id: 'p-lena', firstName: 'Lena', lastName: 'Park', startDate: '2026-10-05' })
    db.leaveCases.push({ id: 'lc1', personId: 'p-lena', kind: 'bonding', requestedOn: '2026-10-06', startDate: '2026-11-02', designationNoticeDueOn: '2026-10-13' })
    addContractor(db, { id: 'k-ind', name: 'Ivy Ind', startOn: '2026-10-01', endOn: '2026-12-31' })
    addContractor(db, { id: 'k-llc', name: 'Firm', entityType: 'llc', startOn: '2026-10-01' })
    db.complianceStatus['calsavers-or-401k'] = { dueOn: '2026-12-31', note: 'From the CalSavers notice' }
    db.complianceStatus['sb294-annual-notice'] = { actionsDone: { 'year-2027': '2027-01-20' } }

    const items = complianceCalendar(db, '2026-10-05', '2027-03-31')
    const byKind = (k: string) => items.filter((i) => i.kind === k)
    // A company target (5 business days), not a statutory date.
    expect(byKind('leave_notice')).toMatchObject([{ id: 'leave-notice-lc1', date: '2026-10-13', statutory: false, done: false, title: 'Leave designation notice for Lena Park due' }])
    expect(byKind('de542')).toMatchObject([{ id: 'de542-k-ind', date: '2026-10-21', statutory: true, done: false }])
    expect(byKind('contract_end')).toMatchObject([{ date: '2026-12-31', title: 'Contract ends: Ivy Ind' }])
    expect(byKind('i9_reverify')).toMatchObject([{ date: '2027-02-10', personId: 'p-visa', statutory: true }])
    expect(byKind('rate_review')).toMatchObject([{ id: 'rate-review-2027', date: '2027-01-01', done: false }])
    expect(byKind('sb294_notice')).toMatchObject([{ id: 'sb294-2027', date: '2027-02-01', statutory: true, done: true }])
    expect(byKind('victims_notice')).toMatchObject([{ date: '2027-02-01', statutory: false }])
    expect(ids(byKind('valuation_409a'))).toEqual(['409a-warn-v1', '409a-financing-fr-a', '409a-expires-v1'])
    expect(byKind('valuation_409a')[0].date).toBe('2027-01-19')
    const deadlines = byKind('rule_deadline')
    expect(deadlines.map((d) => [d.ruleId, d.date])).toEqual([
      ['edd-registration', '2026-10-20'],
      ['calsavers-or-401k', '2026-12-31'],
    ])
    expect(deadlines[1].detail).toBe('From the CalSavers notice')
    // Sorted by date with stable, unique ids.
    expect(items.map((i) => i.date)).toEqual([...items.map((i) => i.date)].sort())
    expect(new Set(ids(items)).size).toBe(items.length)
    expect(ids(complianceCalendar(db, '2026-10-05', '2027-03-31'))).toEqual(ids(items))
  })

  it('includes training due dates and completions', () => {
    const db = ledgerlarkLite()
    db.trainings.push({ id: 't1', personId: 'p-aisha', kind: 'security_awareness', dueOn: '2026-10-08', completedOn: '2026-10-12' })
    const items = complianceCalendar(db, '2026-10-09', '2027-06-30').filter((i) => i.kind === 'training')
    const lucas = items.filter((i) => i.personId === 'p-lucas').map((i) => [i.date, i.title])
    expect(lucas).toEqual(
      expect.arrayContaining([
        ['2026-11-18', 'Lucas Ferreira: security awareness due'],
        ['2027-04-19', 'Lucas Ferreira: harassment prevention (1 hour) due'],
      ]),
    )
    expect(items.find((i) => i.id === 'tr-p-aisha-security_awareness-done-2026-10-12')).toMatchObject({ done: true })
    expect(items.some((i) => i.personId === 'p-caleb' && i.title.includes('harassment'))).toBe(false)
    expect(items.filter((i) => i.title.includes('harassment')).every((i) => i.statutory)).toBe(true)
  })
})

describe('fixes from review', () => {
  it('a scheduled leaver gets no training due after the last day', () => {
    const db = makeDB('2024-01-08')
    db.company.soc2Enabled = true
    addMany(db, 4, '2024-01-08')
    addPerson(db, { id: 'p-leaver', firstName: 'Lee', lastName: 'Ver', startDate: '2024-06-03', endDate: '2026-11-15' })
    db.trainings.push(
      { id: 't-sec', personId: 'p-leaver', kind: 'security_awareness', dueOn: '2025-11-01', completedOn: '2025-11-01' },
      { id: 't-har', personId: 'p-leaver', kind: 'harassment_employee', dueOn: '2024-12-20', completedOn: '2024-12-20' },
    )
    const items = complianceCalendar(db, '2026-10-09', '2026-12-31').filter((i) => i.personId === 'p-leaver')
    expect(items.map((i) => [i.date, i.title])).toEqual([['2026-11-01', 'Lee Ver: security awareness refresher due']])
  })

  it('DE 542 only for individuals paid or contracted for $600 or more', () => {
    const db = makeDB('2026-10-01')
    addContractor(db, { id: 'k-gig', name: 'Small Gig', startOn: '2026-10-05', endOn: '2026-10-09', rate: 500, rateUnit: 'project' })
    addContractor(db, { id: 'k-hourly', name: 'Open Hourly', startOn: '2026-10-05', rate: 60, rateUnit: 'hour' })
    const de542 = complianceCalendar(db, '2026-10-01', '2026-12-31').filter((i) => i.kind === 'de542')
    expect(de542.map((i) => i.contractorId)).toEqual(['k-hourly'])
    expect(de542[0].detail).toContain('$600 or more in a calendar year')
  })

  it('the SB 294 calendar item is done when both yearly actions were ticked on the rule card', () => {
    const db = makeDB('2025-01-06')
    db.complianceStatus['sb294-annual-notice'] = { actionsDone: { 'send-annual@2027': '2027-01-20', 'record-dates@2027': '2027-01-20' } }
    const item = complianceCalendar(db, '2027-01-01', '2027-02-28').find((i) => i.kind === 'sb294_notice')
    expect(item).toMatchObject({ id: 'sb294-2027', done: true })
  })
})

describe('ics export', () => {
  it('writes all-day events', () => {
    const db = makeDB('2026-10-05')
    const items = complianceCalendar(db, '2026-10-05', '2026-10-31')
    const ics = calendarICS(items)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('X-WR-CALNAME:First Twenty compliance')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261020')
    expect(ics).toContain('SUMMARY:EDD employer registration (DE 1): due')
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(items.length)
  })
})
