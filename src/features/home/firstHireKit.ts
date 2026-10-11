// First hire kit: what California expects from employer #1 (docs/SPEC.md, SOLO FOUNDER TO FIRST HIRE).
// Shown on Home while W-2 headcount is 1, including while the first hire is pre-start. Each item has a why and an official link; done
// toggles live in db.complianceStatus (rule ids for items that are compliance rules, 'kit-*' keys for the
// rest) so the Compliance section and Home never disagree. Pure apart from the draft mutation helper.
import type { Draft } from 'immer'
import { evaluateRule, RULE_BY_ID } from '@/domain/compliance'
import { setRuleStatus } from '@/domain/compliance/actions'
import { fullName, incomingOn } from '@/domain/people'
import type { DB, Person } from '@/domain/types'
import { fmtDay, type ISODate } from '@/lib/dates'
import { logActivity } from '@/store/draft'

export type KitItem = {
  key: string
  /** Compliance rule id when the item is a rule (done = the rule is done). */
  ruleId?: string
  title: string
  why: string
  /** Official source or where to do it. */
  link: { label: string; url: string }
  done: boolean
  doneOn?: ISODate
  /** Done because the data already shows it (a payroll link, a 409A on file). Cannot be unticked here. */
  onFile?: string
  /** When an open item is needed by, once a first hire is on the way ('Before Sam Rivera starts Mon Oct 26'). */
  neededBy?: string
}

/** Items that must be in place before the first non-owner employee starts work. */
const BEFORE_FIRST_START = new Set(['workers-comp', 'kit-payroll', 'kit-templates'])

/** The first hire on the way while the founder is still the only employee (start date after the date). */
export function firstHireStarting(db: DB, date: ISODate): Person | undefined {
  return incomingOn(db, date).find((p) => !p.isFounder)
}

type KitDef = {
  key: string
  ruleId?: string
  title: string
  why: string
  link?: { label: string; url: string }
  /** Detects completion from data. */
  onFile?: (db: DB) => string | undefined
}

const BPC_16600 = {
  label: 'Business and Professions Code 16600',
  url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=16600.',
}

const KIT: KitDef[] = [
  {
    key: 'edd-registration',
    ruleId: 'edd-registration',
    title: 'Register with EDD as an employer (DE 1)',
    why: 'File the DE 1 within 15 days of first paying more than $100 in wages in a quarter, even if the only W-2 employee is you.',
  },
  {
    key: 'workers-comp',
    ruleId: 'workers-comp',
    title: "Get workers' comp insurance",
    why: 'Required before your first non-owner employee starts work. Owner-officers can usually exclude themselves.',
  },
  {
    key: 'iipp',
    ruleId: 'iipp',
    title: 'Write your Injury and Illness Prevention Program (IIPP)',
    why: 'Every California employer needs a written IIPP that names the person who runs it.',
  },
  {
    key: 'paid-sick-leave',
    ruleId: 'paid-sick-leave',
    title: 'Set a paid sick leave policy',
    why: 'California requires at least 40 hours or 5 days a year from the first employee. The default here front-loads 40 hours each January 1 and at hire.',
  },
  {
    key: 'posters-federal',
    ruleId: 'posters-federal',
    title: 'Put up the federal workplace posters',
    why: 'Post the federal notices where staff can see them and share electronic copies with anyone remote.',
  },
  {
    key: 'posters-california',
    ruleId: 'posters-california',
    title: 'Put up the California workplace posters',
    why: 'The state notices change most Januaries, so check them each year.',
  },
  {
    key: 'posters-san-jose',
    ruleId: 'posters-san-jose',
    title: 'Put up the San Jose minimum wage bulletin',
    why: 'San Jose requires its own minimum wage notice at workplaces in the city.',
  },
  {
    key: 'kit-payroll',
    title: 'Choose a payroll provider or PEO',
    why: 'It runs payroll, withholds and files taxes, and files the DE 34 new hire report. Save its link in Settings so tasks can point to it.',
    onFile: (db) => (db.company.payrollProvider.url?.trim() || db.company.linkOuts.payroll?.trim() ? 'Link saved in Settings' : undefined),
  },
  {
    key: 'kit-templates',
    title: 'Have counsel review your offer letter and PIIA templates',
    why: 'California voids noncompetes, offer letters should use California law and venue (Labor Code 925), and the PIIA needs the Labor Code 2870 notice.',
    link: BPC_16600,
  },
  {
    key: 'kit-409a',
    title: 'Set up the option pool and get your first 409A',
    why: 'The board approves the pool, and a 409A valuation sets the strike price before the first grant. The California 25102(o) notice is due within 30 days of the first grant.',
    onFile: (db) => (db.equity.valuations.length ? '409A on file' : undefined),
  },
]

/** The kit for a workspace on a date. Items whose rule does not apply here (no San Jose site) are left out. */
export function firstHireKit(db: DB, date: ISODate): KitItem[] {
  const out: KitItem[] = []
  const starting = firstHireStarting(db, date)
  for (const def of KIT) {
    const rule = def.ruleId ? RULE_BY_ID[def.ruleId] : undefined
    let done = false
    let doneOn: ISODate | undefined
    let onFile: string | undefined
    let link = def.link
    if (rule) {
      const res = evaluateRule(db, rule, date)
      if (res.state === 'not_applicable' && res.status?.status !== 'not_applicable') continue
      done = res.state === 'done' || res.status?.status === 'done' || res.status?.status === 'not_applicable'
      doneOn = res.status?.doneOn
      link = link ?? { label: rule.citation.label, url: rule.citation.url }
    } else {
      const status = db.complianceStatus[def.key]
      onFile = def.onFile?.(db)
      done = !!onFile || status?.status === 'done'
      doneOn = status?.doneOn
    }
    out.push({
      key: def.key,
      ...(def.ruleId ? { ruleId: def.ruleId } : {}),
      title: def.title,
      why: def.why,
      link: link ?? { label: 'Official source', url: 'https://www.dir.ca.gov/' },
      done,
      ...(doneOn ? { doneOn } : {}),
      ...(onFile ? { onFile } : {}),
      ...(starting && !done && BEFORE_FIRST_START.has(def.key) ? { neededBy: `Before ${fullName(starting)} starts ${fmtDay(starting.startDate)}` } : {}),
    })
  }
  return out
}

export function kitProgress(items: KitItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length }
}

/** Ticks or unticks a kit item. Rule items use the compliance status so the Compliance cards agree. */
export function setKitItemDone(draft: Draft<DB>, item: Pick<KitItem, 'key' | 'ruleId' | 'title'>, done: boolean, date: ISODate): void {
  if (item.ruleId) {
    setRuleStatus(draft, item.ruleId, done ? 'done' : null, date)
    return
  }
  if (done) draft.complianceStatus[item.key] = { ...(draft.complianceStatus[item.key] ?? {}), status: 'done', doneOn: date }
  else delete draft.complianceStatus[item.key]
  logActivity(draft, {
    entityType: 'compliance',
    entityId: item.key,
    kind: 'kit_item',
    text: done ? `Marked done: ${item.title}` : `Reopened: ${item.title}`,
  })
}
