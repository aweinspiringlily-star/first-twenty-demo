// Org chart, built from managerId, in two views. Chart (the default): one rectangle per person, executives and
// managers on top, each linked by lines to their direct reports below. List: a keyboard-navigable tree (role=tree).
// The list view: arrow keys move, Right and Left expand or collapse, Home and End jump, Enter opens the
// profile. Planned roles from the
// headcount plan show as dashed boxes; incoming people are marked 'Starts Oct 19'.
import { type CSSProperties, useMemo, useRef, useState } from 'react'
import { links, navigate } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { fullName, onLeave } from '@/domain/people'
import type { PlanSlot } from '@/domain/types'
import { fmtQuarter, fmtShort, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Avatar, Badge, Button, cx, Icon, Kbd, Switch } from '@/ui'
import { allOrgIds, buildOrgTree, type OrgNode, visibleOrgNodes } from './helpers'
import { EmpNo } from './parts'

const SLOT_STATUS: Record<PlanSlot['status'], string> = {
  planned: 'Planned',
  open: 'Hiring now',
  offer: 'Offer stage',
  filled: 'Filled',
  cut: 'Cut',
}

function countDescendants(n: OrgNode): number {
  return n.children.reduce((t, c) => t + 1 + countDescendants(c), 0)
}

export function OrgChart() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const canPlan = viewer.role !== 'employee'
  const [showPlanned, setShowPlanned] = useState(true)
  const [showContractors, setShowContractors] = useState(false)
  const roots = useMemo(
    () => buildOrgTree(db, t, { planned: canPlan && showPlanned, contractors: showContractors }),
    [db, t, canPlan, showPlanned, showContractors],
  )
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const expanded = useMemo(() => new Set(allOrgIds(roots).filter((id) => !collapsed.has(id))), [roots, collapsed])
  const visible = useMemo(() => visibleOrgNodes(roots, expanded), [roots, expanded])
  const [focusId, setFocusId] = useState<string | null>(null)
  const active = visible.some((v) => v.node.id === focusId) ? focusId : (visible[0]?.node.id ?? null)
  const refs = useRef(new Map<string, HTMLLIElement>())

  const focus = (id: string | undefined) => {
    if (!id) return
    setFocusId(id)
    refs.current.get(id)?.focus()
  }
  const toggle = (id: string, open?: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s)
      const isOpen = !s.has(id)
      const want = open ?? !isOpen
      if (want) next.delete(id)
      else next.add(id)
      return next
    })

  const openNode = (n: OrgNode) => {
    if (n.kind === 'person' && n.person) navigate('person', n.person.id)
    else if ((n.kind === 'contractor' || n.kind === 'advisor') && n.contractor) navigate('contractor', n.contractor.id)
    else if (n.kind === 'planned' && n.slot) {
      const jobId = n.slot.jobId
      const job = jobId ? db.jobs.find((j) => j.id === jobId) : undefined
      if (job && (viewer.role === 'admin' || job.hiringManagerId === viewer.personId)) navigate('job', job.id)
      else if (viewer.role === 'admin') navigate('comp', 'plan')
    }
  }

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const row = visible[i]
    const n = row.node
    const hasKids = n.children.length > 0
    const isOpen = expanded.has(n.id)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focus(visible[i + 1]?.node.id)
        break
      case 'ArrowUp':
        e.preventDefault()
        focus(visible[i - 1]?.node.id)
        break
      case 'Home':
        e.preventDefault()
        focus(visible[0]?.node.id)
        break
      case 'End':
        e.preventDefault()
        focus(visible[visible.length - 1]?.node.id)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (hasKids && !isOpen) toggle(n.id, true)
        else if (hasKids) focus(n.children[0]?.id)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (hasKids && isOpen) toggle(n.id, false)
        else if (row.parentId) focus(row.parentId)
        break
      case 'Enter':
        e.preventDefault()
        openNode(n)
        break
      case ' ':
        e.preventDefault()
        if (hasKids) toggle(n.id)
        break
    }
  }


  // One rectangle in the chart view, with its direct reports in a row below it.
  const chartNode = (n: OrgNode): React.ReactNode => {
    const p = n.person
    const hasKids = n.children.length > 0
    const isOpen = expanded.has(n.id)
    const incoming = !!p && p.startDate > t
    const leave = p ? onLeave(db, p.id, t) : undefined
    const name =
      n.kind === 'person' && p
        ? fullName(p)
        : n.kind === 'planned' && n.slot
          ? n.slot.title
          : n.contractor
            ? n.contractor.entityName || n.contractor.name
            : n.id
    const sub =
      n.kind === 'person' && p
        ? p.title
        : n.kind === 'planned' && n.slot
          ? `Planned for ${fmtQuarter(n.slot.quarter)}${n.slot.isBackfill ? ', backfill' : ''}`
          : n.contractor
            ? n.contractor.scope
            : ''
    const label =
      n.kind === 'person' && p
        ? `${fullName(p)}, ${p.title}${incoming ? `, starts ${fmtShort(p.startDate)}` : ''}${leave ? ', on leave' : ''}`
        : n.kind === 'planned' && n.slot
          ? `Planned role: ${n.slot.title}, ${fmtQuarter(n.slot.quarter)}, ${SLOT_STATUS[n.slotStatus ?? 'planned']}`
          : `${n.kind === 'advisor' ? 'Advisor' : 'Contractor'}: ${name}`
    return (
      <li key={n.id}>
        <div className="ft-orgchart__cell">
          <button
            type="button"
            aria-label={label}
            onClick={() => openNode(n)}
            className={cx(
              'ft-orgbox',
              n.kind === 'planned' && 'ft-orgbox--planned',
              n.kind !== 'planned' && n.kind !== 'person' && 'ft-orgbox--contractor',
            )}
          >
            {n.kind === 'person' && p ? (
              <Avatar name={name} size={32} />
            ) : n.kind === 'planned' ? (
              <span aria-hidden className="ft-orgbox__plus">
                <Icon name="plus" size={14} />
              </span>
            ) : (
              <Avatar name={name} size={32} muted />
            )}
            <span className="ft-orgbox__name">{name}</span>
            <span className="ft-orgbox__sub">{sub}</span>
            {(incoming || leave || n.kind !== 'person') && (
              <span className="ft-orgbox__badges">
                {incoming && p && <Badge tone="accent">Starts {fmtShort(p.startDate)}</Badge>}
                {leave && <Badge tone="neutral">On leave</Badge>}
                {n.kind === 'planned' && <Badge tone={n.slotStatus === 'open' ? 'accent' : 'outline'}>{SLOT_STATUS[n.slotStatus ?? 'planned']}</Badge>}
                {(n.kind === 'contractor' || n.kind === 'advisor') && <Badge tone="outline">{n.kind === 'advisor' ? 'Advisor' : 'Contractor'}</Badge>}
              </span>
            )}
          </button>
          {hasKids && (
            <button
              type="button"
              className="ft-orgbox__toggle"
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${name}, ${n.children.length} direct ${n.children.length === 1 ? 'report' : 'reports'}`}
              onClick={() => toggle(n.id)}
            >
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
              {n.children.length}
            </button>
          )}
        </div>
        {hasKids && isOpen && <ul>{n.children.map(chartNode)}</ul>}
      </li>
    )
  }

  const siblingsOf = (parentId: string | null) => visible.filter((v) => v.parentId === parentId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {view === 'list' ? (
          <p className="text-[13.5px] text-ink-3">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move, <Kbd>→</Kbd> <Kbd>←</Kbd> expand or collapse, <Kbd>Enter</Kbd> opens the profile.
          </p>
        ) : (
          <p className="text-[13.5px] text-ink-3">Each box is a person. Lines run from a manager down to their direct reports. Select a box to open the profile.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant={view === 'chart' ? 'primary' : 'ghost'} size="sm" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            Chart
          </Button>
          <Button variant={view === 'list' ? 'primary' : 'ghost'} size="sm" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            List
          </Button>
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setCollapsed(new Set())}>
            Expand all
          </Button>
          <Button variant="ghost" size="sm" icon="minus" onClick={() => setCollapsed(new Set(allOrgIds(roots)))}>
            Collapse all
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6">
        {canPlan && <Switch checked={showPlanned} onChange={setShowPlanned} label="Show planned roles" />}
        <Switch checked={showContractors} onChange={setShowContractors} label="Show contractors and advisors" />
      </div>
      {view === 'chart' && visible.length > 0 && (
        <div className="ft-orgchart" role="region" aria-label="Org chart, boxes and lines" tabIndex={0}>
          <ul>{roots.map(chartNode)}</ul>
        </div>
      )}
      <ul role="tree" aria-label="Org chart" className={view === 'list' ? 'flex flex-col gap-1.5' : 'hidden'}>
        {visible.map((row, i) => {
          const n = row.node
          const hasKids = n.children.length > 0
          const isOpen = expanded.has(n.id)
          const sibs = siblingsOf(row.parentId)
          const pos = sibs.findIndex((s) => s.node.id === n.id) + 1
          const p = n.person
          const incoming = !!p && p.startDate > t
          const leave = p ? onLeave(db, p.id, t) : undefined
          const label =
            n.kind === 'person' && p
              ? `#${p.hireNumber} ${fullName(p)}, ${p.title}${incoming ? `, starts ${fmtShort(p.startDate)}` : ''}${leave ? ', on leave' : ''}`
              : n.kind === 'planned' && n.slot
                ? `Planned role: ${n.slot.title}, ${fmtQuarter(n.slot.quarter)}, ${SLOT_STATUS[n.slotStatus ?? 'planned']}`
                : n.contractor
                  ? `${n.kind === 'advisor' ? 'Advisor' : 'Contractor'}: ${n.contractor.entityName || n.contractor.name}`
                  : n.id
          // On phones (4vw < 22px) the indent stops growing after three levels so deep rows keep room for their text.
          const indent = `min(${(row.level - 1) * 22}px, ${Math.min(row.level - 1, 3) * 4}vw)`
          // The step from the parent's indent to this row's (22px, or 4vw on phones up to level 4), for looks
          // that draw connectors (docs/LOOKS.md: --ft-indent-step on the treeitem).
          const parentIndent = `min(${Math.max(0, row.level - 2) * 22}px, ${Math.min(Math.max(0, row.level - 2), 3) * 4}vw)`
          const indentVars = { '--ft-level': row.level, '--ft-indent': indent, '--ft-indent-step': `calc(${indent} - ${parentIndent})` } as CSSProperties
          // Badges sit under the title on phones (they wrap there) and at the row's end from sm up.
          const badges =
            n.kind === 'person' && p ? (
              incoming || leave || (hasKids && !isOpen) ? (
                <>
                  {incoming && (
                    <Badge tone="accent" icon="calendar">
                      Starts {fmtShort(p.startDate)}
                    </Badge>
                  )}
                  {leave && <Badge tone="neutral">On leave</Badge>}
                  {hasKids && !isOpen && <Badge tone="outline">{countDescendants(n)} below</Badge>}
                </>
              ) : null
            ) : n.kind === 'planned' && n.slot ? (
              <Badge tone={n.slotStatus === 'open' ? 'accent' : 'outline'}>{SLOT_STATUS[n.slotStatus ?? 'planned']}</Badge>
            ) : n.contractor ? (
              <Badge tone="outline">{n.kind === 'advisor' ? 'Advisor' : 'Contractor'}</Badge>
            ) : null
          return (
            <li
              key={n.id}
              ref={(el) => {
                if (el) refs.current.set(n.id, el)
                else refs.current.delete(n.id)
              }}
              role="treeitem"
              aria-level={row.level}
              aria-setsize={sibs.length}
              aria-posinset={pos}
              aria-expanded={hasKids ? isOpen : undefined}
              aria-selected={active === n.id}
              aria-label={hasKids ? `${label}, ${countDescendants(n)} below` : label}
              tabIndex={active === n.id ? 0 : -1}
              onKeyDown={(e) => onKey(e, i)}
              onFocus={() => setFocusId(n.id)}
              onClick={() => {
                setFocusId(n.id)
                openNode(n)
              }}
              className="relative cursor-pointer rounded-xl"
              style={{ marginLeft: indent, ...indentVars }}
            >
              {row.level > 1 && <span aria-hidden className="ft-orgnode__elbow absolute top-0 -left-3 h-1/2 w-3 rounded-bl-md border-b-2 border-l-2 border-line" />}
              <div
                className={cx(
                  'ft-orgnode',
                  n.kind === 'planned' ? 'ft-orgnode--planned' : n.kind === 'person' ? 'ft-orgnode--person' : 'ft-orgnode--contractor',
                  active === n.id && 'ft-orgnode--active',
                  'flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3 py-2 transition-colors sm:flex-nowrap',
                  n.kind === 'planned'
                    ? 'border-2 border-dashed border-line-strong bg-transparent'
                    : n.kind === 'person'
                      ? 'border border-line bg-surface shadow-card hover:border-line-strong'
                      : 'border border-line bg-surface-2/60 hover:border-line-strong',
                  active === n.id && 'border-accent',
                )}
              >
                {hasKids ? (
                  <span
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation()
                      setFocusId(n.id)
                      toggle(n.id)
                    }}
                    className="-ml-1 inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
                    title={isOpen ? 'Collapse' : 'Expand'}
                  >
                    <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={18} />
                  </span>
                ) : (
                  <span aria-hidden className="-ml-1 w-9 shrink-0" />
                )}
                {n.kind === 'person' && p ? (
                  <>
                    <Avatar name={fullName(p)} size={34} />
                    <span className="min-w-0 flex-1 basis-[50%]">
                      <span className="flex flex-wrap items-baseline gap-x-1.5">
                        <EmpNo n={p.hireNumber} />
                        <span className="font-semibold text-ink">{fullName(p)}</span>
                      </span>
                      <span className="block text-[13px] text-ink-3 sm:truncate">{p.title}</span>
                      {badges && <span className="mt-1.5 flex flex-wrap gap-1.5 sm:hidden">{badges}</span>}
                    </span>
                    {badges && <span className="flex shrink-0 flex-wrap justify-end gap-1.5 max-sm:hidden">{badges}</span>}
                  </>
                ) : n.kind === 'planned' && n.slot ? (
                  <>
                    <span aria-hidden className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 border-dashed border-line-strong text-ink-3">
                      <Icon name="plus" size={16} />
                    </span>
                    <span className="min-w-0 flex-1 basis-[50%]">
                      <span className="block font-semibold text-ink-2">{n.slot.title}</span>
                      <span className="block text-[13px] text-ink-3">
                        Planned for {fmtQuarter(n.slot.quarter)}
                        {n.slot.isBackfill ? ', backfill' : ''}
                      </span>
                      <span className="mt-1.5 flex flex-wrap gap-1.5 sm:hidden">{badges}</span>
                    </span>
                    <span className="shrink-0 max-sm:hidden">{badges}</span>
                  </>
                ) : n.contractor ? (
                  <>
                    <Avatar name={n.contractor.name} size={34} muted />
                    <span className="min-w-0 flex-1 basis-[50%]">
                      <span className="block font-semibold text-ink">{n.contractor.entityName || n.contractor.name}</span>
                      <span className="line-clamp-2 block text-[13px] text-ink-3 sm:line-clamp-1">{n.contractor.scope}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1.5 sm:hidden">{badges}</span>
                    </span>
                    <span className="shrink-0 max-sm:hidden">{badges}</span>
                  </>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {visible.length === 0 && <p className="text-[14px] text-ink-3">No one to show yet.</p>}
      <p className="text-[13px] text-ink-3">
        Built from each person's manager. Change a manager with Change job or pay on their profile.{' '}
        {viewer.role === 'admin' && (
          <a href={links.comp('plan')} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent hover:underline">
            Planned roles come from the headcount plan.
          </a>
        )}
      </p>
    </div>
  )
}
