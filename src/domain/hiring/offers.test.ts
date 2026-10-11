import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { Band, DB, Offer } from '@/domain/types'
import {
  approvalRequired,
  approveOffer,
  bandFor,
  bandPosition,
  compaRatio,
  createOffer,
  defaultStartDate,
  exemptCheck,
  expireOffers,
  extendOffer,
  markAccepted,
  markDeclined,
  markSent,
  offerDefaults,
  offerEquitySummary,
  offerExceptions,
  offerLetter,
  rescindOffer,
  submitForApproval,
  updateOffer,
  wageNotice2810_5,
} from './offers'
import { fixtureDB, FRI, person } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

/** A default offer drafted by an admin (Viewing as Admin) unless the test names another drafter. */
function draftOffer(db: DB, appId = 'a-alex', extra: Partial<Offer> = {}): Offer {
  const drafter: Partial<Offer> = extra.draftedById ? {} : { draftedByRole: 'admin' }
  return { ...(offerDefaults(db, appId, FRI) as Offer), id: 'o-1', ...drafter, ...extra }
}

function withOffer(extra: Partial<Offer> = {}): DB {
  return produce(fixtureDB(), (d) => {
    createOffer(d, draftOffer(d as DB, 'a-alex', extra))
  })
}

describe('bands and defaults', () => {
  it('finds the band for a family and level', () => {
    expect(bandFor(fixtureDB(), 'f-eng', 'lv-l3')).toMatchObject({ min: 180_000, mid: 205_000, max: 230_000 })
    expect(bandFor(fixtureDB(), 'f-eng', 'lv-x1')).toBeUndefined()
  })

  it('prefills an offer from the job, band, settings and calendar', () => {
    const o = offerDefaults(fixtureDB(), 'a-alex', FRI)
    expect(o).toMatchObject({
      applicationId: 'a-alex',
      candidateId: 'c-alex',
      jobId: 'j-fullstack',
      version: 1,
      title: 'Senior full-stack engineer',
      levelId: 'lv-l3',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      payType: 'salary',
      salary: 187_000, // desired $187,400 is inside the band, snapped to $1,000
      equityType: 'ISO',
      equityShares: 27_000, // (0.10% + 0.35%) / 2 x 12,000,000
      vestingMonths: 48,
      cliffMonths: 12,
      startDate: '2026-10-26', // first Monday at least 14 days out
      expiresOn: '2026-10-16', // 5 business days
      contingencies: ['background_check', 'i9', 'piia'],
      status: 'draft',
      createdOn: FRI,
    })
  })

  it('uses the band midpoint when desired pay is outside the band or missing', () => {
    const high = produce(fixtureDB(), (d) => {
      d.candidates[0].desiredPay = 250_000
    })
    expect(offerDefaults(high, 'a-alex', FRI).salary).toBe(205_000)
    expect(offerDefaults(fixtureDB(), 'a-chen', FRI).salary).toBe(205_000)
  })

  it('snaps an odd midpoint to $1,000 and equity to 500 shares', () => {
    const db = produce(fixtureDB(), (d) => {
      const b = d.bands.find((x) => x.familyId === 'f-eng' && x.levelId === 'lv-l3') as Band
      b.mid = 207_600
      d.equity.fullyDilutedShares = 11_111_111
      d.jobs[0].backgroundCheck = false
    })
    const o = offerDefaults(db, 'a-chen', FRI)
    expect(o.salary).toBe(208_000)
    expect(o.equityShares).toBe(25_000)
    expect(o.contingencies).toEqual(['i9', 'piia'])
  })

  it('carries variable pay from the band and numbers new versions', () => {
    const db = produce(withOffer(), (d) => {
      const b = d.bands.find((x) => x.familyId === 'f-eng' && x.levelId === 'lv-l3') as Band
      b.variablePct = 0.1
    })
    const o = offerDefaults(db, 'a-alex', FRI)
    expect(o.variablePct).toBe(0.1)
    expect(o.version).toBe(2)
  })

  it('picks the start date Monday, moving off holidays', () => {
    expect(defaultStartDate('2026-10-12')).toBe('2026-10-26') // exactly 14 days, a Monday
    expect(defaultStartDate('2027-01-04', ['2027-01-18'])).toBe('2027-01-19') // MLK Day
  })

  it('places base in the band', () => {
    const band = { min: 180_000, mid: 205_000, max: 230_000 }
    expect(bandPosition(205_000, band)).toBe(0.5)
    expect(bandPosition(180_000, band)).toBe(0)
    expect(bandPosition(240_000, band)).toBeCloseTo(1.2)
    expect(bandPosition(170_000, band)).toBeCloseTo(-0.2)
    expect(compaRatio(225_500, band)).toBeCloseTo(1.1)
  })
})

describe('exceptions and exempt check', () => {
  it('flags pay above band and equity above guideline until a reason is given', () => {
    const db = fixtureDB()
    const o = draftOffer(db, 'a-alex', { salary: 240_000, equityShares: 50_000 })
    const ex = offerExceptions(db, o)
    expect(ex.map((e) => e.field)).toEqual(['salary', 'equity'])
    expect(ex[0].message).toBe('Base of $240,000 is above the band maximum of $230,000. Add an exception reason.')
    expect(ex[1].message).toContain('42,000 options')
    expect(ex.every((e) => !e.resolved)).toBe(true)
    expect(offerExceptions(db, { ...o, exceptionReason: 'Competing offer' }).every((e) => e.resolved)).toBe(true)
    expect(offerExceptions(db, draftOffer(db))).toEqual([])
  })

  it('applies the exempt salary floor at exactly $70,304', () => {
    const db = fixtureDB()
    const base = { flsa: 'exempt' as const, payType: 'salary' as const, familyId: 'f-ops', exemptionBasis: 'administrative' as const }
    expect(exemptCheck(db, { ...base, salary: 70_304 })).toMatchObject({ status: 'ok', mustBeNonExempt: false, messages: [] })
    const low = exemptCheck(db, { ...base, salary: 70_303 })
    expect(low.status).toBe('warn')
    expect(low.mustBeNonExempt).toBe(true)
    expect(low.messages[0]).toContain('$70,304')
    expect(low.messages[1]).toContain('overtime')
    expect(low.messages[1]).toContain('meal and rest breaks')
    expect(low.messages[1]).toContain('time tracking')
  })

  it('applies the computer professional minimums (annual and hourly)', () => {
    const db = fixtureDB()
    const cp = { flsa: 'exempt' as const, familyId: 'f-eng', exemptionBasis: 'computer_professional' as const }
    expect(exemptCheck(db, { ...cp, payType: 'salary', salary: 122_573 }).mustBeNonExempt).toBe(true) // below $122,573.13
    expect(exemptCheck(db, { ...cp, payType: 'salary', salary: 122_574 }).status).toBe('ok')
    expect(exemptCheck(db, { ...cp, payType: 'hourly', hourlyRate: 58.85 }).status).toBe('ok')
    expect(exemptCheck(db, { ...cp, payType: 'hourly', hourlyRate: 58.84 }).mustBeNonExempt).toBe(true)
    // An engineering role with no basis is treated as a computer professional.
    expect(exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 100_000, familyId: 'f-ml' }).mustBeNonExempt).toBe(true)
  })

  it('warns on hourly exempt pay, outside sales and low non-exempt pay', () => {
    const db = fixtureDB()
    expect(exemptCheck(db, { flsa: 'exempt', payType: 'hourly', hourlyRate: 90, exemptionBasis: 'administrative' }).mustBeNonExempt).toBe(true)
    const os = exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 60_000, exemptionBasis: 'outside_sales' })
    expect(os).toMatchObject({ status: 'warn', mustBeNonExempt: false })
    const lowHourly = exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 18, locationId: 'loc-hq' })
    expect(lowHourly.status).toBe('warn')
    expect(lowHourly.messages[0]).toBe('$18.00 an hour is below the $18.45 minimum wage for San Jose HQ.')
    const fine = exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 30, locationId: 'loc-hq' })
    expect(fine.status).toBe('ok')
    expect(fine.messages[0]).toContain('Labor Code 2810.5')
  })
})

describe('equity summary and approval', () => {
  it('shows shares, % fully diluted and the current 409A, with no paper value', () => {
    const s = offerEquitySummary(fixtureDB(), { equityShares: 27_000, equityType: 'ISO', vestingMonths: 48, cliffMonths: 12 }, FRI)
    expect(s).toMatchObject({ shares: 27_000, pctFD: 0.00225, strikeEstimate: 1.15, valuationOn: '2026-03-20', note: 'Strike is set by the board at grant' })
    expect(Object.keys(s)).not.toContain('value')
    expect(offerEquitySummary(fixtureDB(), { equityShares: 1, equityType: 'ISO', vestingMonths: 48, cliffMonths: 12 }, '2025-01-01').strikeEstimate).toBeNull()
  })

  it('routes approval only when a non-admin drafted the offer', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(
        person('p-luis', 'Luis', 'Ortega', { familyId: 'f-ops', departmentId: 'd-ops', levelId: 'lv-l1', title: 'Office and events coordinator' }),
        person('p-gone', 'Gwen', 'Hale', { familyId: 'f-ops', departmentId: 'd-ops', title: 'People operations lead', endDate: '2026-09-30' }),
        person('p-cro', 'Cam', 'Reyes', { familyId: 'f-exec', departmentId: 'd-exec', levelId: 'lv-x1', title: 'Chief revenue officer' }),
      )
    })
    // The Viewing-as role recorded on the offer decides.
    expect(approvalRequired(db, { draftedByRole: 'admin' })).toBe(false)
    expect(approvalRequired(db, { draftedByRole: 'manager', draftedById: 'p-founder' })).toBe(true)
    // Without a role: current founders and people-ops staff only.
    expect(approvalRequired(db, { draftedById: 'p-tomas' }, FRI)).toBe(true)
    expect(approvalRequired(db, { draftedById: 'p-jasmine' }, FRI)).toBe(false)
    expect(approvalRequired(db, { draftedById: 'p-founder' }, FRI)).toBe(false)
    expect(approvalRequired(db, { draftedById: 'p-luis' }, FRI)).toBe(true) // junior ops role
    expect(approvalRequired(db, { draftedById: 'p-cro' }, FRI)).toBe(true) // exec outside people ops
    expect(approvalRequired(db, { draftedById: 'p-gone' }, FRI)).toBe(true) // left on Sep 30
    expect(approvalRequired(db, { draftedById: 'p-gone' }, '2026-09-15')).toBe(false)
    // No drafter on record: route to Admin.
    expect(approvalRequired(db, {})).toBe(true)
  })
})

describe('transitions', () => {
  it('sends an offer: reserves options, moves to Offer and sets a follow-up', () => {
    const db = produce(withOffer(), (d) => {
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: true })
    })
    const o = db.offers[0]
    expect(o).toMatchObject({ status: 'sent', sentOn: FRI })
    expect(db.grants).toHaveLength(1)
    expect(db.grants[0]).toMatchObject({ personId: 'c-alex', holderType: 'candidate', status: 'reserved', shares: 27_000, strikePrice: 1.15, fromOfferId: 'o-1', vestingStart: '2026-10-26' })
    const app = db.applications.find((a) => a.id === 'a-alex')!
    expect(app.stageId).toBe('offer')
    expect(app.nextStep).toEqual({ text: 'Follow up on the offer', dueOn: '2026-10-15', ownerId: 'p-tomas' })
    expect(db.activity.at(-1)?.text).toBe('Sent the offer to Alex Kim, expires Fri Oct 16')
  })

  it('blocks sending until approval and exceptions are handled', () => {
    const needsApproval = withOffer({ draftedById: 'p-tomas' })
    produce(needsApproval, (d) => {
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'This offer needs Admin approval before it goes out.' })
      expect(submitForApproval(d, 'o-1', { date: FRI }).ok).toBe(true)
      expect(approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(true)
    })
    const overBand = withOffer({ salary: 240_000 })
    produce(overBand, (d) => {
      const r = markSent(d, 'o-1', { date: FRI })
      expect(r.ok).toBe(false)
      d.offers[0].exceptionReason = 'Competing offer from a public company'
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(true)
    })
  })

  it('accepting records the conditional offer date and keeps the reservation for Hire', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      expect(markAccepted(d, 'o-1', { date: '2026-10-12' }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'accepted', decidedOn: '2026-10-12' })
    const app = db.applications.find((a) => a.id === 'a-alex')!
    expect(app.conditionalOfferOn).toBe('2026-10-12')
    expect(app.nextStep?.text).toBe('Start the background check')
    expect(db.grants[0].status).toBe('reserved')
  })

  it('declining releases the options and closes the application with the reason', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      markDeclined(d, 'o-1', 'chose_other_offer', { date: '2026-10-13', note: 'Big-tech counteroffer' })
    })
    expect(db.offers[0]).toMatchObject({ status: 'declined', declineReason: 'chose_other_offer', competingNote: 'Big-tech counteroffer' })
    expect(db.grants[0].status).toBe('cancelled')
    expect(db.applications.find((a) => a.id === 'a-alex')).toMatchObject({ status: 'withdrawn', outcomeReason: 'chose_other_offer' })
  })

  it('expires, extends and rescinds', () => {
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
    })
    const notYet = produce(sent, (d) => {
      expect(expireOffers(d, '2026-10-16')).toBe(0)
    })
    expect(notYet.offers[0].status).toBe('sent')
    const expired = produce(sent, (d) => {
      expect(expireOffers(d, '2026-10-17')).toBe(1)
    })
    expect(expired.offers[0].status).toBe('expired')
    expect(expired.offers[0].decidedOn).toBe('2026-10-16') // the expiry date is the decision date
    expect(expired.grants[0].status).toBe('cancelled')
    expect(expired.applications.find((a) => a.id === 'a-alex')?.nextStep?.text).toBe('Offer expired: extend it or close out')
    const extended = produce(expired, (d) => {
      expect(extendOffer(d, 'o-1', '2026-10-21', { date: '2026-10-17' }).ok).toBe(true)
    })
    expect(extended.offers[0]).toMatchObject({ status: 'sent', expiresOn: '2026-10-21' })
    expect(extended.offers[0].decidedOn).toBeUndefined()
    expect(extended.grants.filter((g) => g.status === 'reserved')).toHaveLength(1)
    const rescinded = produce(sent, (d) => {
      rescindOffer(d, 'o-1', { date: '2026-10-12', reason: 'Role eliminated', closeApplication: true })
    })
    expect(rescinded.offers[0].status).toBe('rescinded')
    expect(rescinded.grants[0].status).toBe('cancelled')
    expect(rescinded.applications.find((a) => a.id === 'a-alex')?.status).toBe('rejected')
  })
})

describe('generated documents', () => {
  it('writes an offer letter with the required California terms and no dollar projections', () => {
    const db = withOffer()
    const letter = offerLetter(db, 'o-1')!
    expect(letter.subject).toBe('Your offer from Ledgerlark')
    const t = letter.text
    expect(t).toContain('Ledgerlark, Inc.')
    expect(t).toContain('99 S Almaden Blvd, Suite 410, San Jose, CA 95113')
    expect(t).toContain('reporting to Tomas Herrera, Founding engineer')
    expect(t).toContain('Your start date will be October 26, 2026')
    expect(t).toContain('$187,000 a year')
    expect(t).toContain('This position is exempt')
    expect(t).toContain('Subject to approval by the Board of Directors')
    expect(t).toContain('27,000 shares')
    expect(t).toContain('fully diluted')
    expect(t).toContain('incentive stock option (ISO)')
    expect(t).toContain('fair market value of a share on the date the Board grants the option')
    expect(t).toContain('25% vests after 12 months of service')
    expect(t).toContain('Labor Code 2922')
    expect(t).toContain('Fair Chance Act (Government Code 12952)')
    expect(t).toContain('Labor Code 2870')
    expect(t).toContain('Form I-9')
    expect(t).toContain('Business and Professions Code 16600')
    expect(t).toContain('Labor Code 925')
    expect(t).toContain('October 16, 2026')
    expect(t).toContain('Accepted by Alex Kim')
    expect(t).toContain('Maya Raman')
    expect(t).not.toMatch(/\$5\.83|paper value|worth \$/i)
    expect(t.includes(String.fromCharCode(0x2014))).toBe(false)
    expect(letter.html).toContain('<h2>At-will employment</h2>')
  })

  it('escapes HTML and describes non-exempt hourly pay', () => {
    const db = produce(withOffer({ payType: 'hourly', hourlyRate: 32, salary: undefined, flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, equityShares: 0 }), (d) => {
      d.candidates[0].firstName = '<b>Alex</b>'
    })
    const letter = offerLetter(db, 'o-1')!
    expect(letter.html).toContain('&lt;b&gt;Alex&lt;/b&gt;')
    expect(letter.html).not.toContain('<b>Alex</b>')
    expect(letter.text).toContain('$32.00 an hour')
    expect(letter.text).toContain('non-exempt')
    expect(letter.text).toContain('part-time (about 24 hours a week)')
    expect(letter.text).not.toContain('Equity')
  })

  it('builds the Labor Code 2810.5 notice from an offer', () => {
    const db = withOffer({ payType: 'hourly', hourlyRate: 30, salary: undefined, flsa: 'non_exempt', hoursPerWeek: 24 })
    const n = wageNotice2810_5(db, { offerId: 'o-1' })!
    expect(n.text).toContain('$30.00 per hour (rate by the hour)')
    expect(n.text).toContain('$45.00 per hour (1.5 times')
    expect(n.text).toContain('$60.00 per hour (2 times)')
    expect(n.text).toContain('Regular payday: the 15th and the last day of each month')
    expect(n.text).toContain('Legal name: Ledgerlark, Inc.')
    expect(n.text).toContain('Phone: (408) 555-0100')
    expect(n.text).toContain('Carrier: Golden Poppy Mutual')
    expect(n.text).toContain('Carrier address: 1 Market St, San Francisco, CA 94105')
    expect(n.text).toContain('Carrier phone: (800) 555-0199')
    expect(n.text).toContain('Policy number: WC-2026-118')
    expect(n.text).toContain('paid sick leave')
    expect(n.text).toContain('Santa Clara County within 30 days before your first day of work')
    expect(n.missing).toEqual(['Regular payday (Settings > Company); a default for your pay schedule is shown'])
  })

  it('builds the notice for an existing person from their comp record and lists missing settings', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(person('p-luis', 'Luis', 'Ortega', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt', title: 'Office and events coordinator', startDate: '2026-07-20', familyId: 'f-ops' }))
      d.comp.push({ id: 'cr-1', personId: 'p-luis', effectiveOn: '2026-07-20', payType: 'hourly', hourlyRate: 30, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'hire' })
      delete d.company.workersCompCarrier
      delete d.company.phone
      d.company.regularPayday = 'the 10th and 25th of each month'
    })
    const n = wageNotice2810_5(db, { personId: 'p-luis' })!
    expect(n.text).toContain('Name: Luis Ortega')
    expect(n.text).toContain('$45.00 per hour')
    expect(n.text).toContain('Regular payday: the 10th and 25th of each month')
    expect(n.missing).toEqual([
      "Workers' comp carrier (Settings > Company)",
      "Workers' comp carrier address (Settings > Company)",
      "Workers' comp carrier phone (Settings > Company)",
      'Company phone number (Settings > Company)',
    ])
    expect(n.text).toContain('Carrier address: Not set')
    expect(wageNotice2810_5(db, { personId: 'nobody' })).toBeNull()
  })
})

describe('approval and status guards', () => {
  it('force skips band exceptions only, never approval or missing pay', () => {
    produce(withOffer({ draftedById: 'p-tomas', salary: 240_000 }), (d) => {
      expect(markSent(d, 'o-1', { date: FRI, force: true })).toEqual({ ok: false, reason: 'This offer needs Admin approval before it goes out.' })
      expect(submitForApproval(d, 'o-1', { date: FRI }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'This offer is waiting for Admin approval.' })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(false) // unresolved exception
      expect(markSent(d, 'o-1', { date: FRI, force: true }).ok).toBe(true)
      // A resend of a sent, approved offer is not blocked by approval again.
      expect(markSent(d, 'o-1', { date: '2026-10-12', force: true }).ok).toBe(true)
      d.offers[0].exceptionReason = 'Competing offer'
      expect(markSent(d, 'o-1', { date: '2026-10-13' }).ok).toBe(true)
    })
    produce(withOffer({ salary: undefined }), (d) => {
      expect(markSent(d, 'o-1', { date: FRI, force: true })).toEqual({ ok: false, reason: 'Add the base pay.' })
    })
  })

  it('sends an approved offer back to draft when pay, equity, level or start date change', () => {
    const db = produce(withOffer({ draftedById: 'p-tomas' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(updateOffer(d, 'o-1', { signOnBonus: undefined, title: 'Senior full-stack engineer, platform' }, { date: FRI }).ok).toBe(true)
      expect(d.offers[0].status).toBe('approved') // title only
      expect(updateOffer(d, 'o-1', { salary: 195_000 }, { date: FRI }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'draft', salary: 195_000, title: 'Senior full-stack engineer, platform' })
    expect(db.activity.at(-1)?.text).toBe(
      'Updated the offer for Alex Kim. Pay, equity, level or start date changed, so it is back in draft and needs Admin approval again before it goes out.',
    )
    produce(db, (d) => {
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(false)
      d.offers[0].status = 'sent'
      expect(updateOffer(d, 'o-1', { salary: 200_000 }, { date: FRI })).toEqual({ ok: false, reason: 'This offer has already gone out. Draft a new version to change its terms.' })
    })
  })

  it('accepts only a sent offer', () => {
    produce(withOffer({ draftedById: 'p-tomas' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(markAccepted(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'Mark the offer sent before recording the acceptance.' })
      expect(d.grants).toHaveLength(0)
      markSent(d, 'o-1', { date: FRI })
      expect(markAccepted(d, 'o-1', { date: '2026-10-12' }).ok).toBe(true)
      expect(d.grants[0].status).toBe('reserved')
    })
  })

  it('records a renege after acceptance as a decline and frees the options', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      expect(markDeclined(d, 'o-1', 'chose_other_offer', { date: '2026-10-14' }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'declined', declineReason: 'chose_other_offer', decidedOn: '2026-10-14' })
    expect(db.grants[0].status).toBe('cancelled')
    expect(db.applications.find((a) => a.id === 'a-alex')).toMatchObject({ status: 'withdrawn', outcomeReason: 'chose_other_offer' })
    expect(db.activity.map((a) => a.text)).toContain('Alex Kim backed out after accepting the offer (chose another offer)')
    produce(db, (d) => {
      d.offers[0].status = 'accepted'
      d.offers[0].personId = 'p-alex'
      expect(markDeclined(d, 'o-1', 'other', { date: FRI }).ok).toBe(false)
      expect(rescindOffer(d, 'o-1', { date: FRI, reason: 'x' }).ok).toBe(false)
    })
  })
})

describe('offer letter wording', () => {
  it('uses exempt wording for an hourly computer professional and keeps headings in sentence case', () => {
    const db = withOffer({ payType: 'hourly', hourlyRate: 95, salary: undefined, flsa: 'exempt', exemptionBasis: 'computer_professional' })
    const t = offerLetter(db, 'o-1')!.text
    expect(t).toContain('$95.00 an hour')
    expect(t).toContain('This position is exempt under the computer professional exemption (Labor Code 515.5), which means it is not eligible for overtime.')
    expect(t).not.toContain('non-exempt')
    expect(t).toContain('\nPay and benefits\n----------------\n')
    expect(t).not.toContain('PAY AND BENEFITS')
  })

  it('describes an internship plainly', () => {
    const db = withOffer({ employmentType: 'intern', title: 'Software engineering intern', payType: 'hourly', hourlyRate: 40, salary: undefined, flsa: 'non_exempt' })
    const t = offerLetter(db, 'o-1')!.text
    expect(t).toContain('This is an internship. You will work as Software engineering intern, reporting to Tomas Herrera')
    expect(t).not.toContain('work intern')
  })
})

describe('wage notice details', () => {
  it('says exempt from overtime for an exempt hire and prints no overtime rates', () => {
    const n = wageNotice2810_5(withOffer(), { offerId: 'o-1' })!
    expect(n.text).toContain('Rate of pay: $187,000 per year, paid as a salary\n')
    expect(n.text).toContain('Overtime: Exempt from overtime.')
    expect(n.text).not.toContain('1.5 times')
  })

  it('uses the pay in effect at the start date, not a future raise, and works out sick days from hours', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(person('p-luis', 'Luis', 'Ortega', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt', startDate: '2026-07-20', familyId: 'f-ops' }))
      d.comp.push(
        { id: 'cr-1', personId: 'p-luis', effectiveOn: '2026-07-20', payType: 'hourly', hourlyRate: 30, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'hire' },
        { id: 'cr-2', personId: 'p-luis', effectiveOn: '2027-01-01', payType: 'hourly', hourlyRate: 33, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'merit' },
      )
      const sick = d.timeOffPolicies.find((p) => p.kind === 'sick')
      if (sick) {
        sick.method = 'frontload'
        sick.annualHours = 48
      }
    })
    const atStart = wageNotice2810_5(db, { personId: 'p-luis' })!
    expect(atStart.text).toContain('$30.00 per hour (rate by the hour)')
    expect(atStart.text).toContain('48 hours (6 days) of paid sick leave')
    const change = wageNotice2810_5(db, { personId: 'p-luis', date: '2027-01-01' })!
    expect(change.text).toContain('$33.00 per hour (rate by the hour)')
    const odd = produce(db, (d) => {
      const sick = d.timeOffPolicies.find((p) => p.kind === 'sick')
      if (sick) sick.annualHours = 44
    })
    expect(wageNotice2810_5(odd, { personId: 'p-luis' })!.text).toContain('provides 44 hours of paid sick leave')
  })
})
