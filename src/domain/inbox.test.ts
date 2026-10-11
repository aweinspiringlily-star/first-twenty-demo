import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { addContractor, addOffer, addPerson, makeDB } from '@/domain/compliance/testkit'
import type { Checklist, ChecklistTask, DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { welcomeEmail } from '@/domain/people'
import {
  ab5Result,
  applyInboxOp,
  candidatesTitle,
  dayText,
  dismissItem,
  filterItems,
  firstHireKitShown,
  groupFor,
  type InboxItem,
  inboxItems,
  isHidden,
  isSoloWorkspace,
  KIT_RULE_IDS,
  minutesText,
  rangeText,
  snoozeItem,
  snoozeOptions,
  tonightHeadline,
  tonightSummary,
  unlockEvents,
  visibleForFilter,
} from './inbox'

const FRI = '2026-10-09'
const NOW = '2026-10-09T22:00:00.000Z'

beforeAll(() => setClockOverride(FRI))
afterAll(() => setClockOverride(null))

function task(id: string, extra: Partial<ChecklistTask>): ChecklistTask {
  return {
    id,
    title: id,
    ownerRole: 'admin',
    dueOn: FRI,
    status: 'open',
    category: 'legal',
    statutory: false,
    ...extra,
  }
}

/** Founder, a manager (Tomas) with a report (Ana, recently hired) and an incoming hire (Lee). */
function fixture(): DB {
  const db = makeDB('2025-01-06')
  addPerson(db, { id: 'p-tomas', firstName: 'Tomas', lastName: 'Herrera', startDate: '2025-05-12' })
  addPerson(db, { id: 'p-ana', firstName: 'Ana', lastName: 'Lima', startDate: '2026-09-08', managerId: 'p-tomas' })
  addPerson(db, { id: 'p-lee', firstName: 'Lee', lastName: 'Park', startDate: '2026-10-19', managerId: 'p-tomas' })
  const ana: Checklist = {
    id: 'ck-ana',
    personId: 'p-ana',
    kind: 'onboarding',
    templateId: 'tpl-onboarding',
    anchorDate: '2026-09-08',
    createdOn: '2026-09-01',
    tasks: [
      task('t-de34', { templateTaskId: 'on-de34', title: 'DE 34 new hire report filed', dueOn: '2026-09-28', statutory: true }),
      task('t-sec', { templateTaskId: 'on-security-training', title: 'Security awareness training completed', ownerRole: 'employee', assigneeId: 'p-ana', dueOn: '2026-10-13', category: 'training' }),
      task('t-check', { templateTaskId: 'on-checkin-30', title: '30-day check-in', ownerRole: 'manager', assigneeId: 'p-tomas', dueOn: '2026-10-12', category: 'culture' }),
    ],
  }
  const lee: Checklist = {
    id: 'ck-lee',
    personId: 'p-lee',
    kind: 'onboarding',
    templateId: 'tpl-onboarding',
    anchorDate: '2026-10-19',
    createdOn: '2026-10-01',
    tasks: [
      task('t-laptop', { templateTaskId: 'on-laptop', title: 'Laptop ordered with MDM and disk encryption', ownerRole: 'it', dueOn: '2026-10-12', category: 'it' }),
      task('t-n1', { title: 'Notice one given', dueOn: '2026-10-19', statutory: true }),
      task('t-n2', { title: 'Notice two given', dueOn: '2026-10-19' }),
      task('t-n3', { title: 'Notice three given', dueOn: '2026-10-19' }),
      task('t-far', { title: 'Far away task', dueOn: '2026-12-01' }),
    ],
  }
  db.checklists.push(ana, lee)
  db.timeOffRequests.push({
    id: 'tr-ana',
    personId: 'p-ana',
    policyId: db.timeOffPolicies.find((p) => !p.autoApprove)?.id ?? db.timeOffPolicies[0].id,
    startDate: '2026-11-23',
    endDate: '2026-11-25',
    hours: 24,
    status: 'pending',
    requestedOn: '2026-10-05',
  })
  db.grants.push({
    id: 'g-ana',
    personId: 'p-ana',
    holderType: 'employee',
    type: 'ISO',
    shares: 12000,
    strikePrice: 1.15,
    vestingStart: '2026-09-08',
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'promised',
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
  })
  addContractor(db, { id: 'k-marisol', name: 'Marisol Vega', startOn: '2026-04-01', ab5: { exemption: 'none', a: false, b: false, c: true } })
  db.policies = []
  addOffer(db, { id: 'o-dan', startDate: '2026-11-09', status: 'awaiting_approval', draftedById: 'p-tomas', draftedByRole: 'manager' }, { firstName: 'Dan', lastName: 'Reyes' })
  return db
}

const admin = (db: DB): Viewer => ({ role: 'admin', person: db.people.find((p) => p.id === 'p-founder'), personId: 'p-founder' })
const manager = (db: DB): Viewer => ({ role: 'manager', person: db.people.find((p) => p.id === 'p-tomas'), personId: 'p-tomas' })
const employee = (db: DB, id = 'p-ana'): Viewer => ({ role: 'employee', person: db.people.find((p) => p.id === id), personId: id })

const byKey = (items: InboxItem[], key: string) => items.find((i) => i.key === key)

describe('groups, snoozes and the Tonight header', () => {
  it('groups by due date', () => {
    expect(groupFor('2026-10-08', FRI)).toBe('overdue')
    expect(groupFor(FRI, FRI)).toBe('this_week')
    expect(groupFor('2026-10-16', FRI)).toBe('this_week')
    expect(groupFor('2026-10-17', FRI)).toBe('coming_up')
    expect(groupFor(undefined, FRI)).toBe('this_week')
  })

  it('offers 1 day, 3 days and 1 week, capped at the due date for statutory items', () => {
    expect(snoozeOptions({ statutory: false, dueOn: '2026-10-10', group: 'this_week' }, FRI).map((o) => o.until)).toEqual([
      '2026-10-10',
      '2026-10-12',
      '2026-10-16',
    ])
    const capped = snoozeOptions({ statutory: true, dueOn: '2026-10-11', group: 'this_week' }, FRI)
    expect(capped.map((o) => o.until)).toEqual(['2026-10-10', '2026-10-11'])
    expect(capped[1]).toMatchObject({ capped: true, label: 'Until the due date' })
    expect(snoozeOptions({ statutory: true, dueOn: FRI, group: 'this_week' }, FRI)).toEqual([])
    expect(snoozeOptions({ statutory: true, dueOn: undefined, group: 'overdue' }, FRI)).toEqual([])
  })

  it('hides snoozed and dismissed items, but legal deadlines come back on their due date', () => {
    expect(isHidden({ snoozedUntil: '2026-10-12' }, { statutory: false, dueOn: '2026-10-20', group: 'coming_up' }, FRI)).toBe(true)
    expect(isHidden({ snoozedUntil: '2026-10-12' }, { statutory: false, dueOn: '2026-10-20', group: 'coming_up' }, '2026-10-12')).toBe(false)
    expect(isHidden({ snoozedUntil: '2026-10-20' }, { statutory: true, dueOn: FRI, group: 'this_week' }, FRI)).toBe(false)
    expect(isHidden({ dismissedOn: FRI }, { statutory: false, group: 'this_week' }, FRI)).toBe(true)
    expect(isHidden({ dismissedOn: FRI }, { statutory: true, group: 'this_week' }, FRI)).toBe(false)
  })

  it('stores snoozes and dismissals by key', () => {
    const db = blankDB({ companyName: 'X', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' })
    const next = produce(db, (d) => {
      snoozeItem(d, 'k1', '2026-10-12')
      dismissItem(d, 'k2', FRI)
    })
    expect(next.inboxState).toEqual({ k1: { snoozedUntil: '2026-10-12' }, k2: { dismissedOn: FRI } })
  })

  it('sums tonight from overdue and this week items, rounded to 5 minutes', () => {
    const mk = (group: InboxItem['group'], minutes: number) => ({ group, minutes }) as InboxItem
    expect(tonightSummary([mk('overdue', 3), mk('this_week', 5), mk('coming_up', 30)])).toEqual({ count: 2, minutes: 8 })
    expect(tonightSummary([mk('overdue', 12), mk('this_week', 11)])).toEqual({ count: 2, minutes: 25 })
    expect(tonightHeadline(FRI, { count: 13, minutes: 25 })).toBe('Friday, Oct 9: 13 things, about 25 minutes')
    expect(tonightHeadline(FRI, { count: 1, minutes: 1 })).toBe('Friday, Oct 9: 1 thing, about 1 minute')
    expect(tonightHeadline(FRI, { count: 0, minutes: 0 })).toBe('Friday, Oct 9: nothing needs you tonight')
    expect(minutesText(90)).toBe('1.5 hours')
  })
})

describe('helpers', () => {
  it('reads the AB5 result', () => {
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'none', a: false, b: true, c: true } })).toBe('likely_employee')
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'none', a: true, b: null, c: true } })).toBe('review')
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'b2b', a: false, b: false, c: false } })).toBe('likely_ok')
    expect(ab5Result({ kind: 'advisor', ab5: { exemption: 'none', a: false, b: false, c: false } })).toBe('likely_ok')
  })

  it('writes date ranges and candidate group titles', () => {
    expect(rangeText('2026-11-23', '2026-11-25')).toBe('Nov 23-25')
    expect(rangeText('2026-10-30', '2026-10-30')).toBe('Oct 30')
    expect(rangeText('2026-11-30', '2026-12-02')).toBe('Nov 30 to Dec 2')
    const past = { reasons: ['past_sla' as const], stageName: 'Intro call' }
    expect(candidatesTitle('Senior full-stack', [past, past, past])).toBe('Senior full-stack: 3 candidates past SLA in Intro call')
    expect(candidatesTitle('AE', [past, { reasons: ['no_next_step' as const], stageName: 'New' }])).toBe('AE: 2 candidates need a next step')
  })
})

describe('inboxItems', () => {
  it('builds the Admin inbox with one action per item', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    const de34 = byKey(items, 'task:ck-ana:t-de34')
    expect(de34).toMatchObject({ group: 'overdue', statutory: true, waitingOn: 'you', title: 'DE 34 for Ana Lima was due Mon Sep 28: confirm your PEO filed it' })
    expect(de34?.primary).toMatchObject({ kind: 'mutate', label: 'Mark filed' })
    // Someone else's training due this week waits on them; their manager task does not show.
    expect(byKey(items, 'task:ck-ana:t-sec')).toMatchObject({ waitingOn: 'them', waitingOnName: 'Ana' })
    expect(byKey(items, 'task:ck-ana:t-check')).toBeUndefined()
    // Pre-start tasks read as Day 1 readiness.
    expect(byKey(items, 'task:ck-lee:t-laptop')?.title).toBe('Lee starts Mon Oct 19: laptop not ordered yet')
    // Three first-day tasks collapse into one row; far-off tasks wait.
    expect(byKey(items, 'tasks:ck-lee:2026-10-19')).toMatchObject({ kind: 'task_group', statutory: true, group: 'coming_up' })
    expect(byKey(items, 'task:ck-lee:t-far')).toBeUndefined()
    expect(byKey(items, 'grants:g-ana')).toMatchObject({ kind: 'grants', primary: { kind: 'copy', label: 'Copy consent table' } })
    expect(byKey(items, 'ab5:k-marisol:likely_employee')?.title).toBe('Marisol Vega (contractor) is likely an employee under AB5')
    expect(byKey(items, 'offer-approval:o-dan:v1')?.primary).toMatchObject({ kind: 'mutate', label: 'Approve' })
    // Ana's manager approves her time off; Admin sees it only when it starts within a week.
    expect(byKey(items, 'timeoff:tr-ana')).toBeUndefined()
    // Overdue legal deadlines sort first.
    expect(items[0].statutory && items[0].group === 'overdue').toBe(true)
  })

  it('scopes the Hiring manager inbox to their own work and reports', () => {
    const db = fixture()
    const items = inboxItems(db, manager(db), FRI, { now: NOW })
    const keys = items.map((i) => i.key)
    expect(keys).toContain('task:ck-ana:t-check')
    expect(keys).toContain('timeoff:tr-ana')
    expect(keys).toContain('offer-waiting:o-dan:v1')
    expect(keys.some((k) => k.startsWith('grants') || k.startsWith('ab5') || k.startsWith('rule') || k.startsWith('task:ck-ana:t-de34'))).toBe(false)
    expect(byKey(items, 'timeoff:tr-ana')?.primary).toMatchObject({ label: 'Approve' })
  })

  it('tells the drafter when Admin asks for changes to their offer, or approves it', () => {
    const db = fixture()
    const offer = db.offers.find((o) => o.id === 'o-dan')
    if (!offer) throw new Error('no offer')
    const asked = '2026-10-09T18:00:00.000Z'
    offer.status = 'draft'
    offer.approvals.push({ approverId: 'p-founder', decision: 'changes_requested', at: asked, note: '  Lower the equity.\n' })
    let items = inboxItems(db, manager(db), FRI, { now: NOW })
    expect(items.some((i) => i.kind === 'offer_waiting')).toBe(false)
    expect(byKey(items, `offer-changes:o-dan:${asked}`)).toMatchObject({
      kind: 'offer_changes',
      waitingOn: 'you',
      title: 'Fay Founder asked for changes to the offer for Dan Reyes: Lower the equity',
      primary: { kind: 'navigate', label: 'Open offer', href: '#candidate.c-o-dan' },
    })
    // The approver who asked does not get it back, and a manager with no part in the offer never sees it.
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).some((i) => i.kind === 'offer_changes')).toBe(false)
    const other: Viewer = { role: 'manager', person: db.people.find((p) => p.id === 'p-ana'), personId: 'p-ana' }
    expect(inboxItems(db, other, FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-dan')).toBe(false)
    // Resubmitted: back to waiting on Admin.
    offer.status = 'awaiting_approval'
    expect(inboxItems(db, manager(db), FRI, { now: NOW }).map((i) => i.kind)).toContain('offer_waiting')
    // Approved: the drafter is asked to send it.
    offer.status = 'approved'
    offer.approvals.push({ approverId: 'p-founder', decision: 'approved', at: '2026-10-09T19:00:00.000Z' })
    items = inboxItems(db, manager(db), FRI, { now: NOW })
    expect(byKey(items, 'offer-approved:o-dan:v1')).toMatchObject({
      kind: 'offer_send',
      waitingOn: 'you',
      title: 'Send the approved offer to Dan Reyes (Engineer)',
      primary: { kind: 'navigate', label: 'Open offer' },
    })
    expect(byKey(items, 'offer-approved:o-dan:v1')?.detail).toMatch(/^Fay Founder approved it Fri Oct 9\./)
    expect(items.some((i) => i.kind === 'offer_changes' || i.kind === 'offer_waiting')).toBe(false)
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).some((i) => i.kind === 'offer_send')).toBe(false)
    expect(inboxItems(db, employee(db), FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-dan')).toBe(false)
  })

  it('shows an employee only their own tasks', () => {
    const db = fixture()
    const items = inboxItems(db, employee(db), FRI, { now: NOW })
    expect(items.map((i) => i.key)).toEqual(['task:ck-ana:t-sec'])
    expect(items[0].title).toBe('Your security awareness training is due Tue Oct 13')
  })

  it('drops the AB5 item once the contractor is converted to an employee', () => {
    const db = fixture()
    const k = db.contractors.find((c) => c.id === 'k-marisol')
    if (!k) throw new Error('no contractor')
    // A link to a record that no longer exists (undone or deleted) keeps the alert.
    k.convertedToPersonId = 'p-gone'
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)).toContain('ab5:k-marisol:likely_employee')
    k.convertedToPersonId = db.people[0].id
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)).not.toContain('ab5:k-marisol:likely_employee')
  })

  it('respects snoozes and dismissals', () => {
    const db = fixture()
    db.inboxState['grants:g-ana'] = { snoozedUntil: '2026-10-12' }
    db.inboxState['ab5:k-marisol:likely_employee'] = { dismissedOn: FRI }
    db.inboxState['task:ck-ana:t-de34'] = { snoozedUntil: '2026-10-20' }
    const keys = inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)
    expect(keys).not.toContain('grants:g-ana')
    expect(keys).not.toContain('ab5:k-marisol:likely_employee')
    // An overdue legal deadline cannot be snoozed away.
    expect(keys).toContain('task:ck-ana:t-de34')
    expect(inboxItems(db, admin(db), '2026-10-12', { now: '2026-10-12T22:00:00.000Z' }).map((i) => i.key)).toContain('grants:g-ana')
  })

  it('filters by waiting on you or them', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(filterItems(items, 'them').every((i) => i.waitingOn === 'them')).toBe(true)
    expect(filterItems(items, 'you').length + filterItems(items, 'them').length).toBe(items.length)
  })

  it('leaves the First hire kit rules out of a solo founder inbox', () => {
    const db = blankDB({ companyName: 'Solo', founderFirstName: 'Sam', founderLastName: 'Solo', foundedOn: '2026-09-01' })
    expect(isSoloWorkspace(db, FRI)).toBe(true)
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.refs.ruleId && KIT_RULE_IDS.includes(i.refs.ruleId))).toBe(false)
    // Rules that apply from the first employee are set-up steps, grouped in one row, never overdue crossings.
    expect(items.filter((i) => i.kind === 'rules_group')).toHaveLength(1)
    expect(items.some((i) => i.kind === 'rule' && i.group === 'overdue')).toBe(false)
    expect(isSoloWorkspace(fixture(), FRI)).toBe(false)
  })
})

describe('applyInboxOp', () => {
  const ctx = { date: FRI, actorId: 'p-founder' }

  it('marks a task done and records security training in the tracker', () => {
    const db = fixture()
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-sec', status: 'done' }, ctx)).toEqual({ ok: true })
    })
    const t = next.checklists.find((c) => c.id === 'ck-ana')?.tasks.find((x) => x.id === 't-sec')
    expect(t).toMatchObject({ status: 'done', doneOn: FRI })
    expect(next.trainings.some((x) => x.personId === 'p-ana' && x.kind === 'security_awareness' && x.completedOn === FRI)).toBe(true)
    expect(inboxItems(next, employee(next), FRI, { now: NOW })).toEqual([])
  })

  it('needs a note to mark a legal task not applicable', () => {
    const db = fixture()
    produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-de34', status: 'not_applicable' }, ctx).ok).toBe(false)
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-de34', status: 'not_applicable', note: 'PEO files it' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'rule_not_applicable', ruleId: 'iipp', note: ' ' }, ctx).ok).toBe(false)
    })
  })

  it('approves time off and offers, and records acknowledgements', () => {
    const db = fixture()
    db.policies = [{ id: 'pl-handbook', title: 'Employee handbook', version: '2.0', effectiveOn: '2026-09-15', summary: 'Rules', requiresAck: true }]
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'approve_timeoff', requestId: 'tr-ana' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'approve_timeoff', requestId: 'tr-ana' }, ctx).ok).toBe(false)
      expect(applyInboxOp(d, { type: 'approve_offer', offerId: 'o-dan' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'acknowledge', policyId: 'pl-handbook', personId: 'p-ana' }, ctx).ok).toBe(true)
    })
    expect(next.timeOffRequests[0]).toMatchObject({ status: 'approved', approverId: 'p-founder' })
    expect(next.offers[0].status).toBe('approved')
    expect(next.acks.some((a) => a.personId === 'p-ana' && a.policyId === 'pl-handbook' && a.version === '2.0')).toBe(true)
  })

  it('records the leave designation notice and closes its task', () => {
    const db = fixture()
    db.leaveCases.push({ id: 'lc-1', personId: 'p-tomas', kind: 'bonding', requestedOn: '2026-10-06', startDate: '2026-11-16', designationNoticeDueOn: '2026-10-13' })
    db.checklists.push({
      id: 'ck-leave',
      personId: 'p-tomas',
      kind: 'leave',
      templateId: 'tpl-leave',
      anchorDate: '2026-11-16',
      createdOn: '2026-10-06',
      tasks: [task('t-des', { templateTaskId: 'lv-designation', title: 'Response and designation notice sent', dueOn: '2026-10-13', statutory: true })],
    })
    const before = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(byKey(before, 'leave-notice:lc-1')).toMatchObject({ statutory: false, title: "Tomas's CFRA bonding designation notice is due Tue Oct 13" })
    // The checklist task does not show twice.
    expect(byKey(before, 'task:ck-leave:t-des')).toBeUndefined()
    const next = produce(db, (d) => {
      applyInboxOp(d, { type: 'leave_notice_sent', leaveCaseId: 'lc-1' }, ctx)
    })
    expect(next.leaveCases[0].designationNoticeSentOn).toBe(FRI)
    expect(next.checklists.find((c) => c.id === 'ck-leave')?.tasks[0].status).toBe('done')
    expect(byKey(inboxItems(next, admin(next), FRI, { now: NOW }), 'leave-notice:lc-1')).toBeUndefined()
  })
})

describe('first hire kit visibility', () => {
  const solo = () => blankDB({ companyName: 'Quillfin', founderFirstName: 'Dana', founderLastName: 'Okoro', foundedOn: '2026-09-01' })

  it('keeps the kit (and leaves its rules out of the inbox) while the first hire is pre-start', () => {
    const db = solo()
    expect(firstHireKitShown(db, FRI)).toBe(true)
    addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-10-26' })
    // Someone is incoming, so this is no longer the solo layout, but headcount is still 1.
    expect(isSoloWorkspace(db, FRI)).toBe(false)
    expect(firstHireKitShown(db, FRI)).toBe(true)
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.refs.ruleId && KIT_RULE_IDS.includes(i.refs.ruleId))).toBe(false)
    expect(items.some((i) => i.kind === 'rules_group' && KIT_RULE_IDS.some((id) => i.key.includes(id)))).toBe(false)
    // The founder is not asked to acknowledge their own starter policies while headcount is 1.
    expect(items.some((i) => i.kind === 'ack')).toBe(false)
    // Once Sam starts, headcount is 2: the kit goes and its rules come back to the inbox.
    expect(firstHireKitShown(db, '2026-10-26')).toBe(false)
    const after = inboxItems(db, admin(db), '2026-10-26', { now: '2026-10-26T22:00:00.000Z' })
    const ruleIds = after.flatMap((i) => (i.kind === 'rules_group' ? i.key.replace(/^rules-baseline:/, '').split(',') : i.refs.ruleId ? [i.refs.ruleId] : []))
    expect(ruleIds).toContain('iipp')
  })
})

describe('growth journey announcements', () => {
  it('announces the first hire once, for two weeks, and the row can be dismissed', () => {
    const db = blankDB({ companyName: 'Quillfin', founderFirstName: 'Dana', founderLastName: 'Okoro', foundedOn: '2026-09-01' })
    addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-10-05' })
    expect(unlockEvents(db, FRI)).toContainEqual({ area: 'first_hire', on: '2026-10-05' })
    const item = byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'unlock:first_hire')
    expect(item).toMatchObject({ kind: 'unlock', statutory: false, group: 'this_week' })
    expect(item?.detail).toMatch(/^Why now: /)
    // Past the window it no longer shows.
    expect(byKey(inboxItems(db, admin(db), '2026-10-20', { now: '2026-10-20T22:00:00.000Z' }), 'unlock:first_hire')).toBeUndefined()
    // Dismissed, it stays gone.
    const next = produce(db, (d) => dismissItem(d, 'unlock:first_hire', FRI))
    expect(byKey(inboxItems(next, admin(next), FRI, { now: NOW }), 'unlock:first_hire')).toBeUndefined()
    // Only Admin sees announcements.
    expect(inboxItems(db, employee(db, 'p-sam'), FRI, { now: NOW }).some((i) => i.kind === 'unlock')).toBe(false)
  })

  it('announces the first grant and the first contractor from their dates', () => {
    const db = makeDB('2025-01-06')
    addPerson(db, { id: 'p-a', startDate: '2025-03-03' })
    addContractor(db, { id: 'k-1', startOn: '2026-10-01' })
    db.grants.push({
      id: 'g-a',
      personId: 'p-a',
      holderType: 'employee',
      type: 'ISO',
      shares: 1000,
      strikePrice: 0.5,
      vestingStart: '2025-03-03',
      proposedOn: '2026-10-07',
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'promised',
      exercisedShares: 0,
      postTerminationExerciseDays: 90,
    })
    const keys = inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)
    expect(keys).toContain('unlock:equity')
    expect(keys).toContain('unlock:contractors')
    expect(keys).not.toContain('unlock:first_hire')
  })

  it('nudges for levels and bands at 5 employees until a band is reviewed', () => {
    const db = makeDB('2025-01-06')
    for (const n of [1, 2, 3]) addPerson(db, { id: `p-${n}`, startDate: '2025-03-03' })
    expect(byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'nudge:bands')).toBeUndefined()
    addPerson(db, { id: 'p-4', startDate: '2025-03-03' })
    const nudge = byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'nudge:bands')
    expect(nudge).toMatchObject({ title: 'Set levels and bands before your next offer', statutory: false, primary: { kind: 'navigate' } })
    expect(nudge?.citation?.label).toBe('Labor Code 432.3')
    const reviewed = produce(db, (d) => {
      d.activity.push({ id: 'act-b', at: '2026-10-01T18:00:00.000Z', entityType: 'settings', entityId: 'b-1', kind: 'band_changed', text: 'Updated a band' })
    })
    expect(byKey(inboxItems(reviewed, admin(reviewed), FRI, { now: NOW }), 'nudge:bands')).toBeUndefined()
  })
})

describe('inbox counts and actions', () => {
  it('counts the same rows in the filter chips and the Tonight header while Coming up is folded', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.group === 'coming_up')).toBe(true)
    expect(visibleForFilter(items, 'all').length).toBe(tonightSummary(items).count)
    expect(visibleForFilter(items, 'you').length).toBe(items.filter((i) => i.waitingOn === 'you' && i.group !== 'coming_up').length)
    // Opened, Coming up counts too.
    expect(visibleForFilter(items, 'all', true).length).toBe(items.length)
    // With nothing due now, Coming up is the list, so it is counted.
    const later = items.filter((i) => i.group === 'coming_up')
    expect(visibleForFilter(later, 'all').length).toBe(later.length)
  })
})

describe('welcome email task', () => {
  const withWelcome = () => {
    const db = fixture()
    db.checklists
      .find((c) => c.id === 'ck-lee')
      ?.tasks.push(task('t-welcome', { templateTaskId: 'on-welcome', title: 'Welcome email sent', ownerRole: 'manager', assigneeId: 'p-tomas', dueOn: '2026-10-14', category: 'culture' }))
    return db
  }

  it('makes Copy welcome email the primary action, with Mark sent under More', () => {
    const db = withWelcome()
    const item = byKey(inboxItems(db, manager(db), FRI, { now: NOW }), 'task:ck-lee:t-welcome')
    const mail = welcomeEmail(db, 'p-lee', { senderId: 'p-tomas' })
    expect(mail).not.toBeNull()
    expect(item?.primary).toMatchObject({ kind: 'copy', label: 'Copy welcome email', text: `Subject: ${mail?.subject}\n\n${mail?.body}` })
    expect(item?.primary.kind === 'copy' && item.primary.text).toContain('Hi Lee')
    expect(item?.more).toEqual([expect.objectContaining({ kind: 'mutate', label: 'Mark sent', op: expect.objectContaining({ type: 'task_status', taskId: 't-welcome' }) })])
  })

  it('falls back to Mark sent when there is no welcome template', () => {
    const db = withWelcome()
    db.emailTemplates = db.emailTemplates.filter((t) => t.kind !== 'welcome')
    const item = byKey(inboxItems(db, manager(db), FRI, { now: NOW }), 'task:ck-lee:t-welcome')
    expect(item?.primary).toMatchObject({ kind: 'mutate', label: 'Mark sent' })
    expect(item?.more).toBeUndefined()
  })
})

describe('timestamps read as the local calendar day', () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it('writes an evening timestamp as that local day', () => {
    // 7 PM Thursday Oct 1 in California is already Oct 2 in UTC.
    expect(dayText('2026-10-02T02:00:00.000Z')).toBe('Thu Oct 1')
    expect(dayText('2026-10-19')).toBe('Mon Oct 19')
  })

  it('ages the last backup by its local day', () => {
    const db = fixture()
    db.meta.sample = false
    // Backed up 8 PM Thursday Oct 1 local: 8 days before Friday Oct 9 (the UTC date would say 7, not stale yet).
    db.meta.lastExportedOn = '2026-10-02T03:00:00.000Z'
    const backup = inboxItems(db, admin(db), FRI, { now: NOW }).find((i) => i.kind === 'backup')
    expect(backup?.key).toBe('backup:2026-10-01')
  })
})
