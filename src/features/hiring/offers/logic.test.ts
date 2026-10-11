import { describe, expect, it } from 'vitest'
import type { BackgroundCheck, CompRecord, Offer, Person } from '@/domain/types'
import {
  approvalLine,
  backgroundStep,
  bandMeterGeometry,
  bandWords,
  checkCleared,
  contingenciesCleared,
  declineReasonChoices,
  expiryPresets,
  extendOptions,
  groupOffers,
  latestPerApplication,
  peerBases,
  rulesAtThreshold,
  startDatePresets,
  trimPeriod,
} from './logic'

const band = { min: 225_000, mid: 255_000, max: 285_000 }

describe('band meter', () => {
  it('pads the band so nearby outliers still fit, and clamps the rest', () => {
    const g = bandMeterGeometry(band)
    expect(g.at(band.min)).toBeCloseTo(0.12 / 1.24, 5)
    expect(g.at(band.max)).toBeCloseTo(1.12 / 1.24, 5)
    expect(g.at(100_000)).toBe(0)
    expect(g.clipped(100_000)).toBe(true)
    expect(g.at(400_000)).toBe(1)
    expect(g.clipped(260_000)).toBe(false)
  })

  it('describes the position in plain words', () => {
    expect(bandWords(200_000, band)).toBe('Below the band')
    expect(bandWords(230_000, band)).toBe('Low in the band')
    expect(bandWords(262_000, band)).toBe('Mid band')
    expect(bandWords(280_000, band)).toBe('High in the band')
    expect(bandWords(298_000, band)).toBe('Above the band')
  })
})

describe('peers at a level', () => {
  const person = (id: string, extra: Partial<Person> = {}) =>
    ({ id, familyId: 'f-ml', levelId: 'lv-l4', startDate: '2025-01-01', endDate: null, hoursPerWeek: 40, ...extra }) as Person
  const comp = (personId: string, effectiveOn: string, salary: number, levelId = 'lv-l4'): CompRecord =>
    ({ id: `${personId}-${effectiveOn}`, personId, effectiveOn, payType: 'salary', salary, title: 't', levelId, reason: 'hire' }) as CompRecord

  it('uses the comp row in effect and skips other levels, leavers and future hires', () => {
    const people = [person('p1'), person('p2'), person('p3', { endDate: '2026-01-01' }), person('p4', { startDate: '2026-12-01' }), person('p5')]
    const rows = [
      comp('p1', '2025-01-01', 200_000),
      comp('p1', '2026-03-01', 228_000),
      comp('p2', '2025-01-01', 240_000),
      comp('p3', '2025-01-01', 250_000),
      comp('p4', '2026-12-01', 260_000),
      comp('p5', '2025-01-01', 190_000, 'lv-l3'),
    ]
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09')).toEqual([228_000, 240_000])
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09', ['p2'])).toEqual([228_000])
  })

  it('annualizes hourly rows at the person hours', () => {
    const people = [person('p1', { hoursPerWeek: 24 })]
    const rows = [{ ...comp('p1', '2025-01-01', 0), payType: 'hourly', hourlyRate: 30, salary: undefined } as CompRecord]
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09')).toEqual([30 * 24 * 52])
  })
})

describe('dates', () => {
  it('offers Mondays from the default start date', () => {
    const p = startDatePresets('2026-10-26', 3)
    expect(p.map((x) => x.date)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
    expect(p[0].label).toBe('Mon, Oct 26')
    expect(startDatePresets('2026-10-28', 1)[0].date).toBe('2026-11-02')
  })

  it('prefills expiry in business days, skipping holidays', () => {
    const p = expiryPresets('2026-10-09', ['2026-10-12'])
    expect(p[1]).toEqual({ label: '5 business days', date: '2026-10-19' })
    expect(expiryPresets('2026-10-09')[1].date).toBe('2026-10-16')
  })

  it('extends from the later of today and the current expiry', () => {
    expect(extendOptions('2026-10-14', '2026-10-09').map((o) => o.date)).toEqual(['2026-10-16', '2026-10-19', '2026-10-21'])
    expect(extendOptions('2026-10-01', '2026-10-09')[0].date).toBe('2026-10-13')
  })
})

describe('background checks', () => {
  const clear: BackgroundCheck = { status: 'complete', result: 'clear', completedOn: '2026-10-07' }
  const consider: BackgroundCheck = { status: 'complete', result: 'consider', completedOn: '2026-10-07', fairChance: {} }

  it('stays locked until a conditional offer exists', () => {
    expect(backgroundStep(undefined, clear)).toBe('locked')
    expect(backgroundStep('2026-10-05', undefined)).toBe('not_started')
    expect(backgroundStep('2026-10-05', { status: 'consent_sent' })).toBe('consent_sent')
    expect(backgroundStep('2026-10-05', { status: 'in_progress' })).toBe('in_progress')
    expect(backgroundStep('2026-10-05', clear)).toBe('clear')
    expect(backgroundStep('2026-10-05', consider)).toBe('consider')
  })

  it('counts Consider as cleared only after a Proceed decision', () => {
    expect(checkCleared(clear)).toBe(true)
    expect(checkCleared(consider)).toBe(false)
    expect(checkCleared({ ...consider, fairChance: { decision: 'proceed' } })).toBe(true)
    expect(checkCleared({ status: 'in_progress' })).toBe(false)
  })

  it('tells hiring managers only whether contingencies cleared', () => {
    expect(contingenciesCleared({ contingencies: ['i9', 'piia'] })).toBe(true)
    expect(contingenciesCleared({ contingencies: ['background_check', 'i9'] })).toBe(false)
    expect(contingenciesCleared({ contingencies: ['background_check'], backgroundCheck: clear })).toBe(true)
  })
})

describe('offers tab groups', () => {
  const offer = (id: string, appId: string, status: Offer['status'], extra: Partial<Offer> = {}) =>
    ({ id, applicationId: appId, version: 1, status, createdOn: '2026-10-01', expiresOn: '2026-10-20', startDate: '2026-11-02', ...extra }) as Offer

  it('keeps only the latest version per application', () => {
    const list = latestPerApplication([offer('o1', 'a1', 'declined'), offer('o2', 'a1', 'sent', { version: 2 }), offer('o3', 'a2', 'draft')])
    expect(list.map((o) => o.id).sort()).toEqual(['o2', 'o3'])
  })

  it('groups by status and counts older decided offers instead of hiding them silently', () => {
    const people = [{ id: 'p-old', startDate: '2026-03-01' }, { id: 'p-new', startDate: '2026-11-02' }]
    const { groups, earlier } = groupOffers(
      [
        offer('o1', 'a1', 'awaiting_approval'),
        offer('o2', 'a2', 'sent', { expiresOn: '2026-10-14' }),
        offer('o3', 'a3', 'sent', { expiresOn: '2026-10-12' }),
        offer('o4', 'a4', 'accepted', { personId: 'p-old', decidedOn: '2026-02-01' }),
        offer('o5', 'a5', 'accepted', { personId: 'p-new', decidedOn: '2026-10-07' }),
        offer('o6', 'a6', 'accepted', { decidedOn: '2026-10-08' }),
        offer('o7', 'a7', 'declined', { decidedOn: '2026-01-15' }),
        offer('o8', 'a8', 'declined', { decidedOn: '2026-09-30' }),
      ],
      '2026-06-11',
      people,
      '2026-09-09',
    )
    expect(groups.awaiting_approval.map((o) => o.id)).toEqual(['o1'])
    expect(groups.sent.map((o) => o.id)).toEqual(['o3', 'o2'])
    expect(groups.accepted.map((o) => o.id).sort()).toEqual(['o5', 'o6'])
    expect(groups.declined.map((o) => o.id)).toEqual(['o8'])
    expect(earlier).toBe(2)
  })
})

describe('copy helpers', () => {
  it('trims trailing periods so sentences end once', () => {
    expect(trimPeriod('Big-tech counteroffer.')).toBe('Big-tech counteroffer')
    expect(trimPeriod(undefined)).toBe('')
  })

  it('includes a competing offer among decline reasons', () => {
    expect(declineReasonChoices().some((r) => r.label === 'Competing offer' && r.value === 'chose_other_offer')).toBe(true)
  })
})

describe('threshold preview', () => {
  it('lists the rules that switch on at 15 and none at a count with no milestone', () => {
    const at15 = rulesAtThreshold(15)
    expect(at15.length).toBeGreaterThan(0)
    expect(at15.every((r) => r.trigger.kind === 'headcount' && r.trigger.n === 15 && !r.upcoming)).toBe(true)
    expect(rulesAtThreshold(17)).toEqual([])
  })
})

describe('approval line', () => {
  const nameOf = (id: string) => (id === 'p-maya' ? 'Maya Raman' : 'Admin')
  const approved = { approverId: 'p-maya', decision: 'approved' as const, at: '2026-10-10T17:00:00.000Z' }

  it('shows the approval while it stands', () => {
    expect(approvalLine({ status: 'approved', approvals: [approved] }, true, nameOf)).toBe('Approved by Maya Raman, Sat, Oct 10')
    expect(approvalLine({ status: 'sent', approvals: [approved] }, true, nameOf)).toBe('Approved by Maya Raman, Sat, Oct 10')
  })

  it('does not show an old approval on an offer that was edited back to draft or resubmitted', () => {
    expect(approvalLine({ status: 'draft', approvals: [approved] }, true, nameOf)).toBe('Needs Admin approval (changed since the Oct 10 approval)')
    expect(approvalLine({ status: 'awaiting_approval', approvals: [approved] }, true, nameOf)).toBe('Waiting for Admin approval (changed since the Oct 10 approval)')
  })

  it('covers offers that never needed or never had an approval', () => {
    expect(approvalLine({ status: 'draft', approvals: [] }, true, nameOf)).toBe('Needs Admin approval')
    expect(approvalLine({ status: 'awaiting_approval', approvals: [] }, true, nameOf)).toBe('Waiting for Admin approval')
    expect(approvalLine({ status: 'draft', approvals: [] }, false, nameOf)).toBe('Drafted by Admin, no separate approval')
    expect(approvalLine({ status: 'sent', approvals: [] }, true, nameOf)).toBe('No approval on record')
  })
})
