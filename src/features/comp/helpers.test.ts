import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { EquityGrant } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import {
  bandErrors,
  bandFieldErrors,
  boardHTML,
  boardSummary,
  boardText,
  cliffCards,
  cliffCountdown,
  cliffSentence,
  combinedVesting,
  compTableCSV,
  effectiveDatePresets,
  equityGuidelineLabel,
  hiringManagerForSlot,
  median,
  mlPremium,
  nextLevel,
  nextPayPeriodStart,
  overtimeStatusText,
  peopleInBand,
  quarterStartPresets,
  snapTo1K,
  splitMoneyText,
  stepChartSVG,
  variableLabel,
  vestingMilestones,
} from './helpers'
import { compTable } from '@/domain/pay'

const D = '2026-10-09'

beforeAll(() => setClockOverride(D))
afterAll(() => setClockOverride(null))

function grant(over: Partial<EquityGrant> = {}): EquityGrant {
  return {
    id: 'g1',
    personId: 'p1',
    holderType: 'employee',
    type: 'ISO',
    shares: 48_000,
    strikePrice: 1,
    vestingStart: '2026-01-12',
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'approved',
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    ...over,
  }
}

describe('labels', () => {
  it('describes variable pay and equity guidelines', () => {
    expect(variableLabel(1)).toBe('50/50 OTE')
    expect(variableLabel(0.15)).toBe('15% variable')
    expect(variableLabel(undefined)).toBe('No variable')
    expect(equityGuidelineLabel({ equityMinPct: 0.0015, equityMaxPct: 0.0035 })).toBe('0.15% to 0.35%')
    expect(equityGuidelineLabel({ equityMinPct: 0, equityMaxPct: 0 })).toBe('None')
  })
  it('snaps to $1K', () => {
    expect(snapTo1K(201_499)).toBe(201_000)
    expect(snapTo1K(201_500)).toBe(202_000)
  })
  it('takes a median', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
})

describe('effective dates', () => {
  it('finds the next semi-monthly period start', () => {
    expect(nextPayPeriodStart('2026-10-09', 'semi_monthly')).toBe('2026-10-16')
    expect(nextPayPeriodStart('2026-10-16', 'semi_monthly')).toBe('2026-11-01')
    expect(nextPayPeriodStart('2026-12-20', 'semi_monthly')).toBe('2027-01-01')
    expect(nextPayPeriodStart('2026-10-01', 'semi_monthly')).toBe('2026-10-16')
  })
  it('handles monthly and biweekly schedules', () => {
    expect(nextPayPeriodStart('2026-10-09', 'monthly')).toBe('2026-11-01')
    // Anchor Fri May 15, 2026: periods every 14 days.
    expect(nextPayPeriodStart('2026-05-20', 'biweekly', '2026-05-15')).toBe('2026-05-29')
    expect(nextPayPeriodStart('2026-05-29', 'biweekly', '2026-05-15')).toBe('2026-06-12')
    expect(nextPayPeriodStart('2026-05-01', 'biweekly', '2026-05-15')).toBe('2026-05-15')
    // No anchor: next Monday (Oct 9, 2026 is a Friday).
    expect(nextPayPeriodStart('2026-10-09', 'biweekly')).toBe('2026-10-12')
  })
  it('builds effective-date chips with the next pay period first and no duplicate dates', () => {
    const p = effectiveDatePresets('2026-10-09', 'semi_monthly')
    expect(p[0]).toEqual({ label: 'Next pay period (Oct 16)', date: '2026-10-16' })
    expect(p.map((x) => x.date)).toEqual(['2026-10-16', '2026-11-01', '2027-01-01', '2026-10-09'])
    const dec = effectiveDatePresets('2026-12-20', 'semi_monthly')
    expect(dec.map((x) => x.date)).toEqual(['2027-01-01', '2026-12-20'])
  })
  it('offers the first weekday of the next four quarters', () => {
    expect(quarterStartPresets('2026-10-09')).toEqual([
      { label: 'Q1 2027', date: '2027-01-01' },
      { label: 'Q2 2027', date: '2027-04-01' },
      { label: 'Q3 2027', date: '2027-07-01' },
      { label: 'Q4 2027', date: '2027-10-01' },
    ])
    // Jan 1, 2028 is a Saturday, so the chip moves to Monday Jan 3.
    expect(quarterStartPresets('2027-11-01')[0]).toEqual({ label: 'Q1 2028', date: '2028-01-03' })
  })
})

describe('splitMoneyText', () => {
  it('separates amounts so they can be blurred', () => {
    const parts = splitMoneyText('Run-rate $256K a month, $322K with Lucas. Contractors $15.7K a month.')
    expect(parts.filter((p) => p.money).map((p) => p.text)).toEqual(['$256K', '$322K', '$15.7K'])
    expect(parts.map((p) => p.text).join('')).toBe('Run-rate $256K a month, $322K with Lucas. Contractors $15.7K a month.')
    expect(splitMoneyText('No money here')).toEqual([{ text: 'No money here', money: false }])
    expect(splitMoneyText('$1,200')).toEqual([{ text: '$1,200', money: true }])
  })
})

describe('equity wording', () => {
  it('writes cliff sentences without pronouns', () => {
    expect(cliffSentence('Sofia', 12, '2027-01-12', 10_000)).toBe('Sofia reaches the 1-year cliff Tue, Jan 12: 10,000 options vest.')
    expect(cliffSentence('Aisha', 12, '2027-09-08', 3_000, true)).toContain('once the board approves the grant')
    expect(cliffSentence('Lin', 6, '2027-01-12', 500)).toContain('6-month cliff')
  })
  it('counts down to the cliff', () => {
    expect(cliffCountdown('2026-11-01', 48, '2026-10-09')).toBe('Cliff in 23 days (Nov 1, 2026), then 1/48 vests monthly')
    expect(cliffCountdown('2026-10-10', 48, '2026-10-09')).toMatch(/^Cliff tomorrow/)
    expect(cliffCountdown('2026-10-09', 24, '2026-10-09')).toMatch(/^Cliff today .* 1\/24 vests monthly$/)
  })
  it('sums vesting curves across grants', () => {
    const pts = combinedVesting([grant(), grant({ id: 'g2', shares: 12_000, vestingStart: '2027-01-12', cliffMonths: 0 })])
    expect(pts[0]).toEqual({ date: '2026-01-12', vested: 0 })
    // At the first cliff: 12,000 from g1, and g2's start month adds nothing yet.
    expect(pts.find((p) => p.date === '2027-01-12')?.vested).toBe(12_000)
    // One month later: g1 13,000 (13/48) plus g2 250 (1/48).
    expect(pts.find((p) => p.date === '2027-02-12')?.vested).toBe(13_250)
    expect(pts[pts.length - 1].vested).toBe(60_000)
    // No flat repeats.
    for (let i = 1; i < pts.length; i++) expect(pts[i].vested).not.toBe(pts[i - 1].vested)
    expect(combinedVesting([])).toEqual([])
  })
  it('lists yearly vesting milestones', () => {
    const pts = combinedVesting([grant()])
    expect(vestingMilestones(pts, '2026-01-12')).toEqual([
      { date: '2027-01-12', vested: 12_000 },
      { date: '2028-01-12', vested: 24_000 },
      { date: '2029-01-12', vested: 36_000 },
      { date: '2030-01-12', vested: 48_000 },
    ])
  })
})

describe('bands', () => {
  it('validates band edits', () => {
    expect(bandErrors({ min: 100, mid: 120, max: 140, equityMinPct: 0.1, equityMaxPct: 0.2, variablePct: 0 })).toEqual([])
    expect(bandErrors({ min: 150, mid: 120, max: 140, equityMinPct: null, equityMaxPct: null, variablePct: null })).toHaveLength(1)
    expect(bandErrors({ min: null, mid: 120, max: 140, equityMinPct: null, equityMaxPct: null, variablePct: null })[0]).toMatch(/Enter a minimum/)
    expect(bandErrors({ min: 100, mid: 120, max: 140, equityMinPct: 0.3, equityMaxPct: 0.2, variablePct: null })[0]).toMatch(/equity guideline/)
  })
  it('pins each band error to the field to fix', () => {
    const blank = { equityMinPct: null, equityMaxPct: null, variablePct: null }
    expect(bandFieldErrors({ min: 100, mid: 120, max: 140, equityMinPct: 0.1, equityMaxPct: 0.2, variablePct: 0 })).toEqual({})
    expect(Object.keys(bandFieldErrors({ min: null, mid: 120, max: null, ...blank }))).toEqual(['min', 'max'])
    expect(Object.keys(bandFieldErrors({ min: 150, mid: 120, max: 140, ...blank }))).toEqual(['mid'])
    expect(Object.keys(bandFieldErrors({ min: 100, mid: 150, max: 140, ...blank }))).toEqual(['max'])
    expect(Object.keys(bandFieldErrors({ min: 0, mid: 120, max: 140, ...blank }))).toEqual(['min'])
    expect(Object.keys(bandFieldErrors({ min: 100, mid: 120, max: 140, equityMinPct: 0.3, equityMaxPct: 0.2, variablePct: -1 }))).toEqual(['equityMaxPct', 'variablePct'])
    // Every draft bandErrors rejects has a field to focus.
    for (const d of [
      { min: null, mid: null, max: null, ...blank },
      { min: 150, mid: 120, max: 140, ...blank },
      { min: 100, mid: 120, max: 140, equityMinPct: -0.1, equityMaxPct: 0.2, variablePct: null },
    ]) {
      expect(bandErrors(d).length > 0).toBe(Object.keys(bandFieldErrors(d)).length > 0)
    }
  })
  it('finds the next level and the ML premium in the sample', () => {
    const db = buildSampleDB()
    expect(nextLevel(db, 'f-eng', 'lv-l3')?.id).toBe('lv-l4')
    expect(nextLevel(db, 'f-ops', 'lv-l1')?.id).toBe('lv-l2')
    const prem = mlPremium(db)
    expect(prem).not.toBeNull()
    expect(prem?.min).toBeGreaterThan(0)
    expect(prem?.byLevel.map((b) => b.levelId)).toEqual(['lv-l2', 'lv-l3', 'lv-l4'])
  })
  it('lists the people in a band', () => {
    const db = buildSampleDB()
    const names = peopleInBand(db, { familyId: 'f-eng', levelId: 'lv-l4' }, D).map((r) => r.name)
    expect(names).toContain('Tomas Herrera')
    expect(names).toContain('Ravi Subramanian')
  })
})

describe('comp CSV', () => {
  it('has a header and one row per person, with hourly pay shown as both rate and annual base', () => {
    const db = buildSampleDB()
    const rows = compTable(db, D)
    const csv = compTableCSV(db, rows, D)
    const lines = csv.split('\r\n')
    expect(lines[0].startsWith('Name,Title,Level,Department')).toBe(true)
    expect(lines).toHaveLength(rows.length + 1)
    const luis = lines.find((l) => l.startsWith('Luis Ortega'))
    expect(luis).toContain('Hourly,30,37440')
  })
})

describe('board print', () => {
  it('summarizes the sample company', () => {
    const db = buildSampleDB()
    const s = boardSummary(db, D)
    expect(s.headcount).toBe(14)
    expect(s.incoming.map((p) => p.name)).toEqual(['Lucas Ferreira', 'Mei Tanaka'])
    expect(s.openJobs.length).toBeGreaterThan(0)
    expect(s.offersOut.map((o) => o.name)).toContain('Daniel Reyes')
    expect(s.cost.withIncoming).toBeGreaterThan(s.cost.now)
    expect(s.cost.atPlan).toBeGreaterThan(s.cost.withOffers)
    const text = boardText(s)
    expect(text).toContain('Ledgerlark people update')
    expect(text).toContain('Plan:')
    expect(text).not.toContain(String.fromCharCode(0x2014))
    const html = boardHTML(s)
    expect(html).toContain('<svg')
    expect(html).toContain('Headcount plan')
  })
  it('escapes names in the print view', () => {
    const db = buildSampleDB()
    const s = { ...boardSummary(db, D), company: 'A <b>&</b> Co' }
    expect(boardHTML(s)).toContain('A &lt;b&gt;&amp;&lt;/b&gt; Co')
  })
  it('draws an empty chart as nothing', () => {
    expect(stepChartSVG([], [])).toBe('')
    expect(stepChartSVG([{ date: '2026-01-01', value: 3 }], [{ date: '2026-06-01', value: 5 }])).toContain('stroke-dasharray')
  })
})

describe('cliff cards and hiring managers', () => {
  it('writes cliff cards for the next year', () => {
    const db = buildSampleDB()
    const cards = cliffCards(db, D)
    expect(cards[0].text).toBe('Sofia reaches the 1-year cliff Tue, Jan 12: 10,000 options vest.')
    expect(cards.every((c) => c.date >= D)).toBe(true)
  })
  it('picks the department head as hiring manager when employed', () => {
    const db = buildSampleDB()
    expect(hiringManagerForSlot(db, { departmentId: 'd-ai' }, 'p-founder', D)).toBe('p-priya')
    expect(hiringManagerForSlot(db, { departmentId: 'd-none' }, 'p-founder', D)).toBe('p-founder')
  })
})

describe('change defaults', () => {
  it('suggests a title for the new level', async () => {
    const { suggestTitle } = await import('./helpers')
    expect(suggestTitle('Senior software engineer', 'Senior', 'Staff')).toBe('Staff software engineer')
    expect(suggestTitle('Founding engineer', 'Staff', 'Principal')).toBe('Founding engineer')
    expect(suggestTitle('ML engineer, senior', 'Senior', 'Staff')).toBe('ML engineer, staff')
    expect(suggestTitle('Designer', undefined, 'Staff')).toBe('Designer')
  })
  it('proposes a base for each reason', async () => {
    const { proposedBase } = await import('./helpers')
    const band = { min: 210_000, mid: 235_000 }
    expect(proposedBase('promotion', 192_000, band)).toBe(210_000)
    expect(proposedBase('promotion', 205_000, band)).toBe(215_000)
    expect(proposedBase('market', 200_000, band)).toBe(235_000)
    expect(proposedBase('market', 240_000, band)).toBe(247_000)
    expect(proposedBase('merit', 200_000, band)).toBe(208_000)
    expect(proposedBase('title_only', 200_123, band)).toBe(200_123)
  })
})

describe('overtimeStatusText', () => {
  it('names the exemption the way the person overview does', () => {
    expect(overtimeStatusText('exempt', 'computer_professional')).toBe('Exempt (computer professional)')
    expect(overtimeStatusText('exempt')).toBe('Exempt')
    expect(overtimeStatusText('non_exempt', 'executive')).toBe('Non-exempt')
  })
})
