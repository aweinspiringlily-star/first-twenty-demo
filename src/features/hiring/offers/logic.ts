// Pure helpers for offers, the position-in-band meter, background checks and the Offers tab.
// No store or React imports, so they can be unit tested (logic.test.ts).
import { RULES } from '@/domain/compliance'
import { isEmployedOn } from '@/domain/people'
import type { Band, BackgroundCheck, CompRecord, ID, Offer, OfferStatus, Person } from '@/domain/types'
import { addBusinessDays, addDays, fmtDay, fmtShort, type ISODate, parseDate } from '@/lib/dates'

export const OFFER_STATUS: Record<OfferStatus, { label: string; tone: 'neutral' | 'accent' | 'good' | 'warn' | 'outline' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  awaiting_approval: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'accent' },
  sent: { label: 'Out', tone: 'accent' },
  accepted: { label: 'Accepted', tone: 'good' },
  declined: { label: 'Declined', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  rescinded: { label: 'Rescinded', tone: 'outline' },
}

/** One-tap reasons for going above the band or the equity guideline. */
export function exceptionReasonChoices(): string[] {
  return ['Competing offer', 'Rare skill set', 'Founding-level scope', 'Internal equity', 'Market moved since bands were set']
}

/** Reason chips when a candidate declines (stored as the offer's decline reason). */
export function declineReasonChoices(): Array<{ value: string; label: string }> {
  return [
    { value: 'chose_other_offer', label: 'Competing offer' },
    { value: 'Counteroffer from current employer', label: 'Counteroffer' },
    { value: 'comp', label: 'Comp' },
    { value: 'location', label: 'Location' },
    { value: 'timing', label: 'Timing' },
    { value: 'other', label: 'Other' },
  ]
}

export function rescindReasonChoices(): string[] {
  return ['Role on hold', 'Budget changed', 'Contingency not met', 'Offer made in error']
}

/** Mondays from the default start date on (holidays move to the next business day). */
export function startDatePresets(defaultStart: ISODate, count = 4): Array<{ label: string; date: ISODate }> {
  const out: Array<{ label: string; date: ISODate }> = []
  let d = defaultStart
  // Align to a Monday on or after the default.
  for (let i = 0; i < 7 && parseDate(d).getDay() !== 1; i++) d = addDays(d, 1)
  for (let i = 0; i < count; i++) {
    const date = addDays(d, 7 * i)
    out.push({ label: shortDay(date), date })
  }
  return out
}

/** Expiry presets: 3, 5 (default) and 7 business days from the date, plus 2 weeks. */
export function expiryPresets(date: ISODate, holidays: ISODate[] = []): Array<{ label: string; date: ISODate }> {
  return [
    { label: '3 business days', date: addBusinessDays(date, 3, holidays) },
    { label: '5 business days', date: addBusinessDays(date, 5, holidays) },
    { label: '7 business days', date: addBusinessDays(date, 7, holidays) },
    { label: '2 weeks', date: addDays(date, 14) },
  ]
}

/** Extension options from the later of today and the current expiry. */
export function extendOptions(expiresOn: ISODate, date: ISODate, holidays: ISODate[] = []): Array<{ days: number; date: ISODate }> {
  const from = expiresOn > date ? expiresOn : date
  return [2, 3, 5].map((days) => ({ days, date: addBusinessDays(from, days, holidays) }))
}

/** 'Mon, Nov 16' without the year. */
export function shortDay(d: ISODate): string {
  return fmtDay(d)
}

export type BandMeterGeometry = {
  /** Domain shown on the track (band padded so nearby outliers still fit). */
  lo: number
  hi: number
  /** Fraction 0..1 along the track for a value (clamped). */
  at: (v: number) => number
  /** True when the value sits outside the shown domain (drawn at the edge with an arrow). */
  clipped: (v: number) => boolean
}

/** Track geometry for the position-in-band meter: the band plus 12% padding each side. */
export function bandMeterGeometry(band: Pick<Band, 'min' | 'max'>): BandMeterGeometry {
  const span = Math.max(1, band.max - band.min)
  const lo = band.min - span * 0.12
  const hi = band.max + span * 0.12
  const raw = (v: number) => (v - lo) / (hi - lo)
  return {
    lo,
    hi,
    at: (v) => Math.max(0, Math.min(1, raw(v))),
    clipped: (v) => raw(v) < 0 || raw(v) > 1,
  }
}

/** Plain words for where a base sits: 'Below the band', 'Low in the band', 'Mid band', ... */
export function bandWords(base: number, band: Pick<Band, 'min' | 'mid' | 'max'>): string {
  if (base < band.min) return 'Below the band'
  if (base > band.max) return 'Above the band'
  const pos = band.max === band.min ? 0.5 : (base - band.min) / (band.max - band.min)
  if (pos < 1 / 3) return 'Low in the band'
  if (pos <= 2 / 3) return 'Mid band'
  return 'High in the band'
}

/**
 * Annual base for employees at a family and level on a date (unnamed peers for the band meter).
 * Uses the comp row in effect; hourly rows are annualized at their hours. Excludes the given ids.
 */
export function peerBases(
  people: Person[],
  comp: CompRecord[],
  familyId: ID,
  levelId: ID,
  date: ISODate,
  exclude: ID[] = [],
): number[] {
  const out: number[] = []
  for (const p of people) {
    if (exclude.includes(p.id) || !isEmployedOn(p, date)) continue
    const rows = comp.filter((c) => c.personId === p.id && c.effectiveOn <= date).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    const row = rows[rows.length - 1]
    if (!row || row.levelId !== levelId || p.familyId !== familyId) continue
    const base = row.payType === 'hourly' ? Math.round((row.hourlyRate ?? 0) * (p.hoursPerWeek || 40) * 52) : (row.salary ?? 0)
    if (base > 0) out.push(base)
  }
  return out.sort((a, b) => a - b)
}

/** True when the background check cleared (Clear, or Consider and the Fair Chance decision was Proceed). */
export function checkCleared(bg: BackgroundCheck | undefined): boolean {
  if (!bg || bg.status !== 'complete') return false
  return bg.result === 'clear' || bg.fairChance?.decision === 'proceed'
}

/** Contingencies a hiring manager may see: cleared yes or no (background check only; I-9 and PIIA come at start). */
export function contingenciesCleared(offer: Pick<Offer, 'contingencies' | 'backgroundCheck'>): boolean {
  if (!offer.contingencies.includes('background_check')) return true
  return checkCleared(offer.backgroundCheck)
}

export type BackgroundStep = 'locked' | 'not_started' | 'consent_sent' | 'in_progress' | 'clear' | 'consider' | 'cancelled'

/** Where a background check stands, for the status stepper. */
export function backgroundStep(conditionalOfferOn: ISODate | undefined, bg: BackgroundCheck | undefined): BackgroundStep {
  if (!conditionalOfferOn) return 'locked'
  if (!bg || bg.status === 'not_started') return 'not_started'
  if (bg.status === 'cancelled') return 'cancelled'
  if (bg.status === 'consent_sent') return 'consent_sent'
  if (bg.status === 'in_progress') return 'in_progress'
  return bg.result === 'consider' ? 'consider' : 'clear'
}

export type OfferGroupKey = 'draft' | 'awaiting_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'expired' | 'rescinded'

/** Latest version per application, so revised offers do not show twice. */
export function latestPerApplication(offers: Offer[]): Offer[] {
  const best = new Map<ID, Offer>()
  for (const o of offers) {
    const cur = best.get(o.applicationId)
    if (!cur || o.version > cur.version) best.set(o.applicationId, o)
  }
  return [...best.values()]
}

/**
 * Offers tab groups. Accepted shows offers still to be hired or starting on or after `acceptedSince`;
 * declined, expired and rescinded show those decided on or after `since`. Older ones are counted
 * in `earlier` so nothing silently disappears.
 */
export function groupOffers(
  offers: Offer[],
  since: ISODate,
  people: Pick<Person, 'id' | 'startDate'>[],
  acceptedSince: ISODate = since,
): { groups: Record<OfferGroupKey, Offer[]>; earlier: number } {
  const groups: Record<OfferGroupKey, Offer[]> = { draft: [], awaiting_approval: [], approved: [], sent: [], accepted: [], declined: [], expired: [], rescinded: [] }
  let earlier = 0
  for (const o of latestPerApplication(offers)) {
    if (o.status === 'accepted') {
      const p = o.personId ? people.find((x) => x.id === o.personId) : undefined
      const recent = !o.personId || (p ? p.startDate >= acceptedSince : (o.decidedOn ?? o.createdOn) >= acceptedSince)
      if (recent) groups.accepted.push(o)
      else earlier += 1
    } else if (o.status === 'declined' || o.status === 'expired' || o.status === 'rescinded') {
      if ((o.decidedOn ?? o.createdOn) >= since) groups[o.status].push(o)
      else earlier += 1
    } else {
      groups[o.status].push(o)
    }
  }
  const byDate = (a: Offer, b: Offer) => (b.decidedOn ?? b.sentOn ?? b.createdOn).localeCompare(a.decidedOn ?? a.sentOn ?? a.createdOn)
  groups.sent.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))
  for (const k of ['draft', 'awaiting_approval', 'approved', 'accepted', 'declined', 'expired', 'rescinded'] as const) groups[k].sort(byDate)
  return { groups, earlier }
}

/** 'Big-tech counteroffer.' -> 'Big-tech counteroffer' (so sentences do not end in two periods). */
export function trimPeriod(s: string | undefined): string {
  return (s ?? '').trim().replace(/[.\s]+$/, '')
}

/** Compliance rules that switch on when headcount reaches n (active milestones only), for the Hire preview. */
export function rulesAtThreshold(n: number) {
  return RULES.filter((r) => r.trigger.kind === 'headcount' && r.trigger.n === n && !r.upcoming)
}

/**
 * The Approval line on an offer. An approval counts only while it still stands: editing an approved
 * offer's pay, equity, level or start date sends it back to draft (updateOffer), so a draft or an
 * offer waiting for approval never shows an older approval as if it covered the current terms.
 */
export function approvalLine(offer: Pick<Offer, 'status' | 'approvals'>, needsApproval: boolean, nameOf: (id: ID) => string): string {
  const last = [...offer.approvals].reverse().find((a) => a.decision === 'approved')
  const pending = offer.status === 'draft' || offer.status === 'awaiting_approval'
  if (last && !pending) return `Approved by ${nameOf(last.approverId)}, ${fmtDay(last.at)}`
  if (!needsApproval) return 'Drafted by Admin, no separate approval'
  const waiting = offer.status === 'awaiting_approval' ? 'Waiting for Admin approval' : 'Needs Admin approval'
  if (last) return `${waiting} (changed since the ${fmtShort(last.at)} approval)`
  return pending ? waiting : 'No approval on record'
}
