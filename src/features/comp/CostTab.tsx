// Cost and runway (docs/SPEC.md, COST AND RUNWAY): fully loaded run-rate now, with incoming hires, with
// offers out and at plan, monthly and annual, with a cost breakdown, contractors shown separately, runway
// from cash on hand, the assumptions (edited in Settings > Company) and spend by department.
import { useMemo, useState } from 'react'
import { links, navigate } from '@/app/router'
import { LAW_SOURCES } from '@/data/law'
import { latestOffers, offerMonthlyImpact, runRate, type RunRate, type RunRateInclude, type RunRateLine, runway } from '@/domain/pay'
import { fmtDate, today } from '@/lib/dates'
import { money, moneyShort, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, BarList, Button, Callout, CitationChip, cx, DataTable, Money, Panel, Private, type Column } from '@/ui'

const SCENARIOS: Array<{ key: RunRateInclude; label: string; hint: string }> = [
  { key: 'now', label: 'Now', hint: 'Employed today' },
  { key: 'with_incoming', label: 'With incoming', hint: 'Plus accepted offers not started' },
  { key: 'with_offers', label: 'With offers', hint: 'Plus offers out' },
  { key: 'at_plan', label: 'At plan', hint: 'Plus open and planned lines' },
]

const KIND: Record<RunRateLine['kind'], { label: string; tone: 'neutral' | 'accent' | 'warn' | 'outline' }> = {
  employee: { label: 'Employee', tone: 'neutral' },
  incoming: { label: 'Starting', tone: 'accent' },
  offer: { label: 'Offer out', tone: 'warn' },
  plan: { label: 'Plan line', tone: 'outline' },
}

function first(name: string) {
  return name.split(' ')[0]
}

export function CostTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const rates = useMemo(() => {
    const out = {} as Record<RunRateInclude, RunRate>
    for (const s of SCENARIOS) out[s.key] = runRate(db, date, { include: s.key })
    return out
  }, [db, date])
  const [scenario, setScenario] = useState<RunRateInclude>('now')
  const [allLines, setAllLines] = useState(false)
  const rr = rates[scenario]
  const rwNow = useMemo(() => runway(db, date, 'now'), [db, date])
  const rwSel = useMemo(() => runway(db, date, scenario), [db, date, scenario])
  const rwPlan = useMemo(() => runway(db, date, 'at_plan'), [db, date])
  const model = db.company.costModel
  const futa = model.taxOverrides?.futaScenario ?? 'waiver'
  const altFuta = useMemo(() => runRate(db, date, { include: scenario, futa: futa === 'waiver' ? 'no_waiver' : 'waiver' }), [db, date, scenario, futa])
  const notes = [...new Set(rr.lines.flatMap((l) => l.cost.employerTaxes.notes))]
  const baseAnnual = rr.lines.reduce((t, l) => t + l.base, 0)
  const multiplier = baseAnnual > 0 ? rr.annual / baseAnnual : 0
  const offerImpacts = useMemo(
    () =>
      rates.with_offers.lines
        .filter((l) => l.kind === 'offer' && l.offerId)
        .map((l) => {
          const o = latestOffers(db).find((x) => x.id === l.offerId)
          return o ? { name: l.name, title: o.title, ...offerMonthlyImpact(db, o) } : null
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
    [db, rates],
  )

  const delta = (i: number) => {
    if (i === 0) return null
    const prev = rates[SCENARIOS[i - 1].key]
    const cur = rates[SCENARIOS[i].key]
    const added = cur.lines.filter((l) => !prev.lines.some((p) => p.key === l.key))
    return { amount: cur.monthly - prev.monthly, names: added.map((l) => (l.kind === 'plan' ? l.name : first(l.name))) }
  }

  const breakdown = [
    { key: 'base', label: 'Base pay', value: rr.breakdown.base },
    { key: 'variable', label: 'Variable at target', value: rr.breakdown.variable },
    { key: 'taxes', label: 'Employer taxes', value: rr.breakdown.employerTaxes },
    { key: 'benefits', label: `Benefits (${money(model.benefitsPerHeadMonthly)} a head)`, value: rr.breakdown.benefits },
    { key: 'peo', label: `PEO and tools (${money(model.peoToolsPerHeadMonthly)} a head)`, value: rr.breakdown.peoTools },
    { key: 'wc', label: `Workers' comp (${pct(model.workersCompPct, 1)} of wages)`, value: rr.breakdown.workersComp },
  ]

  const lineColumns: Array<Column<RunRateLine>> = [
    { key: 'name', header: 'Name', sort: (l) => l.name, cell: (l) => <span className="font-semibold">{l.name}</span> },
    { key: 'kind', header: 'Kind', sort: (l) => l.kind, cell: (l) => <Badge tone={KIND[l.kind].tone}>{KIND[l.kind].label}</Badge> },
    { key: 'dept', header: 'Department', hideBelow: 'md', cell: (l) => db.departments.find((d) => d.id === l.departmentId)?.name ?? '' },
    { key: 'base', header: 'Base', align: 'right', sort: (l) => l.base, cell: (l) => <Money value={Math.round(l.base)} /> },
    { key: 'monthly', header: 'Monthly, loaded', align: 'right', sort: (l) => l.monthly, cell: (l) => <Money value={Math.round(l.monthly)} /> },
  ]

  // Columns follow the tab's own width (a container query), so 150% text and the rail both count.
  return (
    <div className="@container flex flex-col gap-5">
      <div role="radiogroup" aria-label="Cost scenario" className="grid grid-cols-1 gap-3 @[440px]:grid-cols-2 @[640px]:grid-cols-4">
        {SCENARIOS.map((s, i) => {
          const r = rates[s.key]
          const d = delta(i)
          const on = s.key === scenario
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setScenario(s.key)}
              className={cx(
                'ft-scenario',
                on && 'ft-scenario--on',
                'flex min-h-11 flex-col items-start rounded-2xl border px-4 py-3.5 text-left shadow-card transition-colors',
                on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              <span className="text-[13px] font-semibold text-ink-3">
                {s.label} <span className="font-normal">({r.headcount} people)</span>
              </span>
              <span className="num mt-1 font-display text-[26px] leading-none font-bold text-ink">
                <Money value={r.monthly} short />
                <span className="text-[14px] font-semibold text-ink-3"> a month</span>
              </span>
              <span className="mt-1 text-[13px] text-ink-2">
                <Money value={r.annual} short /> a year
              </span>
              <span className="mt-1.5 text-[12.5px] text-ink-3">
                {d && d.names.length ? (
                  <>
                    <Private>
                      +{moneyShort(d.amount)}
                    </Private>{' '}
                    for {d.names.length <= 3 ? d.names.join(', ') : `${d.names.length} more`}
                  </>
                ) : d ? (
                  'No change'
                ) : (
                  s.hint
                )}
              </span>
            </button>
          )
        })}
      </div>

      {offerImpacts.length > 0 && (
        <Callout tone="neutral" icon="send" title="Offers out">
          <ul className="flex flex-col gap-0.5">
            {offerImpacts.map((o) => (
              <li key={o.name}>
                {o.name}, {o.title}: this offer adds <Private>{money(Math.round(o.monthly / 100) * 100)}</Private> a month fully loaded.
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-5 @[720px]:grid-cols-[3fr_2fr]">
        <Panel
          title={`Breakdown: ${SCENARIOS.find((s) => s.key === scenario)?.label.toLowerCase()}`}
          icon="coins"
          subtitle={
            <>
              Fully loaded cost runs about <Private>{multiplier.toFixed(2)}x</Private> base. W-2 only; contractors are below.
            </>
          }
          padded={false}
        >
          <div className="scroll-thin relative overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <caption className="sr-only">Monthly and annual cost by component</caption>
              <thead>
                <tr className="border-b border-line bg-surface-2/60 text-[12.5px] text-ink-3">
                  <th scope="col" className="h-10 px-4 text-left font-bold">
                    Component
                  </th>
                  <th scope="col" className="h-10 px-4 text-right font-bold">
                    Monthly
                  </th>
                  <th scope="col" className="h-10 px-4 text-right font-bold">
                    Annual
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b) => (
                  <tr key={b.key} className="border-b border-line">
                    <th scope="row" className="px-4 py-2.5 text-left font-medium text-ink">
                      {b.label}
                    </th>
                    <td className="px-4 py-2.5 text-right">
                      <Money value={b.value} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Money value={b.value * 12} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="px-4 py-3 text-left font-bold text-ink">
                    Total, fully loaded
                  </th>
                  <td className="px-4 py-3 text-right font-bold">
                    <Money value={rr.monthly} />
                  </td>
                  <td className="px-4 py-3 text-right font-bold">
                    <Money value={rr.annual} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-5 py-4 text-[13px] text-ink-2">
            <p className="font-semibold text-ink">How employer taxes are estimated</p>
            <ul className="mt-1 list-disc pl-5">
              <li>Social Security 6.2% up to the $184,500 wage base, Medicare 1.45% on all wages.</li>
              <li>California UI 3.4% and ETT 0.1%, each on the first $7,000.</li>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>
                FUTA assumption: {futa === 'waiver' ? 'add-on waiver granted' : 'no waiver'}.{' '}
                {futa === 'waiver' ? 'Without the waiver' : 'With the waiver'} this scenario would be{' '}
                <Private>
                  {altFuta.monthly >= rr.monthly ? '+' : '-'}
                  {money(Math.abs(altFuta.monthly - rr.monthly))}
                </Private>{' '}
                a month.
              </li>
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CitationChip label={LAW_SOURCES.fica.label} url={LAW_SOURCES.fica.url} />
              <CitationChip label={LAW_SOURCES.futaCredit.label} url={LAW_SOURCES.futaCredit.url} />
              <CitationChip label={LAW_SOURCES.eddRates.label} url={LAW_SOURCES.eddRates.url} />
              <span className="text-ink-3">Planning estimates, not payroll. Not tax advice.</span>
            </div>
          </div>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="Runway" icon="trend" actions={
              <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings', 'company')}>
                Edit assumptions
              </Button>
            }>
            {rwNow.months == null ? (
              <Callout tone="neutral" title="Add cash on hand to see runway" action={<Button size="sm" onClick={() => navigate('settings', 'company')}>Open Settings</Button>}>
                Runway uses cash on hand, other monthly spend and revenue from Settings, Company.
              </Callout>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[12.5px] font-semibold text-ink-3">At today's burn</div>
                    <div className="num font-display text-[26px] leading-tight font-bold text-ink">
                      {rwNow.months === Infinity ? 'Not shrinking' : `${Math.round(rwNow.months)} months`}
                    </div>
                  </div>
                  <div>
                    <div className="text-[12.5px] font-semibold text-ink-3">If the plan hires on schedule</div>
                    <div className="num font-display text-[26px] leading-tight font-bold text-ink">
                      {rwPlan.months == null ? 'Not set' : rwPlan.months === Infinity ? 'Not shrinking' : `${Math.round(rwPlan.months)} months`}
                    </div>
                  </div>
                </div>
                <p className="text-[13.5px] text-ink-2">{rwSel.text}</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13.5px]">
                  <dt className="text-ink-3">Cash now (estimated)</dt>
                  <dd className="text-right">
                    <Money value={rwSel.cashNow} />
                  </dd>
                  <dt className="text-ink-3">Payroll, loaded</dt>
                  <dd className="text-right">
                    <Money value={rwSel.payrollMonthly} suffix="/mo" />
                  </dd>
                  <dt className="text-ink-3">Contractors</dt>
                  <dd className="text-right">
                    <Money value={rwSel.contractorsMonthly} suffix="/mo" />
                  </dd>
                  <dt className="text-ink-3">Other spend</dt>
                  <dd className="text-right">
                    <Money value={rwSel.otherMonthlySpend} suffix="/mo" />
                  </dd>
                  <dt className="text-ink-3">Revenue</dt>
                  <dd className="text-right">
                    <Private>-{money(rwSel.monthlyRevenue)}/mo</Private>
                  </dd>
                  <dt className="font-semibold text-ink">Net burn</dt>
                  <dd className="text-right font-semibold">
                    <Money value={rwSel.netBurnMonthly} suffix="/mo" />
                  </dd>
                </dl>
                {rwSel.runsOutOn && <p className="text-[12.5px] text-ink-3">At this burn, cash runs out around {fmtDate(rwSel.runsOutOn)}.</p>}
                {rwSel.cashAsOf && <p className="text-[12.5px] text-ink-3">Cash on hand as of {fmtDate(rwSel.cashAsOf)}.</p>}
              </div>
            )}
          </Panel>

          <Panel title="Contractors" icon="briefcase" subtitle="Separate from the run-rate above">
            {rr.contractors.length === 0 ? (
              <p className="text-[14px] text-ink-3">No paid contractors right now.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {rr.contractors.map((c) => (
                  <li key={c.contractorId} className="flex items-start justify-between gap-3 py-2 text-[14px]">
                    <span className="min-w-0">
                      <a href={links.contractor(c.contractorId)} className="inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                        {db.contractors.find((k) => k.id === c.contractorId)?.entityName || c.name}
                      </a>
                      {c.note && <span className="block text-[12.5px] text-ink-3">{c.note}</span>}
                    </span>
                    <Money value={Math.round(c.monthly)} suffix="/mo" />
                  </li>
                ))}
                <li className="flex justify-between gap-3 py-2 text-[14px] font-bold">
                  <span>Total</span>
                  <Money value={rr.contractorsMonthly} suffix="/mo" />
                </li>
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 @[640px]:grid-cols-2">
        <Panel title="By department" icon="chart" subtitle={`${SCENARIOS.find((s) => s.key === scenario)?.label}, fully loaded a month`}>
          <Private className="block">
            <BarList
              ariaLabel="Monthly fully loaded cost by department"
              items={rr.byDepartment.map((d) => ({
                key: d.departmentId,
                label: d.name,
                value: d.monthly,
                display: moneyShort(d.monthly),
                sub: `${d.headcount} ${d.headcount === 1 ? 'person' : 'people'}`,
              }))}
            />
          </Private>
        </Panel>
        <Panel title="Assumptions" icon="settings" actions={
            <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings', 'company')}>
              Edit in Settings
            </Button>
          }>
          <div className="@container">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[14px] @[420px]:grid-cols-2">
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">Benefits per head</dt>
                <dd>
                  <Money value={model.benefitsPerHeadMonthly} suffix=" a month" /> (30+ hours a week)
                </dd>
              </div>
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">PEO and tools per head</dt>
                <dd>
                  <Money value={model.peoToolsPerHeadMonthly} suffix=" a month" />
                </dd>
              </div>
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">Workers' comp</dt>
                <dd>{pct(model.workersCompPct, 1)} of wages</dd>
              </div>
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">FUTA scenario</dt>
                <dd>{futa === 'waiver' ? 'Waiver granted (2.1%)' : 'No waiver (5.9%)'}</dd>
              </div>
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">Cash on hand</dt>
                <dd>
                  <Money value={db.company.cashOnHand} />
                  {db.company.cashAsOf ? ` as of ${fmtDate(db.company.cashAsOf)}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-[12.5px] font-semibold text-ink-3">Other spend and revenue</dt>
                <dd>
                  <Money value={db.company.otherMonthlySpend ?? 0} suffix=" spend" />, <Money value={db.company.monthlyRevenue ?? 0} suffix=" revenue a month" />
                </dd>
              </div>
            </dl>
          </div>
        </Panel>
      </div>

      <Panel
        title="Every line"
        icon="users"
        padded={false}
        actions={
          <Button size="sm" variant="ghost" icon={allLines ? 'chevron-up' : 'chevron-down'} aria-expanded={allLines} onClick={() => setAllLines((v) => !v)}>
            {allLines ? 'Hide lines' : `Show ${rr.lines.length} lines`}
          </Button>
        }
      >
        {allLines ? (
          <DataTable rows={rr.lines} columns={lineColumns} rowKey={(l) => l.key} initialSort={{ key: 'monthly', dir: 'desc' }} dense caption="Run-rate lines" />
        ) : (
          <p className="px-5 py-3 text-[13.5px] text-ink-3">The people, offers and plan lines counted in this scenario, with their loaded monthly cost.</p>
        )}
      </Panel>
    </div>
  )
}
