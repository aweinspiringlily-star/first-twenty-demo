// Offer builder logic: band defaults, position in band, exceptions, the California exempt check,
// equity summary (no paper value), approval routing, status transitions, the printable offer letter
// and the Labor Code 2810.5 wage notice.
//
// Grants: sending an offer reserves its options (a 'reserved' grant held by the candidate). Decline,
// expiry and rescission cancel the reservation. Accepting leaves the reservation in place; the Hire
// flow (src/domain/lifecycle.ts hireFromOffer) converts it into the employee's promised grant.
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { LAW_SOURCES } from '@/data/law'
import { current409A, pctOfFullyDiluted } from '@/domain/equity'
import { founder, getPerson, isEmployedOn, personNameById } from '@/domain/people'
import type {
  Band,
  DB,
  EquityGrant,
  ExemptionBasis,
  FLSA,
  ID,
  Job,
  Offer,
  OutcomeReason,
} from '@/domain/types'
import { addBusinessDays, addDays, type ISODate, type ISODateTime } from '@/lib/dates'
import { escapeHTML } from '@/lib/files'
import { money, money2, num, pct } from '@/lib/format'
import { newId } from '@/lib/id'
import { firstStageOfKind, moveApplication, ownerFor, rejectApplication, stageKind, withdrawApplication } from './pipeline'
import {
  businessDayOnOrAfter,
  businessDayOnOrBefore,
  cancelReservedGrants,
  candidateName,
  dbHolidays,
  fmtDayPlain,
  fmtLong,
  isOutcomeReason,
  mondayOnOrAfter,
  outcomeReasonLabel,
  snapTo,
  vestingText,
} from './util'
import { logActivity } from '@/store/draft'

export type OfferResult = { ok: true } | { ok: false; reason: string }

// ---- Bands and defaults ---------------------------------------------------------------------

export function bandFor(db: Pick<DB, 'bands'>, familyId: ID, levelId: ID): Band | undefined {
  return db.bands.find((b) => b.familyId === familyId && b.levelId === levelId)
}

/** The level band, or a band built from the job's posted range when the level has none. */
export function effectiveBand(db: Pick<DB, 'bands'>, familyId: ID, levelId: ID, job?: Job): Band | undefined {
  const band = bandFor(db, familyId, levelId)
  if (band) return band
  if (job && job.payMin != null && job.payMax != null) {
    return {
      id: `job-${job.id}`,
      familyId,
      levelId,
      min: job.payMin,
      max: job.payMax,
      mid: snapTo((job.payMin + job.payMax) / 2, 1000),
      equityMinPct: job.equityMinPct ?? 0,
      equityMaxPct: job.equityMaxPct ?? 0,
    }
  }
  return undefined
}

/** Likely exemption for a family and level (a starting point; the offer builder lets you change it). */
export function defaultExemptionBasis(familyId: ID, levelId: ID): ExemptionBasis {
  if (familyId === 'f-exec' || levelId === 'lv-m1' || levelId === 'lv-m2' || levelId === 'lv-x1') return 'executive'
  if (familyId === 'f-eng' || familyId === 'f-ml') return 'computer_professional'
  if (familyId === 'f-acct') return 'professional'
  return 'administrative'
}

/** Start date default: the first Monday at least 14 days out (next business day if it is a holiday). */
export function defaultStartDate(date: ISODate, holidays: ISODate[] = []): ISODate {
  return businessDayOnOrAfter(mondayOnOrAfter(addDays(date, 14)), holidays)
}

/**
 * Prefilled offer for an application. Base is the candidate's desired pay when it sits inside the
 * band, else the band midpoint, snapped to $1,000. Equity is the midpoint of the level guideline x
 * fully diluted shares, rounded to 500. Expiry is settings.offerExpiryBusinessDays business days out.
 */
export function offerDefaults(db: DB, applicationId: ID, date: ISODate): Partial<Offer> {
  const app = db.applications.find((a) => a.id === applicationId)
  if (!app) return {}
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!job) return {}
  const cand = db.candidates.find((c) => c.id === app.candidateId)
  const holidays = dbHolidays(db)
  const band = effectiveBand(db, job.familyId, job.levelId, job)
  const flsa: FLSA = job.flsa
  const hourly = flsa === 'non_exempt' && job.employmentType !== 'full_time'
  let base: number | undefined
  if (band) {
    const desired = cand?.desiredPay
    base = desired != null && desired >= band.min && desired <= band.max ? snapTo(desired, 1000) : snapTo(band.mid, 1000)
  } else if (cand?.desiredPay != null) {
    base = snapTo(cand.desiredPay, 1000)
  }
  const midPct = band ? (band.equityMinPct + band.equityMaxPct) / 2 : ((job.equityMinPct ?? 0) + (job.equityMaxPct ?? 0)) / 2
  const equityShares = snapTo(midPct * db.equity.fullyDilutedShares, 500)
  const contingencies: Offer['contingencies'] = job.backgroundCheck ? ['background_check', 'i9', 'piia'] : ['i9', 'piia']
  const version = Math.max(0, ...db.offers.filter((o) => o.applicationId === app.id).map((o) => o.version)) + 1
  const out: Partial<Offer> = {
    applicationId: app.id,
    candidateId: app.candidateId,
    jobId: job.id,
    version,
    title: job.title,
    levelId: job.levelId,
    familyId: job.familyId,
    departmentId: job.departmentId,
    managerId: job.hiringManagerId,
    locationId: job.locationIds[0] ?? db.locations[0]?.id ?? '',
    workMode: job.workMode,
    employmentType: job.employmentType,
    hoursPerWeek: job.employmentType === 'part_time' ? 20 : 40,
    flsa,
    payType: hourly ? 'hourly' : 'salary',
    equityType: 'ISO',
    equityShares,
    vestingMonths: db.settings.defaultVestingMonths,
    cliffMonths: db.settings.defaultCliffMonths,
    startDate: defaultStartDate(date, holidays),
    expiresOn: addBusinessDays(date, db.settings.offerExpiryBusinessDays, holidays),
    contingencies,
    status: 'draft',
    createdOn: date,
    approvals: [],
  }
  if (flsa === 'exempt') out.exemptionBasis = defaultExemptionBasis(job.familyId, job.levelId)
  if (hourly && base != null) out.hourlyRate = snapTo(base / 2080, 0.25)
  else if (base != null) out.salary = base
  if (band?.variablePct != null) out.variablePct = band.variablePct
  return out
}

/** Annual base for band comparisons (hourly rates annualized at 2,080 hours, full-time equivalent). */
export function annualizedBase(offer: Pick<Offer, 'payType' | 'salary' | 'hourlyRate'>): number {
  if (offer.payType === 'hourly') return Math.round((offer.hourlyRate ?? 0) * 2080)
  return offer.salary ?? 0
}

/** 0 = band minimum, 1 = band maximum; may fall outside 0..1. */
export function bandPosition(base: number, band: Pick<Band, 'min' | 'max'>): number {
  if (band.max === band.min) return base >= band.max ? 1 : 0
  return (base - band.min) / (band.max - band.min)
}

/** Base divided by the band midpoint (1.0 = at mid). */
export function compaRatio(base: number, band: Pick<Band, 'mid'>): number {
  return band.mid > 0 ? base / band.mid : 0
}

export type OfferException = { field: 'salary' | 'equity'; message: string; resolved: boolean }

/** Pay above the band maximum or equity above the guideline maximum needs an exception reason. */
export function offerExceptions(db: DB, offer: Offer): OfferException[] {
  const job = db.jobs.find((j) => j.id === offer.jobId)
  const band = effectiveBand(db, offer.familyId, offer.levelId, job)
  if (!band) return []
  const resolved = !!offer.exceptionReason?.trim()
  const out: OfferException[] = []
  const base = annualizedBase(offer)
  if (base > band.max) {
    const what = offer.payType === 'hourly' ? `${money2(offer.hourlyRate)} an hour (${money(base)} a year)` : money(base)
    out.push({ field: 'salary', message: `Base of ${what} is above the band maximum of ${money(band.max)}. Add an exception reason.`, resolved })
  }
  const fd = db.equity.fullyDilutedShares
  if (band.equityMaxPct > 0 && fd > 0 && offer.equityShares > Math.round(band.equityMaxPct * fd)) {
    const maxShares = Math.round(band.equityMaxPct * fd)
    out.push({
      field: 'equity',
      message: `${num(offer.equityShares)} options (${pct(offer.equityShares / fd)} of fully diluted) is above the guideline maximum of ${pct(band.equityMaxPct)} (${num(maxShares)} options). Add an exception reason.`,
      resolved,
    })
  }
  return out
}

// ---- Exempt check ---------------------------------------------------------------------------

export type ExemptCheckInput = {
  flsa: FLSA
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  familyId?: ID
  exemptionBasis?: ExemptionBasis
  hoursPerWeek?: number
  /** For the minimum wage check on non-exempt pay, and the work state (from the location's state). */
  locationId?: ID
  /** Work state (two letters) when it differs from the location's, e.g. a person's home state. */
  state?: string
}

export type ExemptCheck = {
  status: 'ok' | 'warn'
  /** True when the pay cannot support an exemption, so the role must be non-exempt. */
  mustBeNonExempt: boolean
  messages: string[]
  citations: Array<{ label: string; url: string }>
}

function nonExemptDuties(): string {
  return 'A non-exempt role earns overtime after 8 hours in a day or 40 in a week, gets meal and rest breaks, and needs time tracking. Give the Labor Code 2810.5 wage notice by the start date.'
}

/** Outside California: federal overtime after 40 hours a week; state rules vary. */
function nonExemptDutiesElsewhere(state: string): string {
  return `A non-exempt role earns overtime after 40 hours in a week (federal law) and needs time tracking. Check ${state}'s rules for daily overtime, breaks and pay notices.`
}

const FEDERAL_SOURCES = {
  overtime: { label: 'DOL overtime pay', url: 'https://www.dol.gov/agencies/whd/overtime' },
  minWage: { label: 'DOL minimum wage', url: 'https://www.dol.gov/agencies/whd/minimum-wage' },
}

/**
 * California exempt check against the yearly values in settings.law: the exempt salary floor
 * (2 x state minimum wage x 2,080) and the computer professional minimums (Labor Code 515.5).
 * The work state comes from the location (or input.state): California floors, daily overtime, breaks
 * and the 2810.5 notice apply only to work in California, the same rule as pay.ts exemptCheck.
 * Elsewhere the minimum wage is the location's (the federal $7.25 floor for Texas).
 * Duties tests still apply; this checks pay only. Not legal advice.
 */
export function exemptCheck(db: Pick<DB, 'settings' | 'locations'>, input: ExemptCheckInput): ExemptCheck {
  const law = db.settings.law
  const messages: string[] = []
  const citations: ExemptCheck['citations'] = []
  let must = false
  const loc = db.locations.find((l) => l.id === input.locationId)
  const state = (input.state || loc?.state || 'CA').toUpperCase()
  const inCA = state === 'CA'
  if (input.flsa === 'exempt') {
    const engineering = input.familyId === 'f-eng' || input.familyId === 'f-ml'
    const basis = input.exemptionBasis ?? (engineering ? 'computer_professional' : undefined)
    if (!inCA && basis !== 'outside_sales') {
      if (input.payType === 'hourly' && basis !== 'computer_professional') {
        must = true
        citations.push(FEDERAL_SOURCES.overtime)
        messages.push('Exempt roles must be paid a salary, not by the hour (computer professionals are the exception). Switch to a salary or classify the role non-exempt.')
        messages.push(nonExemptDutiesElsewhere(state))
        return { status: 'warn', mustBeNonExempt: true, messages, citations }
      }
      citations.push(FEDERAL_SOURCES.overtime)
      messages.push(`California exempt minimums apply only to work in California. Check ${state}'s rules and the federal salary test.`)
      return { status: 'ok', mustBeNonExempt: false, messages, citations }
    }
    if (basis === 'outside_sales') {
      messages.push(
        'The outside sales exemption covers only people who spend more than half their working time away from the office making sales. Inside or remote sales roles do not qualify; use another exemption that truly applies, or classify the role non-exempt.',
      )
      citations.push(LAW_SOURCES.overtime)
    } else if (basis === 'computer_professional') {
      citations.push(LAW_SOURCES.computerPro)
      if (input.payType === 'hourly') {
        if ((input.hourlyRate ?? 0) < law.computerProHourly) {
          must = true
          messages.push(
            `${money2(input.hourlyRate ?? 0)} an hour is below the ${money2(law.computerProHourly)} hourly minimum for the computer professional exemption in ${law.year} (Labor Code 515.5). Classify this role non-exempt.`,
          )
        }
      } else if ((input.salary ?? 0) < law.computerProAnnual) {
        must = true
        messages.push(
          `${money(input.salary ?? 0)} is below the ${money2(law.computerProAnnual)} annual minimum for the computer professional exemption in ${law.year} (Labor Code 515.5). Classify this role non-exempt unless another exemption truly applies.`,
        )
      }
    } else if (input.payType === 'hourly') {
      must = true
      citations.push(LAW_SOURCES.exemptSalary)
      messages.push('Exempt roles must be paid a salary, not by the hour (computer professionals are the exception). Switch to a salary or classify the role non-exempt.')
    } else if ((input.salary ?? 0) < law.exemptSalaryMin) {
      must = true
      citations.push(LAW_SOURCES.exemptSalary)
      messages.push(
        `${money(input.salary ?? 0)} is below the California exempt salary floor of ${money(law.exemptSalaryMin)} for ${law.year} (2 x the ${money2(law.caMinWageHourly)} state minimum wage x 2,080 hours). This role must be non-exempt.`,
      )
    }
    if (must) {
      messages.push(nonExemptDuties())
      citations.push(LAW_SOURCES.overtime, LAW_SOURCES.mealPeriods, LAW_SOURCES.restPeriods)
    }
    return { status: messages.length ? 'warn' : 'ok', mustBeNonExempt: must, messages, citations }
  }
  // Non-exempt: remind the rules, and check the minimum wage where the person works.
  if (inCA) {
    messages.push(nonExemptDuties())
    citations.push(LAW_SOURCES.overtime, LAW_SOURCES.mealPeriods, LAW_SOURCES.restPeriods, LAW_SOURCES.wtpa)
  } else {
    messages.push(nonExemptDutiesElsewhere(state))
    citations.push(FEDERAL_SOURCES.overtime)
  }
  // California's state floor applies only in California; elsewhere the location's rate (at least the federal $7.25).
  const minWage = inCA ? Math.max(law.caMinWageHourly, loc?.minWageHourly ?? 0) : Math.max(7.25, loc?.minWageHourly ?? 0)
  const hours = input.hoursPerWeek && input.hoursPerWeek > 0 ? input.hoursPerWeek : 40
  const rateNow = input.payType === 'hourly' ? (input.hourlyRate ?? 0) : (input.salary ?? 0) / 52 / hours
  let warn = false
  if (rateNow > 0 && rateNow < minWage) {
    warn = true
    messages.unshift(`${money2(rateNow)} an hour is below the ${money2(minWage)} minimum wage${loc ? ` for ${loc.name}` : inCA ? ' in California' : ` in ${state}`}.`)
    citations.push(inCA ? LAW_SOURCES.caMinWage : FEDERAL_SOURCES.minWage)
  }
  return { status: warn ? 'warn' : 'ok', mustBeNonExempt: false, messages, citations }
}

// ---- Equity and approval --------------------------------------------------------------------

export type OfferEquitySummary = {
  shares: number
  type: Offer['equityType']
  /** Fraction of fully diluted shares (0.0025 = 0.25%). */
  pctFD: number
  /** Internal estimate: the current 409A price. The board sets the strike at grant. */
  strikeEstimate: number | null
  valuationOn?: ISODate
  vesting: string
  note: string
}

/** Shares, % fully diluted and a strike estimate at the current 409A. No paper value or preferred price. */
export function offerEquitySummary(db: DB, offer: Pick<Offer, 'equityShares' | 'equityType' | 'vestingMonths' | 'cliffMonths'>, date: ISODate): OfferEquitySummary {
  const v = current409A(db, date)
  return {
    shares: offer.equityShares,
    type: offer.equityType,
    pctFD: pctOfFullyDiluted(db, offer.equityShares),
    strikeEstimate: v ? v.fmvPerShare : null,
    ...(v ? { valuationOn: v.effectiveOn } : {}),
    vesting: vestingText(offer.vestingMonths, offer.cliffMonths),
    note: 'Strike is set by the board at grant',
  }
}

/**
 * Fallback for offers that carry no draftedByRole: the founder, or a people-ops staffer (f-ops at
 * L3 or above, or a manager level), who still works here on the date. Executives outside people ops
 * and junior ops roles (an office coordinator) are not admins.
 */
export function isAdminPerson(db: Pick<DB, 'people'>, personId: ID | null | undefined, date?: ISODate): boolean {
  const p = getPerson(db as DB, personId)
  if (!p) return false
  const current = date ? isEmployedOn(p, date) : !p.endDate
  if (!current) return false
  if (p.isFounder) return true
  return p.familyId === 'f-ops' && p.levelId !== 'lv-l1' && p.levelId !== 'lv-l2'
}

/**
 * Approval routes to Admin unless an admin drafted the offer. The drafter's Viewing-as role
 * (draftedByRole) decides when it is recorded; otherwise the drafter must be a current founder or
 * people-ops staffer (isAdminPerson). An offer with no drafter on record needs approval.
 */
export function approvalRequired(
  db: Pick<DB, 'people'>,
  offer: Pick<Offer, 'draftedById'> & Partial<Pick<Offer, 'draftedByRole' | 'createdOn'>>,
  date?: ISODate,
): boolean {
  if (offer.draftedByRole) return offer.draftedByRole !== 'admin'
  if (!offer.draftedById) return true
  return !isAdminPerson(db, offer.draftedById, date ?? offer.createdOn)
}

/** An approval that still stands: approved, or approved and already sent (a resend). */
function approvalSatisfied(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'approved' || offer.status === 'sent'
}

export type SendBlocker = { kind: 'pay' | 'approval' | 'exception'; message: string }

/** Why an offer cannot be sent yet, by kind (missing pay, approval, unresolved exceptions). */
export function sendBlockerList(db: DB, offer: Offer, date?: ISODate): SendBlocker[] {
  const out: SendBlocker[] = []
  if (offer.payType === 'salary' ? !offer.salary : !offer.hourlyRate) out.push({ kind: 'pay', message: 'Add the base pay.' })
  if (approvalRequired(db, offer, date) && !approvalSatisfied(offer)) {
    out.push({ kind: 'approval', message: 'This offer needs Admin approval before it goes out.' })
  }
  for (const e of offerExceptions(db, offer)) if (!e.resolved) out.push({ kind: 'exception', message: e.message })
  return out
}

/** Reasons an offer cannot be sent yet (approval, unresolved exceptions, missing pay). */
export function sendBlockers(db: DB, offer: Offer, date?: ISODate): string[] {
  return sendBlockerList(db, offer, date).map((b) => b.message)
}

// ---- Transitions ----------------------------------------------------------------------------

function findOffer(draft: Draft<DB>, offerId: ID) {
  return draft.offers.find((o) => o.id === offerId)
}

function logOffer(draft: Draft<DB>, offer: { id: ID; candidateId: ID }, kind: string, text: string): void {
  logActivity(draft, { entityType: 'offer', entityId: offer.id, relatedId: offer.candidateId, kind, text })
}

/**
 * Adds a drafted offer (from offerDefaults plus edits) to the workspace. Returns its id. Set
 * draftedById and draftedByRole (the Viewing-as role) so approval routing knows whether an admin
 * drafted it; an offer with no drafter on record routes to Admin.
 */
export function createOffer(draft: Draft<DB>, offer: Omit<Offer, 'id'> & { id?: ID }): ID {
  const id = offer.id ?? newId('o')
  draft.offers.push({ ...offer, id } as Offer)
  logOffer(draft, { id, candidateId: offer.candidateId }, 'offer_drafted', `Drafted an offer for ${candidateName(draft, offer.candidateId)}`)
  return id
}

/** Offer fields the builder can edit before the offer goes out. */
export type OfferPatch = Partial<
  Omit<
    Offer,
    | 'id'
    | 'applicationId'
    | 'candidateId'
    | 'jobId'
    | 'version'
    | 'status'
    | 'createdOn'
    | 'draftedById'
    | 'draftedByRole'
    | 'approvals'
    | 'sentOn'
    | 'decidedOn'
    | 'declineReason'
    | 'competingNote'
    | 'backgroundCheck'
    | 'personId'
  >
>

/** Changes to these fields void an approval: the offer goes back to draft. */
export function approvalSensitiveFields(): Array<keyof OfferPatch> {
  return ['salary', 'hourlyRate', 'payType', 'variablePct', 'signOnBonus', 'equityShares', 'equityType', 'vestingMonths', 'cliffMonths', 'levelId', 'familyId', 'startDate']
}

/**
 * Edits an offer that has not gone out (draft, awaiting approval or approved). An approved offer whose
 * pay, equity, level or start date changes goes back to draft, so the approval always matches the
 * terms that are sent. Fields set to undefined are cleared.
 */
export function updateOffer(draft: Draft<DB>, offerId: ID, patch: OfferPatch, opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'draft' && offer.status !== 'awaiting_approval' && offer.status !== 'approved') {
    return { ok: false, reason: 'This offer has already gone out. Draft a new version to change its terms.' }
  }
  const sensitive = new Set<string>(approvalSensitiveFields())
  let material = false
  const target = offer as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const before = target[key]
    if (value === undefined) delete target[key]
    else target[key] = value
    if (sensitive.has(key) && before !== value) material = true
  }
  const name = candidateName(draft, offer.candidateId)
  if (material && offer.status === 'approved') {
    offer.status = 'draft'
    const again = approvalRequired(draft, offer, opts.date) ? ' and needs Admin approval again before it goes out' : ''
    logOffer(draft, offer, 'offer_updated', `Updated the offer for ${name}. Pay, equity, level or start date changed, so it is back in draft${again}.`)
  } else {
    logOffer(draft, offer, 'offer_updated', `Updated the offer for ${name}`)
  }
  return { ok: true }
}

export function submitForApproval(draft: Draft<DB>, offerId: ID, _opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'draft') return { ok: false, reason: 'Only a draft can be sent for approval.' }
  offer.status = 'awaiting_approval'
  logOffer(draft, offer, 'offer_submitted', `Sent the offer for ${candidateName(draft, offer.candidateId)} for approval`)
  return { ok: true }
}

export function approveOffer(draft: Draft<DB>, offerId: ID, opts: { approverId: ID; at: ISODateTime; note?: string }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'awaiting_approval' && offer.status !== 'draft') return { ok: false, reason: 'This offer is not waiting for approval.' }
  offer.approvals.push({ approverId: opts.approverId, decision: 'approved', at: opts.at, ...(opts.note ? { note: opts.note } : {}) })
  offer.status = 'approved'
  logOffer(draft, offer, 'offer_approved', `${personNameById(draft, opts.approverId, 'Admin')} approved the offer for ${candidateName(draft, offer.candidateId)}`)
  return { ok: true }
}

export function requestOfferChanges(draft: Draft<DB>, offerId: ID, opts: { approverId: ID; at: ISODateTime; note: string }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'awaiting_approval') return { ok: false, reason: 'This offer is not waiting for approval.' }
  offer.approvals.push({ approverId: opts.approverId, decision: 'changes_requested', at: opts.at, note: opts.note })
  offer.status = 'draft'
  logOffer(draft, offer, 'offer_changes_requested', `${personNameById(draft, opts.approverId, 'Admin')} asked for changes to the offer for ${candidateName(draft, offer.candidateId)}`)
  return { ok: true }
}

/** Creates (or updates) the 'reserved' grant that holds an outstanding offer's options. */
export function reserveOfferGrant(draft: Draft<DB>, offer: Offer, date: ISODate): EquityGrant | undefined {
  if (offer.equityShares <= 0) {
    cancelReservedGrants(draft, offer.id, date)
    return undefined
  }
  const existing = draft.grants.find((g) => g.fromOfferId === offer.id && g.status === 'reserved')
  const strike = current409A(draft, date)?.fmvPerShare ?? 0
  if (existing) {
    existing.shares = offer.equityShares
    existing.type = offer.equityType
    existing.vestingStart = offer.startDate
    existing.cliffMonths = offer.cliffMonths
    existing.vestingMonths = offer.vestingMonths
    existing.strikePrice = strike
    return existing
  }
  const grant: EquityGrant = {
    id: newId('g'),
    personId: offer.candidateId,
    holderType: 'candidate',
    type: offer.equityType,
    shares: offer.equityShares,
    strikePrice: strike,
    vestingStart: offer.startDate,
    cliffMonths: offer.cliffMonths,
    vestingMonths: offer.vestingMonths,
    status: 'reserved',
    proposedOn: date,
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    fromOfferId: offer.id,
    note: 'Reserved by an outstanding offer. Strike is set by the board at grant.',
  }
  draft.grants.push(grant)
  return grant
}

/**
 * Marks the offer sent: reserves its options, moves the application to the Offer stage if needed,
 * and sets the next step to follow up before the expiry date. `force` sends despite unresolved
 * band exceptions only; it never skips Admin approval or missing pay.
 */
export function markSent(draft: Draft<DB>, offerId: ID, opts: { date: ISODate; force?: boolean }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'awaiting_approval') return { ok: false, reason: 'This offer is waiting for Admin approval.' }
  if (offer.status !== 'draft' && offer.status !== 'approved' && offer.status !== 'sent') {
    return { ok: false, reason: 'This offer has already been decided.' }
  }
  const blockers = sendBlockerList(draft, offer, opts.date).filter((b) => !(opts.force && b.kind === 'exception'))
  if (blockers.length) return { ok: false, reason: blockers[0].message }
  offer.status = 'sent'
  offer.sentOn = opts.date
  reserveOfferGrant(draft, offer, opts.date)
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  if (app && job) {
    const offerStage = firstStageOfKind(job, 'offer')
    if (offerStage && stageKind(job, app.stageId) !== 'offer') moveApplication(draft, app.id, offerStage.id, { date: opts.date })
    const holidays = dbHolidays(draft)
    const followUp = businessDayOnOrBefore(addBusinessDays(offer.expiresOn, -1, holidays), holidays)
    app.lastContactOn = opts.date
    app.nextStep = { text: 'Follow up on the offer', dueOn: followUp < opts.date ? offer.expiresOn : followUp, ownerId: ownerFor(draft, job, opts.date) }
  }
  logOffer(draft, offer, 'offer_sent', `Sent the offer to ${candidateName(draft, offer.candidateId)}, expires ${fmtDayPlain(offer.expiresOn)}`)
  return { ok: true }
}

/**
 * The candidate accepted a sent offer: records the conditional offer date on the application, which
 * unlocks the background check and criminal-history steps (Fair Chance Act). Only a sent offer can be
 * accepted, so its options are already reserved. Hire happens in lifecycle.ts.
 */
export function markAccepted(draft: Draft<DB>, offerId: ID, opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'approved' || offer.status === 'draft') return { ok: false, reason: 'Mark the offer sent before recording the acceptance.' }
  if (offer.status !== 'sent') return { ok: false, reason: 'Only an offer that is out can be accepted.' }
  offer.status = 'accepted'
  offer.decidedOn = opts.date
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  if (app) {
    app.conditionalOfferOn = opts.date
    app.lastContactOn = opts.date
    const holidays = dbHolidays(draft)
    const text = offer.contingencies.includes('background_check') ? 'Start the background check' : 'Hire and start onboarding'
    app.nextStep = { text, dueOn: addBusinessDays(opts.date, 1, holidays), ownerId: ownerFor(draft, job, opts.date) }
  }
  logOffer(draft, offer, 'offer_accepted', `${candidateName(draft, offer.candidateId)} accepted the offer`)
  return { ok: true }
}

/**
 * The candidate declined (or backed out after accepting, before the hire was recorded). Cancels the
 * reserved options and, by default, closes the application as withdrawn with the matching reason.
 */
export function markDeclined(
  draft: Draft<DB>,
  offerId: ID,
  reason: string,
  opts: { date: ISODate; note?: string; closeApplication?: boolean; outcomeReason?: OutcomeReason },
): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'accepted' && offer.personId) return { ok: false, reason: 'This offer is already a hire. Record the departure from the profile instead.' }
  const reneging = offer.status === 'accepted'
  if (offer.status !== 'sent' && offer.status !== 'approved' && offer.status !== 'expired' && !reneging) return { ok: false, reason: 'Only an offer that is out can be declined.' }
  offer.status = 'declined'
  offer.decidedOn = opts.date
  offer.declineReason = reason
  if (opts.note) offer.competingNote = opts.note
  cancelReservedGrants(draft, offer.id, opts.date)
  const name = candidateName(draft, offer.candidateId)
  const why = outcomeReasonLabel(reason).toLowerCase()
  logOffer(draft, offer, 'offer_declined', reneging ? `${name} backed out after accepting the offer (${why})` : `${name} declined the offer (${why})`)
  if (opts.closeApplication ?? true) {
    const outcome = opts.outcomeReason ?? (isOutcomeReason(reason) ? reason : 'other')
    withdrawApplication(draft, offer.applicationId, outcome, { date: opts.date, ...(opts.note ? { note: opts.note } : {}) })
  }
  return { ok: true }
}

/** Withdraws an offer (for example after the Fair Chance process). Optionally closes the application. */
export function rescindOffer(
  draft: Draft<DB>,
  offerId: ID,
  opts: { date: ISODate; reason: string; closeApplication?: boolean },
): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'declined' || offer.status === 'rescinded') return { ok: false, reason: 'This offer is already closed.' }
  if (offer.personId) return { ok: false, reason: 'This offer is already a hire. Record the departure from the profile instead.' }
  offer.status = 'rescinded'
  offer.decidedOn = opts.date
  cancelReservedGrants(draft, offer.id, opts.date)
  logOffer(draft, offer, 'offer_rescinded', `Rescinded the offer for ${candidateName(draft, offer.candidateId)}: ${opts.reason}`)
  if (opts.closeApplication) rejectApplication(draft, offer.applicationId, 'other', { date: opts.date, note: opts.reason })
  return { ok: true }
}

/**
 * Marks sent offers past their expiry date as expired and releases their options. The expiry date is
 * the decision date, so lapsed offers count against offer acceptance. Returns the count.
 */
export function expireOffers(draft: Draft<DB>, date: ISODate): number {
  let n = 0
  for (const offer of draft.offers) {
    if (offer.status !== 'sent' || !offer.expiresOn || offer.expiresOn >= date) continue
    offer.status = 'expired'
    offer.decidedOn = offer.expiresOn
    cancelReservedGrants(draft, offer.id, date)
    const app = draft.applications.find((a) => a.id === offer.applicationId)
    if (app && app.status === 'active') {
      const job = draft.jobs.find((j) => j.id === offer.jobId)
      app.nextStep = { text: 'Offer expired: extend it or close out', dueOn: date, ownerId: ownerFor(draft, job, date, app.nextStep?.ownerId) }
    }
    logOffer(draft, offer, 'offer_expired', `The offer for ${candidateName(draft, offer.candidateId)} expired on ${fmtDayPlain(offer.expiresOn)}`)
    n += 1
  }
  return n
}

/** Extends a sent (or just-expired) offer to a new expiry date and re-reserves its options. */
export function extendOffer(draft: Draft<DB>, offerId: ID, newExpiresOn: ISODate, opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'sent' && offer.status !== 'expired') return { ok: false, reason: 'Only an offer that is out can be extended.' }
  if (newExpiresOn < opts.date) return { ok: false, reason: 'Pick a new expiry date on or after today.' }
  offer.expiresOn = newExpiresOn
  if (offer.status === 'expired') {
    offer.status = 'sent'
    delete offer.decidedOn
  }
  reserveOfferGrant(draft, offer, opts.date)
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  if (app && app.status === 'active') {
    const holidays = dbHolidays(draft)
    const job = draft.jobs.find((j) => j.id === offer.jobId)
    app.nextStep = { text: 'Follow up on the offer', dueOn: businessDayOnOrBefore(addBusinessDays(newExpiresOn, -1, holidays), holidays), ownerId: ownerFor(draft, job, opts.date, app.nextStep?.ownerId) }
  }
  logOffer(draft, offer, 'offer_extended', `Extended the offer for ${candidateName(draft, offer.candidateId)} to ${fmtDayPlain(newExpiresOn)}`)
  return { ok: true }
}

// ---- Generated documents --------------------------------------------------------------------

type Section = { heading?: string; paragraphs: string[] }

function render(title: string, sections: Section[], signature?: { left: string[]; right: string[] }): { html: string; text: string } {
  const html: string[] = [`<h1>${escapeHTML(title)}</h1>`]
  const text: string[] = [title, '']
  for (const s of sections) {
    if (s.heading) {
      html.push(`<h2>${escapeHTML(s.heading)}</h2>`)
      // Sentence case as written, set off by a blank line and an underline.
      text.push('', s.heading, '-'.repeat(s.heading.length))
    }
    for (const p of s.paragraphs) {
      html.push(`<p>${escapeHTML(p).replace(/\n/g, '<br>')}</p>`)
      text.push(p, '')
    }
  }
  if (signature) {
    html.push(
      `<div class="sig"><div>${signature.left.map(escapeHTML).join('<br>')}</div><div>${signature.right.map(escapeHTML).join('<br>')}</div></div>`,
    )
    text.push('', '______________________________', ...signature.left, '', '______________________________', ...signature.right)
  }
  return { html: html.join('\n'), text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' }
}

function addressLine(db: Pick<DB, 'company'>): string {
  const a = db.company.hq
  const street = [a.street, a.suite].filter(Boolean).join(', ')
  return [street, a.city, `${a.state} ${a.zip}`.trim()].filter((x) => x && x.trim()).join(', ')
}

function payScheduleText(db: Pick<DB, 'company'>): string {
  switch (db.company.paySchedule) {
    case 'biweekly':
      return 'every two weeks'
    case 'monthly':
      return 'monthly'
    default:
      return 'twice a month'
  }
}

/** The regular payday in words: Settings value, or a default for the pay schedule. */
export function regularPaydayText(db: Pick<DB, 'company'>): string {
  if (db.company.regularPayday?.trim()) return db.company.regularPayday.trim()
  switch (db.company.paySchedule) {
    case 'biweekly':
      return 'every other Friday'
    case 'monthly':
      return 'the last business day of each month'
    default:
      return 'the 15th and the last day of each month (the business day before when either falls on a weekend or holiday)'
  }
}

/**
 * Printable offer letter. At-will (Labor Code 2922), contingencies (background check after this
 * conditional offer under the Fair Chance Act, I-9, PIIA with the Labor Code 2870 notice), equity
 * subject to board approval with shares and % fully diluted and strike set at grant (no dollar
 * projections), no noncompete (Business and Professions Code 16600), California law and venue
 * (Labor Code 925), expiry and signature lines.
 */
export function offerLetter(db: DB, offerId: ID): { subject: string; html: string; text: string } | null {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  const company = db.company
  const manager = getPerson(db, offer.managerId)
  const location = db.locations.find((l) => l.id === offer.locationId)
  const signer = founder(db)
  const first = cand?.firstName ?? 'there'
  const fullName = cand ? `${cand.firstName} ${cand.lastName}` : 'Candidate'
  const letterDate = fmtLong(offer.sentOn ?? offer.createdOn)
  const exempt = offer.flsa === 'exempt'
  const hours = offer.hoursPerWeek ?? (offer.employmentType === 'full_time' ? 40 : undefined)
  const positionLead =
    offer.employmentType === 'intern'
      ? `This is an internship. You will work as ${offer.title}`
      : `You will work ${offer.employmentType === 'full_time' ? 'full-time' : `part-time${hours ? ` (about ${hours} hours a week)` : ''}`} as ${offer.title}`
  const computerPro = offer.exemptionBasis === 'computer_professional' || (!offer.exemptionBasis && (offer.familyId === 'f-eng' || offer.familyId === 'f-ml'))
  const workMode = offer.workMode === 'onsite' ? 'on site' : offer.workMode
  const where = location ? `${location.name}${location.kind === 'hq' ? ` (${addressLine(db)})` : ''}` : company.hq.city
  // California clauses (Labor Code 925 venue, 2751 commissions, California overtime and breaks, 2922,
  // B&P 16600) are written for work in California; other states get neutral wording (LAW.md).
  const workState = (location?.state || company.hq.state || 'CA').toUpperCase()
  const inCA = workState === 'CA'
  const sections: Section[] = []

  sections.push({
    paragraphs: [
      `${company.legalName}\n${addressLine(db)}`,
      letterDate,
      `Dear ${first},`,
      `We are delighted to offer you the position of ${offer.title} at ${company.name}. This letter sets out the terms of our offer.`,
    ],
  })
  sections.push({
    heading: 'Position',
    paragraphs: [
      `${positionLead}, reporting to ${manager ? `${manager.preferredName || manager.firstName} ${manager.lastName}, ${manager.title}` : 'your manager'}. Your work location is ${where}, ${workMode}. Your start date will be ${fmtLong(offer.startDate)}.`,
    ],
  })
  const pay: string[] = []
  if (offer.payType === 'salary') {
    pay.push(
      exempt
        ? `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is exempt, which means it is paid a salary and is not eligible for overtime.`
        : inCA
          ? `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is non-exempt: you are eligible for overtime under California law, you will receive meal and rest breaks, and you will record your hours worked.`
          : `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is non-exempt: you are eligible for overtime as the law of the state where you work and federal law provide, and you will record your hours worked.`,
    )
  } else if (exempt) {
    // Hourly exempt pay is allowed only for computer professionals (Labor Code 515.5).
    pay.push(
      `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is exempt${computerPro ? ' under the computer professional exemption (Labor Code 515.5)' : ''}, which means it is not eligible for overtime.`,
    )
  } else {
    pay.push(
      inCA
        ? `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is non-exempt: you will earn overtime at 1.5 times your regular rate (2 times where California law requires), you will receive meal and rest breaks, and you will record your hours worked.`
        : `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is non-exempt: you will earn overtime at 1.5 times your regular rate for hours over 40 in a week (and more where the law of the state where you work requires), and you will record your hours worked.`,
    )
  }
  if (offer.variablePct && offer.variablePct > 0) {
    const base = annualizedBase(offer)
    const sales = offer.familyId === 'f-gtm'
    pay.push(
      `You will be eligible for variable pay with a target of ${money(Math.round(base * offer.variablePct))} a year (${pct(offer.variablePct)} of base), under a separate written plan${sales ? (inCA ? ' that sets out how commissions are earned and paid, as California requires (Labor Code 2751)' : ' that sets out how commissions are earned and paid') : ''}.`,
    )
  }
  if (offer.signOnBonus && offer.signOnBonus > 0) {
    pay.push(`You will receive a one-time sign-on bonus of ${money(offer.signOnBonus)}, paid with your first regular paycheck.`)
  }
  pay.push('You will be eligible for the benefits the company offers to similarly situated employees, subject to the terms of each plan.')
  sections.push({ heading: 'Pay and benefits', paragraphs: pay })

  if (offer.equityShares > 0) {
    const fd = db.equity.fullyDilutedShares
    const pctText = fd > 0 ? pct(offer.equityShares / fd) : ''
    const typeName = offer.equityType === 'ISO' ? 'an incentive stock option (ISO), to the extent the law allows' : 'a nonqualified stock option (NSO)'
    const span = offer.vestingMonths % 12 === 0 ? `${offer.vestingMonths / 12} years` : `${offer.vestingMonths} months`
    const schedule =
      offer.cliffMonths > 0
        ? `${pct(offer.cliffMonths / offer.vestingMonths)} vests after ${offer.cliffMonths} months of service (the cliff), and the rest vests in equal monthly parts over the following ${offer.vestingMonths - offer.cliffMonths} months`
        : 'it vests in equal monthly parts'
    sections.push({
      heading: 'Equity',
      paragraphs: [
        `Subject to approval by the Board of Directors, you will be granted an option to purchase ${num(offer.equityShares)} shares of the company's common stock${pctText ? `, about ${pctText} of the company's fully diluted shares today` : ''}, as ${typeName}.`,
        `The exercise price will be the fair market value of a share on the date the Board grants the option, as set by the Board. The option vests over ${span}: ${schedule}, as long as you keep working for the company. The option is governed by the company's equity plan and your grant agreement.`,
      ],
    })
  }

  const conts: string[] = []
  if (offer.contingencies.includes('background_check')) {
    conts.push(
      'A background check. It runs only after you accept this conditional offer, with your written consent, and in a manner consistent with the California Fair Chance Act (Government Code 12952) and federal and California consumer reporting laws. If anything in the report concerns us, you will receive written notice and time to respond before any decision.',
    )
  }
  if (offer.contingencies.includes('i9')) {
    conts.push('Proof of your identity and authorization to work in the United States, as required by federal law (Form I-9), within 3 business days of your start date.')
  }
  if (offer.contingencies.includes('piia')) {
    conts.push(
      "Signing the company's Confidential information and invention assignment agreement. It includes the written notice required by Labor Code 2870: it does not apply to inventions you develop entirely on your own time without the company's equipment, supplies, facilities or trade secret information, unless they relate to the company's business or research or result from your work for the company.",
    )
  }
  if (conts.length) sections.push({ heading: 'Conditions of this offer', paragraphs: ['This offer depends on:', ...conts.map((c, i) => `${i + 1}. ${c}`)] })

  sections.push({
    heading: 'At-will employment',
    paragraphs: [
      `Your employment with the company is at will${inCA ? ', as provided in California Labor Code 2922' : ''}. This means that either you or the company may end the employment relationship at any time, with or without cause or notice. There is no fixed term of employment, and only a written agreement signed by the CEO can change this.`,
    ],
  })
  sections.push({
    heading: 'Your freedom to work',
    paragraphs: [
      inCA
        ? 'Nothing in this letter or in any company agreement restricts your ability to work for anyone else after you leave the company. California law makes noncompete agreements void (Business and Professions Code 16600). You must not bring or use confidential information or trade secrets belonging to any former employer.'
        : 'Nothing in this letter or in any company agreement restricts your ability to work for anyone else after you leave the company; the company does not use noncompete agreements. You must not bring or use confidential information or trade secrets belonging to any former employer.',
    ],
  })
  sections.push({
    heading: 'Governing law',
    paragraphs: [
      inCA
        ? 'This letter is governed by California law. Any dispute about your employment will be decided in California, as Labor Code 925 provides for employees who live and work in California.'
        : `This letter is governed by the law of the state where you work (${workState}) and applicable federal law.`,
      'This letter, together with the agreements it mentions, is the complete agreement about the terms of your employment and replaces any earlier discussions.',
    ],
  })
  sections.push({
    heading: 'Next steps',
    paragraphs: [
      `This offer expires at the end of the day on ${fmtLong(offer.expiresOn)}. To accept, sign and date below and return this letter. We are excited about what we will build together.`,
      `Sincerely,`,
    ],
  })

  const signerName = signer ? `${signer.preferredName || signer.firstName} ${signer.lastName}` : company.name
  const signerTitle = signer?.title ?? ''
  const doc = render(`Offer of employment: ${offer.title}`, sections, {
    left: [signerName, signerTitle, company.legalName].filter(Boolean),
    right: [`Accepted by ${fullName}`, 'Date:'],
  })
  return { subject: `Your offer from ${company.name}`, ...doc }
}

// ---- Labor Code 2810.5 wage notice ----------------------------------------------------------

/** County for common Bay Area cities (the disaster-declaration line names the work county). */
export function countyForCity(city: string | undefined): string | undefined {
  if (!city) return undefined
  const c = city.trim().toLowerCase()
  const santaClara = ['san jose', 'santa clara', 'sunnyvale', 'mountain view', 'palo alto', 'cupertino', 'milpitas', 'campbell', 'los gatos', 'saratoga', 'los altos', 'morgan hill', 'gilroy']
  const alameda = ['oakland', 'fremont', 'berkeley', 'hayward', 'alameda', 'pleasanton', 'livermore', 'union city', 'newark', 'emeryville', 'dublin']
  const sanMateo = ['san mateo', 'redwood city', 'menlo park', 'east palo alto', 'burlingame', 'south san francisco', 'foster city', 'san carlos', 'belmont', 'daly city']
  if (santaClara.includes(c)) return 'Santa Clara County'
  if (alameda.includes(c)) return 'Alameda County'
  if (sanMateo.includes(c)) return 'San Mateo County'
  if (c === 'san francisco') return 'San Francisco County'
  return undefined
}

/** '40 hours (5 days)', or just the hours when they are not whole 8-hour days. */
function sickHoursText(hours: number): string {
  const days = hours / 8
  return Number.isInteger(days) ? `${num(hours)} hours (${num(days)} ${days === 1 ? 'day' : 'days'})` : `${num(hours)} hours`
}

type WageInput = {
  name: string
  title: string
  startDate: ISODate
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  hoursPerWeek: number
  flsa: FLSA
  locationId: ID
  city?: string
}

/**
 * Labor Code 2810.5 notice to a non-exempt hire, due no later than the start date (optional for
 * exempt hires, whose notice says 'Exempt from overtime' instead of overtime rates): pay rate and
 * basis with overtime rates, allowances, regular payday, employer legal and DBA names, address and
 * phone, the workers' comp carrier's name, address and phone (2810.5(a)(1)(H); LAW.md a-wc-1), paid
 * sick leave rights, and the disaster-declaration line. For a person, pay comes from the comp row in
 * effect on `date` (default: their start date). `missing` lists details to add in Settings first.
 */
export function wageNotice2810_5(db: DB, ref: { offerId?: ID; personId?: ID; date?: ISODate }): { html: string; text: string; missing: string[] } | null {
  let input: WageInput | null = null
  if (ref.offerId) {
    const o = db.offers.find((x) => x.id === ref.offerId)
    if (!o) return null
    const loc = db.locations.find((l) => l.id === o.locationId)
    input = {
      name: candidateName(db, o.candidateId),
      title: o.title,
      startDate: o.startDate,
      payType: o.payType,
      ...(o.salary != null ? { salary: o.salary } : {}),
      ...(o.hourlyRate != null ? { hourlyRate: o.hourlyRate } : {}),
      hoursPerWeek: o.hoursPerWeek ?? 40,
      flsa: o.flsa,
      locationId: o.locationId,
      ...(loc?.city ? { city: loc.city } : {}),
    }
  } else if (ref.personId) {
    const p = getPerson(db, ref.personId)
    if (!p) return null
    // The pay in effect on the date (start date by default), never a future-dated raise.
    const asOf = ref.date ?? p.startDate
    const rows = db.comp.filter((c) => c.personId === p.id).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    const comp = rows.filter((c) => c.effectiveOn <= asOf).pop() ?? rows[0]
    input = {
      name: `${p.preferredName || p.firstName} ${p.lastName}`,
      title: comp?.title ?? p.title,
      startDate: p.startDate,
      payType: comp?.payType ?? 'salary',
      ...(comp?.salary != null ? { salary: comp.salary } : {}),
      ...(comp?.hourlyRate != null ? { hourlyRate: comp.hourlyRate } : {}),
      hoursPerWeek: p.hoursPerWeek || 40,
      flsa: comp?.flsa ?? p.flsa,
      locationId: p.locationId,
    }
    const city = p.workMode === 'remote' ? p.homeCity : (db.locations.find((l) => l.id === p.locationId)?.city ?? p.homeCity)
    if (city) input.city = city
  }
  if (!input) return null
  const company = db.company
  const missing: string[] = []
  const exempt = input.flsa === 'exempt'
  const regular = input.payType === 'hourly' ? (input.hourlyRate ?? 0) : (input.salary ?? 0) / 52 / (input.hoursPerWeek || 40)
  const rateLine =
    input.payType === 'hourly'
      ? `${money2(input.hourlyRate)} per hour (rate by the hour)`
      : exempt
        ? `${money(input.salary)} per year, paid as a salary`
        : `${money(input.salary)} per year, paid as a salary (regular hourly rate for overtime: ${money2(regular)})`
  const otLine = exempt
    ? 'Overtime: Exempt from overtime.'
    : `Overtime rates: ${money2(regular * 1.5)} per hour (1.5 times the regular rate) for hours over 8 in a workday or 40 in a workweek and the first 8 hours on a seventh consecutive workday; ${money2(regular * 2)} per hour (2 times) for hours over 12 in a workday and over 8 on a seventh consecutive workday.`
  const carrier = company.workersCompCarrier
  if (!carrier?.name) missing.push("Workers' comp carrier (Settings > Company)")
  if (!carrier?.address) missing.push("Workers' comp carrier address (Settings > Company)")
  if (!carrier?.phone) missing.push("Workers' comp carrier phone (Settings > Company)")
  if (!company.phone) missing.push('Company phone number (Settings > Company)')
  if (!company.hq.street) missing.push('Company street address (Settings > Company)')
  if (!company.regularPayday) missing.push('Regular payday (Settings > Company); a default for your pay schedule is shown')
  const sick = db.timeOffPolicies.find((p) => p.kind === 'sick')
  const sickPlan =
    sick?.method === 'frontload'
      ? `The company provides ${sickHoursText(sick.annualHours ?? 40)} of paid sick leave at the start of each year and at hire${sick.usableAfterDays ? `, usable from day ${sick.usableAfterDays}` : ''}.`
      : 'You accrue paid sick leave at 1 hour for every 30 hours worked, under Labor Code 246.'
  const county = countyForCity(input.city) ?? 'the county where you will work'
  const dba = company.name && company.name !== company.legalName && !company.legalName.startsWith(`${company.name},`) ? company.name : 'None'
  const sections: Section[] = [
    {
      heading: 'Employee',
      paragraphs: [`Name: ${input.name}\nJob title: ${input.title}\nStart date: ${fmtLong(input.startDate)}`],
    },
    {
      heading: 'Pay',
      paragraphs: [
        `Rate of pay: ${rateLine}`,
        otLine,
        'Allowances claimed as part of the minimum wage (meals or lodging): None.',
        `Regular payday: ${regularPaydayText(db)}. Pay schedule: ${payScheduleText(db)}.`,
      ],
    },
    {
      heading: 'Employer',
      paragraphs: [
        `Legal name: ${company.legalName}\nOther names the employer does business as (DBA): ${dba}\nPhysical address of main office: ${addressLine(db)}\nMailing address, if different: Same\nPhone: ${company.phone ?? 'Not set'}`,
      ],
    },
    {
      heading: "Workers' compensation insurance",
      paragraphs: [
        `Carrier: ${carrier?.name || 'Not set'}\nCarrier address: ${carrier?.address || 'Not set'}\nCarrier phone: ${carrier?.phone || 'Not set'}${carrier?.policyNumber ? `\nPolicy number: ${carrier.policyNumber}` : ''}`,
      ],
    },
    {
      heading: 'Paid sick leave',
      paragraphs: [
        'Unless exempt, you are entitled to paid sick leave under California law, which provides that you: may accrue paid sick leave and may request and use at least 40 hours or 5 days of paid sick leave per year; may not be terminated or retaliated against for using or requesting paid sick leave; and have the right to file a complaint against an employer who retaliates or discriminates.',
        sickPlan,
      ],
    },
    {
      heading: 'Emergency or disaster declaration',
      paragraphs: [
        `Has a federal or state emergency or disaster declaration that may affect your health and safety been issued for ${county} within 30 days before your first day of work?  [ ] Yes   [ ] No   [ ] Not known`,
      ],
    },
    {
      paragraphs: [
        'You will be told in writing of any change to this information within 7 calendar days, unless the change appears on a timely wage statement or another required writing.',
        'Notice to employee under California Labor Code 2810.5.',
      ],
    },
  ]
  const doc = render('Notice to employee (Labor Code 2810.5)', sections, {
    left: [`For ${company.legalName}`, 'Date:'],
    right: [`Received by ${input.name}`, 'Date:'],
  })
  return { ...doc, missing }
}
