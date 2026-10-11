// Comp and plan (#comp[.plan|.bands|.table|.equity|.cost]): what we pay, what we've granted, who we hire
// next and what it costs. Admin only; the person panels below are reused by People, Me and Home.
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { boardConsentQueue } from '@/domain/equity'
import { outOfBand } from '@/domain/pay'
import { today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { EmptyState, PageHeader, Tabs } from '@/ui'
import { BandsTab } from './BandsTab'
import { CompTableTab } from './CompTableTab'
import { CostTab } from './CostTab'
import { EquityTab } from './EquityTab'
import { PlanTab } from './PlanTab'

type TabKey = 'plan' | 'bands' | 'table' | 'equity' | 'cost'
const TABS: TabKey[] = ['plan', 'bands', 'table', 'equity', 'cost']

export function CompPage({ route }: PageProps) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const seg = route.segments[1] as TabKey | undefined
  const tab: TabKey = seg && TABS.includes(seg) ? seg : 'plan'
  if (viewer.role !== 'admin') {
    return (
      <>
        <PageHeader title="Comp and plan" />
        <EmptyState icon="lock" title="Admins only" body="Comp and plan shows everyone's pay and equity, so only the Admin view opens it." />
      </>
    )
  }
  const queue = boardConsentQueue(db).length
  const oob = outOfBand(db, today()).length
  return (
    <>
      <PageHeader
        title="Comp and plan"
        subtitle="What we pay, what we've granted, who we hire next and what it costs. Press B to blur amounts when sharing your screen."
      />
      <Tabs
        label="Comp and plan sections"
        value={tab}
        className="mb-5"
        tabs={[
          { key: 'plan', label: 'Headcount plan', href: links.comp('plan') },
          { key: 'bands', label: 'Levels and bands', href: links.comp('bands') },
          { key: 'table', label: 'Comp table', href: links.comp('table'), ...(oob ? { count: oob } : {}) },
          { key: 'equity', label: 'Equity', href: links.comp('equity'), ...(queue ? { count: queue } : {}) },
          { key: 'cost', label: 'Cost and runway', href: links.comp('cost') },
        ]}
      />
      {tab === 'plan' && <PlanTab />}
      {tab === 'bands' && <BandsTab />}
      {tab === 'table' && <CompTableTab />}
      {tab === 'equity' && <EquityTab />}
      {tab === 'cost' && <CostTab />}
    </>
  )
}

export { ChangeJobSheet, PeopleCostCard, PersonEquityPanel, PersonJobPayPanel } from './panels'
