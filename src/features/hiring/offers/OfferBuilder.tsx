// Offer builder on one screen: level picks the band, base defaults from offerDefaults (desired pay when
// inside the band, else the midpoint, snapped to $1K) with the position-in-band meter, variable,
// sign-on, equity (shares, % fully diluted, strike estimate at the current 409A, internal only, no
// paper value), start date (Mondays), expiry (5 business days), the exempt check, a one-tap exception
// reason above band or guideline, and contingencies. Approval routes to Admin only when a non-admin drafts.
import { useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { canDraftOffer } from '@/domain/access'
import {
  approvalRequired,
  approveOffer,
  createOffer,
  defaultStartDate,
  effectiveBand,
  exemptCheck,
  offerDefaults,
  offerEquitySummary,
  offerExceptions,
  type OfferPatch,
  submitForApproval,
  updateOffer,
} from '@/domain/hiring/offers'
import { candidateName, dbHolidays, snapTo } from '@/domain/hiring/util'
import { NOT_LEGAL_ADVICE } from '@/domain/compliance'
import { fullName, isEmployedOn } from '@/domain/people'
import type { ExemptionBasis, FLSA, ID, Offer } from '@/domain/types'
import { fmtDate, nowISO, today } from '@/lib/dates'
import { money2, num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Button,
  Callout,
  ChipGroup,
  ChipMulti,
  CitationChip,
  DateChips,
  Field,
  focusFirstInvalid,
  FormGrid,
  Money,
  MoneyInput,
  NumberInput,
  Private,
  Segmented,
  Select,
  Sheet,
  TextInput,
  toast,
} from '@/ui'
import { act } from '../interviews/common'
import { BandMeter } from './BandMeter'
import { exceptionReasonChoices, expiryPresets, peerBases, startDatePresets } from './logic'

type Form = {
  levelId: ID
  payType: 'salary' | 'hourly'
  salary: number | null
  hourlyRate: number | null
  /** Percent of base (10 = 10%). */
  variablePct: number | null
  signOnBonus: number | null
  equityShares: number | null
  startDate: string
  expiresOn: string
  flsa: FLSA
  exemptionBasis?: ExemptionBasis
  exceptionReason: string
  contingencies: Offer['contingencies']
  managerId: ID
  hoursPerWeek: number
}

const BASIS_OPTIONS: Array<{ value: ExemptionBasis; label: string }> = [
  { value: 'computer_professional', label: 'Computer professional' },
  { value: 'professional', label: 'Professional (licensed, for example CPA)' },
  { value: 'administrative', label: 'Administrative' },
  { value: 'executive', label: 'Executive (manages 2 or more people)' },
  { value: 'outside_sales', label: 'Outside sales' },
]

const CONTINGENCY_OPTIONS: Array<{ value: Offer['contingencies'][number]; label: string }> = [
  { value: 'background_check', label: 'Background check' },
  { value: 'i9', label: 'I-9 work authorization' },
  { value: 'piia', label: 'PIIA signed' },
]

export function OfferBuilder({ applicationId, offerId, open, onClose }: { applicationId: ID; offerId?: ID; open: boolean; onClose: () => void }) {
  if (!open) return null
  return <BuilderForm key={offerId ?? 'new'} applicationId={applicationId} offerId={offerId} onClose={onClose} />
}

function BuilderForm({ applicationId, offerId, onClose }: { applicationId: ID; offerId?: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const holidays = dbHolidays(db)
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const existing = offerId ? db.offers.find((o) => o.id === offerId) : undefined
  // Defaults are computed once, when the builder opens.
  const [defaults] = useState<Partial<Offer>>(() => offerDefaults(db, applicationId, date))
  const start = existing ?? defaults
  const [f, setF] = useState<Form>(() => ({
    levelId: start.levelId ?? job?.levelId ?? '',
    payType: start.payType ?? 'salary',
    salary: start.salary ?? null,
    hourlyRate: start.hourlyRate ?? null,
    variablePct: start.variablePct != null ? Math.round(start.variablePct * 1000) / 10 : 0,
    signOnBonus: start.signOnBonus ?? 0,
    equityShares: start.equityShares ?? 0,
    startDate: start.startDate ?? defaultStartDate(date, holidays),
    expiresOn: start.expiresOn ?? date,
    flsa: start.flsa ?? 'exempt',
    ...(start.exemptionBasis ? { exemptionBasis: start.exemptionBasis } : {}),
    exceptionReason: start.exceptionReason ?? '',
    contingencies: start.contingencies ?? ['i9', 'piia'],
    managerId: start.managerId ?? job?.hiringManagerId ?? '',
    hoursPerWeek: start.hoursPerWeek ?? 40,
  }))
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const [tried, setTried] = useState(false)

  const levels = useMemo(() => {
    if (!job) return []
    const ids = new Set(db.bands.filter((b) => b.familyId === job.familyId).map((b) => b.levelId))
    ids.add(job.levelId)
    return db.levels.filter((l) => ids.has(l.id)).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
  }, [db.bands, db.levels, job])

  if (!app || !job || !cand) {
    return (
      <Sheet open onClose={onClose} title="Offer">
        <p className="text-[14px] text-ink-2">This application is no longer on file.</p>
      </Sheet>
    )
  }
  if (!canDraftOffer(viewer, db, app)) {
    return (
      <Sheet open onClose={onClose} title="Offer">
        <Callout tone="neutral" icon="lock" title="Offers are drafted by Admin or the job's hiring manager" />
      </Sheet>
    )
  }

  const name = candidateName(db, app.candidateId)
  const band = effectiveBand(db, job.familyId, f.levelId, job)
  const fd = db.equity.fullyDilutedShares
  const isAdmin = viewer.role === 'admin'
  const annual = f.payType === 'hourly' ? Math.round((f.hourlyRate ?? 0) * 2080) : (f.salary ?? 0)
  const patch: OfferPatch = {
    levelId: f.levelId,
    payType: f.payType,
    salary: f.payType === 'salary' && f.salary ? f.salary : undefined,
    hourlyRate: f.payType === 'hourly' && f.hourlyRate ? f.hourlyRate : undefined,
    variablePct: f.variablePct ? Math.round(f.variablePct * 10) / 1000 : undefined,
    signOnBonus: f.signOnBonus ? f.signOnBonus : undefined,
    equityShares: f.equityShares ?? 0,
    startDate: f.startDate,
    expiresOn: f.expiresOn,
    flsa: f.flsa,
    exemptionBasis: f.flsa === 'exempt' ? f.exemptionBasis : undefined,
    contingencies: f.contingencies,
    managerId: f.managerId,
    hoursPerWeek: f.hoursPerWeek,
  }
  const draftOffer = { ...(defaults as Offer), ...(existing ?? {}), ...patch, exceptionReason: f.exceptionReason } as Offer
  const exceptions = offerExceptions(db, draftOffer)
  const needsReason = exceptions.length > 0
  const reasonMissing = needsReason && !f.exceptionReason.trim()
  const check = exemptCheck(db, {
    flsa: f.flsa,
    payType: f.payType,
    ...(f.salary != null ? { salary: f.salary } : {}),
    ...(f.hourlyRate != null ? { hourlyRate: f.hourlyRate } : {}),
    familyId: job.familyId,
    ...(f.exemptionBasis ? { exemptionBasis: f.exemptionBasis } : {}),
    hoursPerWeek: f.hoursPerWeek,
    locationId: draftOffer.locationId,
  })
  const equity = offerEquitySummary(db, { equityShares: f.equityShares ?? 0, equityType: draftOffer.equityType ?? 'ISO', vestingMonths: draftOffer.vestingMonths ?? 48, cliffMonths: draftOffer.cliffMonths ?? 12 }, date)
  const peers = isAdmin ? peerBases(db.people, db.comp, job.familyId, f.levelId, date) : undefined
  const needsApproval = approvalRequired(db, existing ?? { draftedById: viewer.personId ?? undefined, draftedByRole: viewer.role, createdOn: date }, date)
  const payMissing = f.payType === 'salary' ? !f.salary : !f.hourlyRate
  const managers = db.people.filter((p) => isEmployedOn(p, date)).sort((a, b) => a.hireNumber - b.hireNumber)

  const pickLevel = (levelId: ID) => {
    const b = effectiveBand(db, job.familyId, levelId, job)
    setF((x) => {
      const next: Form = { ...x, levelId }
      if (b) {
        const desired = cand.desiredPay
        const baseAmt = desired != null && desired >= b.min && desired <= b.max ? snapTo(desired, 1000) : snapTo(b.mid, 1000)
        if (x.payType === 'salary') next.salary = baseAmt
        else next.hourlyRate = snapTo(baseAmt / 2080, 0.25)
        next.equityShares = snapTo(((b.equityMinPct + b.equityMaxPct) / 2) * fd, 500)
        if (b.variablePct != null) next.variablePct = Math.round(b.variablePct * 1000) / 10
      }
      return next
    })
  }

  const save = (mode: 'draft' | 'submit' | 'approve') => {
    setTried(true)
    if (payMissing) {
      focusFirstInvalid()
      return
    }
    if (mode !== 'draft' && reasonMissing) {
      toast({ text: 'Pick an exception reason first: the offer is above the band or the equity guideline.', tone: 'neutral' })
      focusFirstInvalid()
      return
    }
    const reason = needsReason ? f.exceptionReason.trim() || undefined : undefined
    const label =
      mode === 'submit'
        ? `Sent the offer for ${name} for approval`
        : mode === 'approve'
          ? `Approved the offer for ${name}`
          : existing
            ? `Saved the offer for ${name}`
            : `Drafted an offer for ${name}`
    const res = act(label, (d) => {
      let id = existing?.id
      if (existing) {
        const r = updateOffer(d, existing.id, { ...patch, exceptionReason: reason }, { date })
        if (!r.ok) return r
      } else {
        const full: Omit<Offer, 'id'> = {
          ...(defaults as Omit<Offer, 'id'>),
          ...patch,
          ...(reason ? { exceptionReason: reason } : {}),
          ...(viewer.personId ? { draftedById: viewer.personId } : {}),
          draftedByRole: viewer.role,
          status: 'draft',
          createdOn: date,
          approvals: [],
        }
        id = createOffer(d, full)
      }
      if (!id) return { ok: false as const, reason: 'Offer not found.' }
      const o = d.offers.find((x) => x.id === id)
      if (mode === 'submit' && o && o.status === 'draft') return submitForApproval(d, id, { date })
      if (mode === 'approve' && viewer.personId) return o?.status === 'approved' ? { ok: true as const } : approveOffer(d, id, { approverId: viewer.personId, at: nowISO() })
      return { ok: true as const }
    })
    if (res) onClose()
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {needsApproval && !isAdmin && (
        <>
          <Button onClick={() => save('draft')}>Save draft</Button>
          <Button variant="primary" size="lg" icon="send" onClick={() => save('submit')}>
            Submit for approval
          </Button>
        </>
      )}
      {isAdmin && needsApproval && (
        <>
          <Button onClick={() => save('draft')}>Save changes</Button>
          <Button variant="primary" size="lg" icon="check" onClick={() => save('approve')}>
            Save and approve
          </Button>
        </>
      )}
      {!needsApproval && (
        <Button variant="primary" size="lg" icon="check" onClick={() => save('draft')}>
          Save offer
        </Button>
      )}
    </>
  )

  return (
    <Sheet open onClose={onClose} width={680} title={existing ? `Edit offer: ${name}` : `Make offer: ${name}`} subtitle={`${job.title}${existing ? `, version ${existing.version}` : ''}`} footer={footer}>
      <div className="flex flex-col gap-6">
        {!isAdmin && needsApproval && (
          <Callout tone="accent" icon="info" title="This offer goes to Admin for approval">
            Hiring managers draft offers inside the band. Admin approves before it goes out.
          </Callout>
        )}

        <Field label="Level">
          {() => (
            <div className="flex flex-col gap-2">
              <ChipGroup label="Level" value={f.levelId} onChange={pickLevel} options={levels.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))} />
              {band ? (
                <p className="text-[13px] text-ink-3">
                  Band: <Money value={band.min} /> min, <Money value={band.mid} /> mid, <Money value={band.max} /> max
                  {band.equityMaxPct > 0 && (
                    <>
                      . Equity guideline {pct(band.equityMinPct)} to {pct(band.equityMaxPct)} of fully diluted
                    </>
                  )}
                  .
                </p>
              ) : (
                <p className="text-[13px] text-ink-3">No band for this level yet. Set one in Comp and plan.</p>
              )}
            </div>
          )}
        </Field>

        <section aria-labelledby="ob-base" className="flex flex-col gap-3">
          <h3 id="ob-base" className="text-[15px] font-bold text-ink">
            Base pay
          </h3>
          {f.payType === 'salary' ? (
            <Field label="Base salary (per year)" error={tried && payMissing ? 'Add the base salary.' : undefined}>
              {(id, describedBy) => <MoneyInput id={id} aria-describedby={describedBy} value={f.salary} onChange={(v) => set('salary', v)} />}
            </Field>
          ) : (
            <Field label="Hourly rate" error={tried && payMissing ? 'Add the hourly rate.' : undefined}>
              {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} prefix="$" suffix="/ hour" step={0.25} min={0} value={f.hourlyRate} onChange={(v) => set('hourlyRate', v)} />}
            </Field>
          )}
          {band && f.payType === 'salary' && (
            <ChipGroup
              size="sm"
              label="Quick base amounts"
              value={String(f.salary ?? '')}
              onChange={(v) => set('salary', Number(v))}
              options={[
                { value: String(snapTo(band.min, 1000)), label: 'Band min' },
                { value: String(snapTo(band.mid, 1000)), label: 'Midpoint' },
                ...(cand.desiredPay != null ? [{ value: String(snapTo(cand.desiredPay, 1000)), label: 'Desired pay' }] : []),
                { value: String(snapTo(band.max, 1000)), label: 'Band max' },
              ].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i)}
            />
          )}
          {band && <BandMeter band={band} offer={annual || null} desired={cand.desiredPay ?? null} {...(peers ? { peers } : {})} />}
          {!isAdmin && <p className="text-[12.5px] text-ink-3">Peer positions are visible to Admin only.</p>}
        </section>

        <FormGrid>
          <Field
            label="Variable target"
            hint={
              f.variablePct ? (
                <>
                  About <Money value={Math.round(annual * (f.variablePct / 100))} /> a year at target
                  {job.familyId === 'f-gtm' && (
                    <>
                      , OTE <Money value={Math.round(annual * (1 + f.variablePct / 100))} />
                    </>
                  )}
                  .
                </>
              ) : (
                'No variable pay.'
              )
            }
          >
            {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} suffix="% of base" min={0} step={1} value={f.variablePct} onChange={(v) => set('variablePct', v)} />}
          </Field>
          <Field label="Sign-on bonus">
            {(id) => <MoneyInput id={id} value={f.signOnBonus} onChange={(v) => set('signOnBonus', v)} />}
          </Field>
        </FormGrid>
        <ChipGroup
          size="sm"
          label="Quick sign-on amounts"
          value={String(f.signOnBonus ?? 0)}
          onChange={(v) => set('signOnBonus', Number(v))}
          options={[
            { value: '0', label: 'No sign-on' },
            { value: '10000', label: '$10K' },
            { value: '25000', label: '$25K' },
          ]}
        />

        <section aria-labelledby="ob-equity" className="flex flex-col gap-3">
          <h3 id="ob-equity" className="text-[15px] font-bold text-ink">
            Equity
          </h3>
          <Field label="Stock options (shares)">
            {(id) => <NumberInput id={id} min={0} step={500} value={f.equityShares} onChange={(v) => set('equityShares', v)} />}
          </Field>
          {band && band.equityMaxPct > 0 && (
            <ChipGroup
              size="sm"
              label="Equity guideline"
              value={String(f.equityShares ?? 0)}
              onChange={(v) => set('equityShares', Number(v))}
              options={[
                { value: String(snapTo(band.equityMinPct * fd, 500)), label: 'Guideline low' },
                { value: String(snapTo(((band.equityMinPct + band.equityMaxPct) / 2) * fd, 500)), label: 'Guideline mid' },
                { value: String(snapTo(band.equityMaxPct * fd, 500)), label: 'Guideline high' },
              ]}
            />
          )}
          <div className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13.5px] text-ink-2">
            <p>
              <Private className="font-semibold text-ink">{num(f.equityShares ?? 0)} options</Private>, <Private>{pct(equity.pctFD)}</Private> of <Private>{num(fd)}</Private> fully diluted shares. {equity.vesting}.
            </p>
            <p className="mt-1">
              Strike estimate:{' '}
              {equity.strikeEstimate != null ? (
                <>
                  <Private className="font-semibold text-ink">{money2(equity.strikeEstimate)}</Private> a share at the current 409A
                  {equity.valuationOn ? ` (${fmtDate(equity.valuationOn)})` : ''}.
                </>
              ) : (
                'no 409A on file yet.'
              )}{' '}
              Internal only: the board sets the strike at grant. The letter never shows a dollar value for the equity.
            </p>
          </div>
        </section>

        <Field label="Start date" hint="Mondays shown. A start date on a holiday moves to the next business day in onboarding.">
          {(id) => <DateChips id={id} label="Start date" value={f.startDate} onChange={(v) => set('startDate', v)} presets={startDatePresets(defaultStartDate(date, holidays))} min={date} weekdaysOnly />}
        </Field>
        <Field label="Offer expires">
          {(id) => <DateChips id={id} label="Offer expires" value={f.expiresOn} onChange={(v) => set('expiresOn', v)} presets={expiryPresets(date, holidays)} min={date} />}
        </Field>

        <section aria-labelledby="ob-flsa" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="ob-flsa" className="text-[15px] font-bold text-ink">
              Exempt check
            </h3>
            <Segmented
              size="sm"
              label="Overtime classification"
              value={f.flsa}
              onChange={(v) => setF((x) => ({ ...x, flsa: v, ...(v === 'exempt' && !x.exemptionBasis ? { exemptionBasis: defaults.exemptionBasis ?? 'administrative' } : {}) }))}
              options={[
                { value: 'exempt', label: 'Exempt' },
                { value: 'non_exempt', label: 'Non-exempt' },
              ]}
            />
          </div>
          {f.flsa === 'exempt' && (
            <Field label="Exemption">
              {(id) => <Select id={id} value={f.exemptionBasis ?? ''} onChange={(v) => set('exemptionBasis', v)} options={BASIS_OPTIONS} />}
            </Field>
          )}
          {f.flsa === 'non_exempt' && (
            <FormGrid>
              <Field label="Pay basis">
                {() => (
                  <Segmented
                    size="sm"
                    label="Pay basis"
                    value={f.payType}
                    onChange={(v) => setF((x) => ({ ...x, payType: v, ...(v === 'hourly' && !x.hourlyRate && x.salary ? { hourlyRate: snapTo(x.salary / 2080, 0.25) } : {}), ...(v === 'salary' && !x.salary && x.hourlyRate ? { salary: snapTo(x.hourlyRate * 2080, 1000) } : {}) }))}
                    options={[
                      { value: 'salary', label: 'Salary' },
                      { value: 'hourly', label: 'Hourly' },
                    ]}
                  />
                )}
              </Field>
              <Field label="Hours a week">
                {(id) => <NumberInput id={id} min={1} max={60} value={f.hoursPerWeek} onChange={(v) => set('hoursPerWeek', v ?? 40)} />}
              </Field>
            </FormGrid>
          )}
          {check.status === 'ok' ? (
            <Callout tone="good" title={f.flsa === 'exempt' ? 'Pay meets the California exempt minimum' : 'Non-exempt'}>
              {f.flsa === 'exempt' ? `Checked against the ${db.settings.law.year} floors. Duties tests still apply.` : check.messages.join(' ')}
            </Callout>
          ) : (
            <Callout
              tone="warn"
              title={check.mustBeNonExempt ? 'This pay cannot support an exemption' : 'Check the classification'}
              action={
                check.mustBeNonExempt ? (
                  <Button size="sm" onClick={() => set('flsa', 'non_exempt')}>
                    Make it non-exempt
                  </Button>
                ) : undefined
              }
            >
              {check.messages.map((m) => (
                <span key={m} className="mt-1 block">
                  {m}
                </span>
              ))}
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {[...new Map(check.citations.map((c) => [c.label, c])).values()].map((c) => (
              <CitationChip key={c.label} label={c.label} url={c.url} />
            ))}
            <span className="text-[12.5px] text-ink-3">{NOT_LEGAL_ADVICE}</span>
          </div>
          {f.flsa === 'non_exempt' && <p className="text-[13px] text-ink-3">The Labor Code 2810.5 wage notice is prepared with the letter. Give it by the start date.</p>}
        </section>

        {needsReason && (
          <section aria-labelledby="ob-exc" className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3.5 py-3">
            <h3 id="ob-exc" className="text-[15px] font-bold text-ink">
              Exception reason {tried && reasonMissing && <span className="text-[13px] font-semibold text-warn">(needed before it goes out)</span>}
            </h3>
            {exceptions.map((e) => (
              <p key={e.field} className="text-[13.5px] text-ink-2">
                <Private>{e.message}</Private>
              </p>
            ))}
            <ChipGroup
              size="sm"
              label="Exception reason"
              value={exceptionReasonChoices().includes(f.exceptionReason) ? f.exceptionReason : null}
              onChange={(v) => set('exceptionReason', v)}
              options={exceptionReasonChoices().map((r) => ({ value: r, label: r }))}
            />
            <Field label="Or in your own words" error={tried && reasonMissing ? 'Pick a reason above or write one here before the offer goes out.' : undefined}>
              {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} value={f.exceptionReason} onChange={(e) => set('exceptionReason', e.target.value)} />}
            </Field>
          </section>
        )}

        <Field label="Contingencies">
          {() => <ChipMulti label="Contingencies" values={f.contingencies} onChange={(v) => set('contingencies', v)} options={CONTINGENCY_OPTIONS} />}
        </Field>
        <Field label="Reports to">
          {(id) => <Select id={id} value={f.managerId} onChange={(v) => set('managerId', v)} options={managers.map((p) => ({ value: p.id, label: `${fullName(p)}, ${p.title}` }))} />}
        </Field>
      </div>
    </Sheet>
  )
}
