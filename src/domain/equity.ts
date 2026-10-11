// Option vesting and pool math. Standard schedule: nothing vests before the cliff; at the cliff
// cliffMonths/vestingMonths of the grant vests at once; then 1/vestingMonths each month.
// Whole shares only: vested = floor(shares * monthsVested / vestingMonths), all of it at the end.
// The equity planning view (docs/SPEC.md, EQUITY PLANNING VIEW) is a planning mirror: the cap table
// tool stays the source of truth for issued options, exercises and 409A valuations.
import type { Draft } from 'immer'
import { offerLapsed, outstandingOffers } from '@/domain/pay'
import { fullName } from '@/domain/people'
import type { DB, EquityGrant, ID, Valuation409A } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtShort, fullMonthsBetween, type ISODate, nowISO } from '@/lib/dates'
import { money2, num, plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'

/**
 * Whole months of service from the vesting start to the date, or -1 before the start. A month counts on its
 * monthly anniversary, and for a start on the 29th to 31st that is the last day of a shorter month (a Jan 31
 * start vests on Feb 28), matching addMonths and so every vest date this module reports.
 */
export function creditedMonths(vestingStart: ISODate, date: ISODate): number {
  if (date < vestingStart) return -1
  const m = fullMonthsBetween(vestingStart, date)
  return addMonths(vestingStart, m + 1) <= date ? m + 1 : m
}

/** Months of vesting credited on a date (0 before the cliff). */
export function monthsVested(grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths' | 'vestingMonths'>, date: ISODate): number {
  if (date < grant.vestingStart) return 0
  const m = Math.min(grant.vestingMonths, creditedMonths(grant.vestingStart, date))
  return m < grant.cliffMonths ? 0 : m
}

/** Shares vested on a date, ignoring cancellation. */
export function vestedShares(
  grant: Pick<EquityGrant, 'shares' | 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): number {
  const m = monthsVested(grant, date)
  if (m >= grant.vestingMonths) return grant.shares
  return Math.floor((grant.shares * m) / grant.vestingMonths)
}

export function unvestedShares(
  grant: Pick<EquityGrant, 'shares' | 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): number {
  return grant.shares - vestedShares(grant, date)
}

export function cliffDate(grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths'>): ISODate {
  return addMonths(grant.vestingStart, grant.cliffMonths)
}

export function fullyVestedDate(grant: Pick<EquityGrant, 'vestingStart' | 'vestingMonths'>): ISODate {
  return addMonths(grant.vestingStart, grant.vestingMonths)
}

/** The next date on which more shares vest, after `date`, or null when fully vested. */
export function nextVestDate(
  grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): ISODate | null {
  const m = creditedMonths(grant.vestingStart, date)
  if (date < grant.vestingStart || m < grant.cliffMonths) return cliffDate(grant)
  if (m >= grant.vestingMonths) return null
  return addMonths(grant.vestingStart, m + 1)
}

/**
 * Shares counted against the pool by a grant: all shares, minus any returned on cancellation. With a
 * date, a cancellation dated later (a leaver's unvested shares come back on their last day) has not
 * taken effect yet, so the grant still holds every share.
 */
export function sharesHeld(grant: EquityGrant, date?: ISODate): number {
  if (cancellationPending(grant, date)) return grant.shares
  if (grant.status === 'cancelled') return Math.max(0, grant.shares - (grant.cancelledShares ?? grant.shares))
  return grant.shares - (grant.cancelledShares ?? 0)
}

/** True when the grant's cancellation is dated after `date` (offboarding records it ahead of the last day). */
export function cancellationPending(grant: Pick<EquityGrant, 'cancelledOn' | 'cancelledShares' | 'status'>, date?: ISODate): boolean {
  return !!date && !!grant.cancelledOn && grant.cancelledOn > date && (grant.cancelledShares != null || grant.status === 'cancelled')
}

/** Shares a grant has returned to the pool by the date (none while its cancellation is still ahead). */
export function sharesReturned(grant: EquityGrant, date?: ISODate): number {
  if (cancellationPending(grant, date)) return 0
  return grant.status === 'cancelled' ? (grant.cancelledShares ?? grant.shares) : (grant.cancelledShares ?? 0)
}

/** Fraction of fully diluted shares (0.005 = 0.5%). */
export function pctOfFullyDiluted(db: DB, shares: number): number {
  return db.equity.fullyDilutedShares > 0 ? shares / db.equity.fullyDilutedShares : 0
}

export function grantsFor(db: DB, personId: ID): EquityGrant[] {
  return db.grants.filter((g) => g.personId === personId).sort((a, b) => a.vestingStart.localeCompare(b.vestingStart))
}

/** The 409A in effect on a date (latest effective on or before it), or undefined. */
export function current409A(db: DB, date: ISODate): Valuation409A | undefined {
  return [...db.equity.valuations]
    .filter((v) => v.effectiveOn <= date)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))[0]
}

// ---------------------------------------------------------------------------------------------
// Holders and vesting
// ---------------------------------------------------------------------------------------------

/** Display name of a grant holder: employee, contractor or advisor, or candidate (reserved by an offer). */
export function holderName(db: DB, grant: Pick<EquityGrant, 'personId'>): string {
  const p = db.people.find((x) => x.id === grant.personId)
  if (p) return fullName(p)
  const k = db.contractors.find((x) => x.id === grant.personId)
  if (k) return k.name
  const c = db.candidates.find((x) => x.id === grant.personId)
  if (c) return `${c.firstName} ${c.lastName}`
  return 'Unknown holder'
}

/** Last day the holder works for the company (employee end date or contract end), if any. */
export function holderEndDate(db: DB, grant: Pick<EquityGrant, 'personId'>): ISODate | undefined {
  const p = db.people.find((x) => x.id === grant.personId)
  if (p) return p.endDate ?? undefined
  const k = db.contractors.find((x) => x.id === grant.personId)
  return k?.endOn ?? undefined
}

/** Shares vested after `m` whole months of service (cliff and whole-share rules applied). */
function vestAtMonth(g: Pick<EquityGrant, 'shares' | 'cliffMonths' | 'vestingMonths'>, m: number): number {
  if (g.vestingMonths <= 0) return g.shares
  if (m < 0 || m < g.cliffMonths) return 0
  if (m >= g.vestingMonths) return g.shares
  return Math.floor((g.shares * m) / g.vestingMonths)
}

/**
 * Vested shares the holder actually keeps on a date: vesting stops at the cancellation date or the
 * holder's last day, and never exceeds the shares still held. Reserved grants (offer still out) vest nothing.
 */
export function vestedHeld(db: DB, grant: EquityGrant, date: ISODate): number {
  if (grant.status === 'reserved') return 0
  let stop = date
  if (grant.cancelledOn && grant.cancelledOn < stop) stop = grant.cancelledOn
  const end = holderEndDate(db, grant)
  if (end && end < stop) stop = end
  return Math.min(vestedShares(grant, stop), sharesHeld(grant))
}

export type VestingPoint = { date: ISODate; vested: number }

/**
 * Monthly cumulative vested shares for a chart, from the vesting start to the fully vested date
 * (vestingMonths + 1 points). After a cancellation date the line stays flat at what was kept.
 */
export function vestingPoints(grant: EquityGrant): VestingPoint[] {
  const months = Math.max(0, grant.vestingMonths)
  const kept = sharesHeld(grant)
  const points: VestingPoint[] = []
  let frozen: number | null = null
  for (let m = 0; m <= months; m++) {
    const date = addMonths(grant.vestingStart, m)
    let vested = vestAtMonth(grant, m)
    if (grant.cancelledOn && date > grant.cancelledOn) {
      if (frozen == null) frozen = Math.min(vestedShares(grant, grant.cancelledOn), kept)
      vested = frozen
    }
    points.push({ date, vested })
  }
  return points
}

/** "4-year vesting, 1-year cliff, then monthly" or "Monthly over 2 years, no cliff". */
export function scheduleText(grant: Pick<EquityGrant, 'cliffMonths' | 'vestingMonths'>): string {
  const span = (m: number, adjective: boolean) => {
    if (m % 12 === 0) {
      const y = m / 12
      return adjective ? `${y}-year` : `${y} ${y === 1 ? 'year' : 'years'}`
    }
    return adjective ? `${m}-month` : `${m} ${m === 1 ? 'month' : 'months'}`
  }
  if (grant.vestingMonths <= 0) return 'Fully vested at grant'
  if (grant.cliffMonths <= 0) return `Monthly over ${span(grant.vestingMonths, false)}, no cliff`
  return `${span(grant.vestingMonths, true)} vesting, ${span(grant.cliffMonths, true)} cliff, then monthly`
}

// Helpers below are function declarations, not module constants: equity.ts imports the store, and the
// sample seed may call these functions while that import cycle is still loading.

/** Approved and promised grants are live (promised ones vest from the start date, pending board consent). */
function isLive(status: EquityGrant['status']): boolean {
  return status === 'approved' || status === 'promised'
}

export type VestEvent = {
  personId: ID
  grantId: ID
  date: ISODate
  /** Shares vesting on this date. */
  shares: number
  /** Total vested after this date. */
  cumulative: number
  isCliff: boolean
  /** The grant still waits for board consent. */
  awaitingBoard: boolean
}

/** Live grants (approved or promised) whose holder is still working for the company on `date`. */
function liveOn(db: DB, grant: EquityGrant, date: ISODate): boolean {
  if (!isLive(grant.status) || sharesHeld(grant) <= 0) return false
  if (grant.cancelledOn && grant.cancelledOn < date) return false
  const end = holderEndDate(db, grant)
  return !end || end >= date
}

/** Every vest date (cliff and monthly) between from and to, inclusive, for live grants. */
export function upcomingVests(db: DB, from: ISODate, to: ISODate): VestEvent[] {
  const out: VestEvent[] = []
  for (const g of db.grants) {
    if (!isLive(g.status)) continue
    const first = Math.max(g.cliffMonths, 1)
    for (let m = first; m <= g.vestingMonths; m++) {
      const date = addMonths(g.vestingStart, m)
      if (date > to) break
      if (date < from || !liveOn(db, g, date)) continue
      const shares = vestAtMonth(g, m) - (m === g.cliffMonths ? 0 : vestAtMonth(g, m - 1))
      if (shares <= 0) continue
      out.push({
        personId: g.personId,
        grantId: g.id,
        date,
        shares,
        cumulative: vestAtMonth(g, m),
        isCliff: g.cliffMonths > 0 && m === g.cliffMonths,
        awaitingBoard: g.status === 'promised',
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.personId.localeCompare(b.personId))
}

export type CliffEvent = { personId: ID; grantId: ID; date: ISODate; shares: number; awaitingBoard: boolean }

/** Cliffs between from and to, inclusive ("Kofi hits his 1-year cliff Tue Oct 6: 13,000 options vest"). */
export function upcomingCliffs(db: DB, from: ISODate, to: ISODate): CliffEvent[] {
  return upcomingVests(db, from, to)
    .filter((v) => v.isCliff)
    .map((v) => ({ personId: v.personId, grantId: v.grantId, date: v.date, shares: v.shares, awaitingBoard: v.awaitingBoard }))
}

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

export type PoolSummary = {
  /** Pool size on the date: the base pool plus increases dated on or before it. */
  poolShares: number
  basePool: number
  increases: number
  /** Board-approved grants, minus shares returned (exercised shares stay counted). */
  grantedOutstanding: number
  exercised: number
  /** Promised grants: accepted offers and other grants waiting for board consent. */
  awaitingBoard: number
  /** Reserved grants plus outstanding offers with equity and no grant row yet. */
  reservedByOffers: number
  /** Shares returned to the pool from cancelled or forfeited board-approved grants (including unrecorded forfeitures). */
  returned: number
  /**
   * Unvested shares of approved grants whose holder has left (end date before `date`) with no cancellation
   * recorded. They are counted in `returned`; the UI can prompt to record them.
   */
  unrecordedForfeitures: number
  unrecordedGrantIds: ID[]
  available: number
  /** Share of the pool used or spoken for (0 to 1). */
  usedPct: number
}

export function poolSummary(db: DB, date: ISODate): PoolSummary {
  const increases = db.equity.poolIncreases.filter((i) => i.date <= date).reduce((t, i) => t + i.shares, 0)
  const poolShares = db.equity.poolShares + increases
  const lapsedOfferIds = new Set(db.offers.filter((o) => offerLapsed(o, date)).map((o) => o.id))
  let granted = 0
  let exercised = 0
  let awaiting = 0
  let reserved = 0
  let returned = 0
  let unrecorded = 0
  const unrecordedGrantIds: ID[] = []
  for (const g of db.grants) {
    if (g.status === 'approved' || (g.status === 'cancelled' && g.boardApprovedOn)) {
      exercised += g.exercisedShares ?? 0
      const end = g.status === 'approved' && g.cancelledShares == null ? holderEndDate(db, g) : undefined
      if (end && end < date) {
        // The holder left but no cancellation was recorded: unvested shares go back to the pool.
        const kept = Math.min(g.shares, Math.max(vestedShares(g, end), g.exercisedShares ?? 0))
        granted += kept
        if (g.shares - kept > 0) {
          returned += g.shares - kept
          unrecorded += g.shares - kept
          unrecordedGrantIds.push(g.id)
        }
        continue
      }
      // A leaver's unvested shares come back on the cancellation date (their last day), not before.
      granted += sharesHeld(g, date)
      returned += sharesReturned(g, date)
    } else if (g.status === 'promised') awaiting += sharesHeld(g, date)
    else if (g.status === 'reserved' && !(g.fromOfferId && lapsedOfferIds.has(g.fromOfferId))) reserved += sharesHeld(g, date)
  }
  // Offers out (not past expiry) whose equity has no grant row yet still hold shares back.
  for (const o of outstandingOffers(db, date)) {
    if (!o.equityShares) continue
    const hasGrant = db.grants.some(
      (g) => g.fromOfferId === o.id || (g.personId === o.candidateId && (g.status === 'reserved' || g.status === 'promised')),
    )
    if (!hasGrant) reserved += o.equityShares
  }
  const available = poolShares - granted - awaiting - reserved
  return {
    poolShares,
    basePool: db.equity.poolShares,
    increases,
    grantedOutstanding: granted,
    exercised,
    awaitingBoard: awaiting,
    reservedByOffers: reserved,
    returned,
    unrecordedForfeitures: unrecorded,
    unrecordedGrantIds,
    available,
    usedPct: poolShares > 0 ? (poolShares - available) / poolShares : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// 409A warnings
// ---------------------------------------------------------------------------------------------

export type ValuationWarning = {
  kind: 'missing' | 'expired' | 'expiring' | 'financing' | 'strike'
  text: string
  valuationId?: ID
  roundId?: ID
  grantId?: ID
}

/**
 * Warnings about the 409A in effect on `date`: none on file while grants exist, expired, expiring within
 * 60 days, a funding round closed after it, and promised grants whose strike differs from it. Pass the
 * board date to check a consent before it happens.
 */
export function valuationWarnings(db: DB, date: ISODate): ValuationWarning[] {
  const out: ValuationWarning[] = []
  const v = current409A(db, date)
  if (!v) {
    if (db.grants.some((g) => g.status !== 'cancelled')) {
      out.push({ kind: 'missing', text: 'No 409A valuation on file. Get one before the board grants options, so the strike price has safe harbor.' })
    }
    return out
  }
  const left = daysBetween(date, v.expiresOn)
  if (left < 0) {
    out.push({
      kind: 'expired',
      valuationId: v.id,
      text: `The 409A from ${fmtDate(v.effectiveOn)} expired on ${fmtDate(v.expiresOn)}. Get a new valuation before the next board grant.`,
    })
  } else if (left <= 60) {
    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days (${fmtDate(v.expiresOn)})`
    out.push({
      kind: 'expiring',
      valuationId: v.id,
      text: `The 409A from ${fmtDate(v.effectiveOn)} expires ${when}. Plan the next valuation now so grants keep safe harbor.`,
    })
  }
  for (const r of db.company.fundingRounds) {
    if (r.closedOn > v.effectiveOn && r.closedOn <= date) {
      out.push({
        kind: 'financing',
        valuationId: v.id,
        roundId: r.id,
        text: `The ${r.name} round closed on ${fmtDate(r.closedOn)}, after the current 409A (${fmtDate(v.effectiveOn)}). A financing usually ends safe harbor, so get a new 409A before the next grant.`,
      })
    }
  }
  for (const g of db.grants) {
    if (g.status !== 'promised' || !g.strikePrice || Math.abs(g.strikePrice - v.fmvPerShare) < 0.005) continue
    out.push({
      kind: 'strike',
      valuationId: v.id,
      grantId: g.id,
      text: `${holderName(db, g)}'s grant shows a ${money2(g.strikePrice)} strike, but the 409A in effect is ${money2(v.fmvPerShare)}. The strike is set when the board approves the grant.`,
    })
  }
  return out
}

/**
 * logActivity, guarded: if the sample seed calls this module while the store is still loading (the
 * store -> seed -> domain import cycle, under module runners without live bindings), write the row directly.
 */
function log(draft: Draft<DB>, a: Parameters<typeof logActivity>[1]): void {
  try {
    logActivity(draft, a)
  } catch {
    draft.activity.push({ id: newId('act'), at: nowISO(), actorId: null, ...a })
  }
}

// ---------------------------------------------------------------------------------------------
// Board consent
// ---------------------------------------------------------------------------------------------

/** Grants waiting for board consent (promised), oldest first. */
export function boardConsentQueue(db: DB): EquityGrant[] {
  return db.grants
    .filter((g) => g.status === 'promised')
    .sort(
      (a, b) =>
        (a.proposedOn ?? a.vestingStart).localeCompare(b.proposedOn ?? b.vestingStart) ||
        holderName(db, a).localeCompare(holderName(db, b)),
    )
}

/**
 * Tab-separated consent table for counsel or the cap table tool, with a header row:
 * Name, Shares, Type, Strike, Vest start, Schedule. Pass the intended board date as `date`. Promised grants
 * show the 409A in effect on that date, the strike approveGrants will set (with `keepStrike`, the stored
 * strike, as in approveGrants); the stored strike is used when no 409A is on file and for approved grants.
 */
export function consentTableText(db: DB, grantIds: ID[], date: ISODate, opts: { keepStrike?: boolean } = {}): string {
  const fmv = current409A(db, date)?.fmvPerShare
  const rows = grantIds
    .map((id) => db.grants.find((g) => g.id === id))
    .filter((g): g is EquityGrant => !!g)
    .map((g) => {
      const priceAtGrant = g.status === 'promised' && !opts.keepStrike && fmv != null
      const strike = priceAtGrant ? fmv : g.strikePrice || fmv
      return [holderName(db, g), num(g.shares), g.type, strike ? money2(strike) : 'Set at grant', g.vestingStart, scheduleText(g)].join('\t')
    })
  return [['Name', 'Shares', 'Type', 'Strike', 'Vest start', 'Schedule'].join('\t'), ...rows].join('\n')
}

export type ApproveGrantsResult = {
  approved: ID[]
  /** Ids that were not promised grants and were left alone. */
  skipped: ID[]
  /** True when these are the company's first option grants (the 25102(o) notice clock starts). */
  firstIssuance: boolean
  /** California 25102(o) notice due date, 30 days after the first issuance (docs/SPEC.md). */
  notice25102oDueOn?: ISODate
  /** 409A warnings on the board date, plus a note when the board date is after `date`. */
  warnings: string[]
}

/**
 * Marks promised grants as board approved on `boardDate`. By default the strike is set to the 409A in
 * effect on the board date (options are priced at grant).
 * The 25102(o) notice is due 30 days after the first issuance, so equity.firstIssuanceOn is the earliest board
 * approval on record: when it is unset and earlier grants were already approved (approved, or cancelled after
 * board approval), it is set to the earliest of those and this is not the first issuance (with a warning when
 * no filing is recorded). Only with no earlier approval is it set to the board date and the notice clock started.
 */
export function approveGrants(
  draft: Draft<DB>,
  grantIds: ID[],
  boardDate: ISODate,
  opts: { date: ISODate; keepStrike?: boolean },
): ApproveGrantsResult {
  const db = draft as DB
  const warnings = valuationWarnings(db, boardDate)
    .filter((w) => w.kind !== 'strike')
    .map((w) => w.text)
  if (boardDate > opts.date) warnings.push(`The board date ${fmtDate(boardDate)} is after today.`)
  // Earliest earlier board approval, read before this approval changes any status.
  const earlier = db.grants
    .filter((g) => (g.status === 'approved' || g.status === 'cancelled') && !!g.boardApprovedOn)
    .map((g) => g.boardApprovedOn as ISODate)
    .sort()[0]
  const fmv = current409A(db, boardDate)?.fmvPerShare
  const approved: ID[] = []
  const skipped: ID[] = []
  let noStrike = 0
  for (const id of grantIds) {
    const g = draft.grants.find((x) => x.id === id)
    if (!g || g.status !== 'promised') {
      skipped.push(id)
      continue
    }
    // Options are priced at fair market value on the grant date: with no 409A in effect and no strike
    // entered, approving would record a $0 strike, so the grant waits for a valuation.
    if (g.type !== 'RSA' && fmv == null && !(g.strikePrice > 0)) {
      skipped.push(id)
      noStrike++
      continue
    }
    g.status = 'approved'
    g.boardApprovedOn = boardDate
    if (!opts.keepStrike && fmv != null) g.strikePrice = fmv
    approved.push(id)
    log(draft, {
      entityType: 'equity',
      entityId: g.id,
      relatedId: g.personId,
      kind: 'grant_approved',
      // No share counts or prices: activity can be seen outside Admin.
      text: `Board approved the ${g.type === 'RSA' ? 'restricted stock' : 'option'} grant for ${holderName(db, g)} (board date ${fmtDate(boardDate)})`,
    })
  }
  if (noStrike) {
    warnings.push(
      `${noStrike === 1 ? '1 option grant was' : `${noStrike} option grants were`} not approved: no 409A valuation is in effect on ${fmtDate(boardDate)}, so there is no strike price. Add a 409A first.`,
    )
  }
  let firstIssuance = false
  let notice25102oDueOn: ISODate | undefined
  const prior = [draft.equity.firstIssuanceOn, earlier].filter((d): d is ISODate => !!d).sort()[0]
  if (approved.length && prior && prior <= boardDate) {
    if (!draft.equity.firstIssuanceOn) {
      // Earlier approvals exist but the first issuance was never recorded: record the earliest one.
      draft.equity.firstIssuanceOn = prior
      const due = addDays(prior, 30)
      log(draft, {
        entityType: 'equity',
        entityId: 'equity',
        kind: 'first_issuance',
        text: `First option grants recorded as of ${fmtDate(prior)}, the earliest board approval on file. The California 25102(o) notice was due by ${fmtDate(due)}.`,
      })
      if (!draft.equity.filing25102oOn) {
        warnings.push(
          `The California 25102(o) notice was due by ${fmtDate(due)}, 30 days after the first option grants on ${fmtDate(prior)}. No filing is recorded, so file it now or record the filing date.`,
        )
      }
    }
  } else if (approved.length) {
    // No earlier approval (or this board date comes before every one on file): this is the first issuance.
    firstIssuance = true
    draft.equity.firstIssuanceOn = boardDate
    notice25102oDueOn = addDays(boardDate, 30)
    log(draft, {
      entityType: 'equity',
      entityId: 'equity',
      kind: 'first_issuance',
      text: `First option grants recorded on ${fmtDate(boardDate)}. The California 25102(o) notice is due by ${fmtDate(notice25102oDueOn)}.`,
    })
  }
  return { approved, skipped, firstIssuance, ...(notice25102oDueOn ? { notice25102oDueOn } : {}), warnings }
}

/** Last day to exercise vested options after leaving: last day + the grant's post-termination window (90 days by default). */
export function exerciseDeadline(grant: Pick<EquityGrant, 'postTerminationExerciseDays'>, lastDay: ISODate): ISODate {
  return addDays(lastDay, grant.postTerminationExerciseDays > 0 ? grant.postTerminationExerciseDays : 90)
}

// ---------------------------------------------------------------------------------------------
// Per-person summary
// ---------------------------------------------------------------------------------------------

export type GrantSummary = {
  /** Grants that count for the person: approved, promised, or cancelled with shares kept. */
  grants: EquityGrant[]
  totalShares: number
  vested: number
  unvested: number
  exercised: number
  /** Shares in promised grants (waiting for board consent). */
  awaitingBoard: number
  /** Shares reserved by an offer that is still out. */
  reserved: number
  nextVest: { date: ISODate; shares: number } | null
  /** The next cliff, or the most recent one once all cliffs have passed. */
  cliff: { date: ISODate; shares: number; passed: boolean } | null
  fullyVestedOn: ISODate | null
  pctFullyDiluted: number
  status: 'none' | 'reserved' | 'awaiting_board' | 'pre_cliff' | 'vesting' | 'fully_vested' | 'ended'
  text: string
}

export function grantSummary(db: DB, personId: ID, date: ISODate): GrantSummary {
  const all = grantsFor(db, personId)
  const grants = all.filter((g) => isLive(g.status) || (g.status === 'cancelled' && sharesHeld(g) > 0))
  const reserved = all.filter((g) => g.status === 'reserved').reduce((t, g) => t + g.shares, 0)
  const totalShares = grants.reduce((t, g) => t + sharesHeld(g), 0)
  const vested = grants.reduce((t, g) => t + vestedHeld(db, g, date), 0)
  const exercised = grants.reduce((t, g) => t + (g.exercisedShares ?? 0), 0)
  const awaitingBoard = grants.filter((g) => g.status === 'promised').reduce((t, g) => t + sharesHeld(g), 0)
  const live = grants.filter((g) => liveOn(db, g, date))

  let nextVest: GrantSummary['nextVest'] = null
  let cliff: GrantSummary['cliff'] = null
  for (const g of live) {
    const credited = creditedMonths(g.vestingStart, date)
    if (credited >= g.vestingMonths) continue
    const nextM = credited < g.cliffMonths ? g.cliffMonths : credited + 1
    const nextDate = addMonths(g.vestingStart, Math.max(nextM, 1))
    const shares = vestAtMonth(g, Math.max(nextM, 1)) - vestAtMonth(g, credited)
    if (shares > 0) {
      if (!nextVest || nextDate < nextVest.date) nextVest = { date: nextDate, shares }
      else if (nextDate === nextVest.date) nextVest = { date: nextDate, shares: nextVest.shares + shares }
    }
  }
  for (const g of grants) {
    if (g.cliffMonths <= 0) continue
    const d = cliffDate(g)
    const c = { date: d, shares: vestAtMonth(g, g.cliffMonths), passed: d <= date }
    if (!c.passed && !liveOn(db, g, date)) continue
    if (!cliff) cliff = c
    else if (!c.passed && (cliff.passed || d < cliff.date)) cliff = c
    else if (c.passed && cliff.passed && d > cliff.date) cliff = c
  }
  const fullyVestedOn = live.length ? live.map((g) => fullyVestedDate(g)).sort().reverse()[0] : null
  const ended = grants.length > 0 && live.length === 0 && grants.every((g) => g.status === 'cancelled' || !!holderEndDate(db, g))

  let status: GrantSummary['status']
  let text: string
  if (!grants.length) {
    status = reserved ? 'reserved' : 'none'
    text = reserved ? `${num(reserved)} options reserved in an offer` : 'No equity grants'
  } else if (ended) {
    status = 'ended'
    text = `${num(vested)} vested options kept after leaving`
  } else if (awaitingBoard === totalShares) {
    status = 'awaiting_board'
    text = 'Grant awaiting board consent'
  } else if (vested >= totalShares) {
    status = 'fully_vested'
    text = `Fully vested: ${plural(totalShares, 'option')}`
  } else if (vested === 0) {
    status = 'pre_cliff'
    text = cliff && !cliff.passed ? `${num(cliff.shares)} options vest at the cliff on ${fmtDate(cliff.date)}` : `${num(totalShares)} options, none vested yet`
  } else {
    status = 'vesting'
    text = `${num(vested)} of ${num(totalShares)} vested${nextVest ? `; next ${num(nextVest.shares)} on ${fmtShort(nextVest.date)}` : ''}`
  }
  return {
    grants,
    totalShares,
    vested,
    unvested: Math.max(0, totalShares - vested),
    exercised,
    awaitingBoard,
    reserved,
    nextVest,
    cliff,
    fullyVestedOn,
    pctFullyDiluted: pctOfFullyDiluted(db, totalShares),
    status,
    text,
  }
}
