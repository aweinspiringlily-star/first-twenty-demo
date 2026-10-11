import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import {
  backupFileName,
  buildFreshDB,
  dataWeDontKeep,
  describeCondition,
  diffDB,
  exemptFloorFrom,
  fmtBytes,
  healthPlanChoice,
  healthPlanProblem,
  hostLabel,
  isCustomTask,
  localMinWage,
  longestWorkday,
  maskDigits,
  moveItem,
  packFileName,
  parseBackup,
  setHealthPlan,
  reviewedDate,
  sickLeaveMinimums,
  sickPolicyProblem,
  storageUsage,
  urlProblem,
  usageOf,
} from './logic'

const TODAY = '2026-10-09'

beforeAll(() => setClockOverride(TODAY))
afterAll(() => setClockOverride(null))

function base(): DB {
  return blankDB({ companyName: 'Acme', founderFirstName: 'Ada', founderLastName: 'Lovelace', foundedOn: '2026-01-05' })
}

describe('parseBackup', () => {
  it('asks for input when empty', () => {
    expect(parseBackup('   ')).toEqual({ ok: false, reason: 'Paste a backup or pick a file first.' })
  })
  it('rejects text that is not JSON', () => {
    const r = parseBackup('{ "schemaVersion": 1, ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not valid JSON/)
  })
  it('rejects arrays and objects without a schema version', () => {
    expect(parseBackup('[]').ok).toBe(false)
    const r = parseBackup('{"company":{"name":"x"}}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no schemaVersion/)
  })
  it('names a newer schema version', () => {
    const r = parseBackup(JSON.stringify({ ...base(), schemaVersion: 2 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/schema version 2, which is newer/)
  })
  it('needs a company record and the core lists', () => {
    const noCompany = { ...base() } as Partial<DB>
    delete noCompany.company
    expect(parseBackup(JSON.stringify(noCompany)).ok).toBe(false)
    const noPeople = { ...base() } as Record<string, unknown>
    delete noPeople.people
    const r = parseBackup(JSON.stringify(noPeople))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/people list/)
  })
  it('rejects a collection that is not a list', () => {
    const r = parseBackup(JSON.stringify({ ...base(), holidays: { a: 1 } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/holidays/i)
  })
  it('accepts a real backup and round-trips without loss', () => {
    const db = base()
    const r = parseBackup(JSON.stringify(db, null, 2))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.db).toEqual(db)
      expect(diffDB(db, r.db).identical).toBe(true)
    }
  })
})

describe('diffDB', () => {
  it('counts added, removed and changed records per collection', () => {
    const a = base()
    const b = structuredClone(a)
    b.people[0].title = 'CEO'
    b.holidays = b.holidays.slice(1)
    b.departments.push({ id: 'd-new', name: 'Research' })
    b.company.name = 'Acme Two'
    const d = diffDB(a, b)
    const row = (k: string) => d.rows.find((r) => r.key === k)!
    expect(row('people')).toMatchObject({ current: 1, incoming: 1, changed: 1, added: 0, removed: 0 })
    expect(row('holidays').removed).toBe(1)
    expect(row('departments').added).toBe(1)
    expect(d.sections.map((s) => s.key)).toEqual(['company'])
    expect(d.companyFrom).toBe('Acme')
    expect(d.companyTo).toBe('Acme Two')
    expect(d.totalChanges).toBe(4)
    expect(d.identical).toBe(false)
  })
})

describe('storage', () => {
  it('formats sizes', () => {
    expect(fmtBytes(512)).toBe('512 bytes')
    expect(fmtBytes(412_300)).toBe('412 KB')
    expect(fmtBytes(1_250_000)).toBe('1.3 MB')
    expect(fmtBytes(2_000_000)).toBe('2 MB')
  })
  it('warns from 70% and alarms from 90%', () => {
    expect(storageUsage(1_000_000).tone).toBe('good')
    expect(storageUsage(3_500_000).tone).toBe('warn')
    expect(storageUsage(4_600_000).tone).toBe('bad')
    expect(storageUsage(400_000).text).toBe('400 KB of about 5 MB (8%)')
    expect(storageUsage(20_000).text).toContain('under 1%')
  })
})

describe('start fresh', () => {
  it('builds a one-person company with the founder as employee #1', () => {
    const db = buildFreshDB({
      companyName: '  Northwind ',
      hqCity: 'San Jose',
      hqState: 'ca',
      hqZip: '95113',
      firstName: 'Sam',
      lastName: 'Rivera',
      title: 'Founder and CEO',
      startDate: '2026-10-05',
    })
    expect(db.people).toHaveLength(1)
    expect(db.people[0]).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', hireNumber: 1, isFounder: true, startDate: '2026-10-05' })
    expect(db.company).toMatchObject({ name: 'Northwind', legalName: 'Northwind, Inc.', foundedOn: '2026-10-05' })
    expect(db.company.hq).toMatchObject({ city: 'San Jose', state: 'CA', zip: '95113' })
    expect(db.meta.sample).toBe(false)
    expect(db.jobs).toHaveLength(0)
    expect(db.locations.find((l) => l.kind === 'hq')?.minWageHourly).toBe(18.45)
  })
  it('uses the local minimum wage for other Bay Area cities', () => {
    const db = buildFreshDB({
      companyName: 'Bayside',
      hqStreet: '1 Market St',
      hqCity: 'San Francisco',
      hqState: 'CA',
      hqZip: '94105',
      firstName: 'Jo',
      lastName: 'Park',
      title: '',
      startDate: TODAY,
    })
    const hq = db.locations.find((l) => l.kind === 'hq')!
    expect(hq.minWageHourly).toBe(19.61)
    expect(hq.name).toBe('San Francisco HQ')
    expect(db.company.hq.street).toBe('1 Market St')
    expect(db.people[0].title).toBe('Founder and CEO')
  })
  it('finds local minimum wages by date', () => {
    expect(localMinWage('san jose')).toBe(18.45)
    expect(localMinWage('Palo Alto', '2027-01-02')).toBe(19.25)
    expect(localMinWage('Fresno')).toBeUndefined()
    expect(localMinWage(undefined)).toBeUndefined()
  })
})

describe('labels and small helpers', () => {
  it('describes checklist conditions in plain words', () => {
    expect(describeCondition(undefined)).toEqual([])
    expect(describeCondition({ minHeadcount: 5, supervisor: true, flsa: 'non_exempt' })).toEqual(['5+ employees', 'Supervisors', 'Non-exempt'])
    expect(describeCondition({ separationTypes: ['terminated', 'laid_off'] })).toEqual(['Exit: terminated, laid off'])
    expect(describeCondition({ leaveKinds: ['cfra', 'bonding'], outsideCA: true })).toEqual(['Works outside California', 'Leave: CFRA, bonding'])
  })
  it('masks all but the last two digits', () => {
    expect(maskDigits('123-4567-8')).toBe('•••-•••7-8')
    expect(maskDigits('000-0000-0 (placeholder)')).toBe('•••-•••0-0 (placeholder)')
    expect(maskDigits(undefined)).toBe('')
  })
  it('checks link-out URLs', () => {
    expect(urlProblem('')).toBeNull()
    expect(urlProblem('https://example.com/peo')).toBeNull()
    expect(urlProblem('example.com')).toMatch(/https/)
    expect(urlProblem('https://intranet')).toMatch(/domain/)
    expect(hostLabel('https://www.example.com/x')).toBe('example.com')
    expect(hostLabel('nope')).toBeNull()
  })
  it('moves list items without leaving the list', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3])
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3])
  })
  it('computes the exempt floor from the minimum wage', () => {
    expect(exemptFloorFrom(16.9)).toBe(70_304)
  })
  it('falls back to the whole set review date', () => {
    const law = base().settings.law
    expect(reviewedDate(law, 'caMinWageHourly')).toBe(law.lastReviewedOn)
    expect(reviewedDate({ ...law, reviewedOn: { caMinWageHourly: '2027-01-04' } }, 'caMinWageHourly')).toBe('2027-01-04')
  })
  it('names backup files and custom tasks', () => {
    expect(backupFileName('Ledgerlark, Inc.', TODAY)).toBe('ledgerlark-inc-backup-2026-10-09.json')
    expect(backupFileName('', TODAY)).toBe('first-twenty-backup-2026-10-09.json')
    expect(isCustomTask('custom-t-123')).toBe(true)
    expect(isCustomTask('on-piia')).toBe(false)
  })
})

describe('usageOf', () => {
  it('reports what still points at a department or level', () => {
    const db = base()
    const dept = usageOf(db, 'department', 'd-exec')
    expect(dept.count).toBe(1)
    expect(dept.text).toBe('1 person')
    expect(usageOf(db, 'department', 'd-gtm').count).toBe(0)
    const level = usageOf(db, 'level', 'lv-l3')
    expect(level.text).toMatch(/pay bands/)
  })
})

describe('dataWeDontKeep', () => {
  it('lists every sensitive kind and names the system of record', () => {
    const db = base()
    db.company.payrollProvider = { name: 'Acme PEO', kind: 'PEO', url: 'https://peo.example.com' }
    db.company.linkOuts.backgroundCheck = 'https://checks.example.com'
    const rows = dataWeDontKeep(db)
    expect(rows.map((r) => r.item)).toEqual([
      'Social Security numbers',
      'Dates of birth',
      'Bank and direct deposit details',
      'Home street addresses',
      'ID scans',
      'I-9 forms',
      'Background check reports',
      'Medical details',
      'Protected characteristics',
    ])
    expect(rows[0].systemOfRecord).toBe('Acme PEO (PEO)')
    expect(rows[6].systemOfRecord).toContain('checks.example.com')
  })
})

describe('sick leave policy checks', () => {
  const sick = { kind: 'sick' as const, method: 'frontload' as const, annualHours: 40, usageCapHours: 40, capHours: 80, usableAfterDays: 90 }

  it('passes the default policy and ignores other kinds', () => {
    expect(sickPolicyProblem(sick)).toBeNull()
    expect(sickPolicyProblem({ ...sick, usageCapHours: null, capHours: null, usableAfterDays: null })).toBeNull()
    expect(sickPolicyProblem({ kind: 'vacation', method: 'accrual', annualHours: 10, capHours: 5 })).toBeNull()
  })
  it('rejects a wait over 90 days and a grant under 40 hours', () => {
    expect(sickPolicyProblem({ ...sick, usableAfterDays: 120 })).toMatch(/up to 90 days/)
    expect(sickPolicyProblem({ ...sick, annualHours: 24 })).toMatch(/^Grant at least 40 hours a year/)
  })
  it('rejects a yearly use limit under 40 hours or 5 days', () => {
    expect(sickPolicyProblem({ ...sick, usageCapHours: 24 })).toMatch(/^Set the yearly use limit to at least 40 hours/)
    expect(sickPolicyProblem({ ...sick, annualHours: 50, usageCapHours: 40, capHours: null }, 10)).toMatch(/at least 50 hours.*5 days is 50 hours/)
  })
  it('rejects an accrual cap under 80 hours or 10 days, and accrual slower than 1 per 30', () => {
    const accrual = { ...sick, method: 'accrual' as const, annualHours: 70, usageCapHours: null }
    expect(sickPolicyProblem({ ...accrual, capHours: 80 })).toBeNull()
    expect(sickPolicyProblem({ ...accrual, capHours: 48 })).toMatch(/^Set the balance cap to at least 80 hours/)
    expect(sickPolicyProblem({ ...accrual, capHours: null, annualHours: 40 })).toMatch(/1 hour of sick leave for every 30 hours/)
  })
  it('rejects a front-loaded balance cap below the grant', () => {
    expect(sickPolicyProblem({ ...sick, capHours: 32 })).toMatch(/at least 40 hours, or leave it blank/)
    expect(sickPolicyProblem({ ...sick, annualHours: 48, capHours: 40, usageCapHours: null })).toMatch(/at least 48 hours/)
  })
  it('works out the floors from the workday', () => {
    expect(sickLeaveMinimums()).toEqual({ yearly: 40, cap: 80, accrualYearly: 69.33, maxWaitDays: 90 })
    expect(sickLeaveMinimums(10)).toMatchObject({ yearly: 50, cap: 100 })
    expect(sickLeaveMinimums(6)).toMatchObject({ yearly: 40, cap: 80 })
  })
  it('finds the longest workday among current staff in the covered states', () => {
    const db = base()
    const founder = db.people[0]
    expect(longestWorkday(db.people, TODAY, ['CA'])).toBe(8)
    const long = { ...founder, id: 'p-long', hoursPerWeek: 50, homeState: 'CA' }
    const elsewhere = { ...founder, id: 'p-co', hoursPerWeek: 60, homeState: 'CO' }
    const gone = { ...founder, id: 'p-gone', hoursPerWeek: 60, homeState: 'CA', endDate: '2026-01-31' }
    const people = [founder, long, elsewhere, gone]
    expect(longestWorkday(people, TODAY, ['CA'])).toBe(10)
    expect(longestWorkday(people, TODAY)).toBe(12)
  })
})

describe('packFileName', () => {
  it('names a graduation CSV after the company, pack and date', () => {
    expect(packFileName('Ledgerlark, Inc.', 'people', '2026-10-10')).toBe('ledgerlark-inc-people-2026-10-10.csv')
    expect(packFileName('  ', 'equity-grants', '2026-10-10')).toBe('first-twenty-equity-grants-2026-10-10.csv')
  })
})

describe('group health plan', () => {
  it('reads the three states', () => {
    expect(healthPlanChoice('2025-05-12')).toBe('yes')
    expect(healthPlanChoice(null)).toBe('no')
    expect(healthPlanChoice(undefined)).toBe('unknown')
  })

  it('needs a past start date when the company offers a plan', () => {
    expect(healthPlanProblem('yes', '', '2026-10-10')).toMatch(/Pick the date/)
    expect(healthPlanProblem('yes', '2026-11-01', '2026-10-10')).toMatch(/future/)
    expect(healthPlanProblem('yes', '2026-10-01', '2026-10-10')).toBeNull()
    expect(healthPlanProblem('no', '', '2026-10-10')).toBeNull()
  })

  it('writes a date, null for no plan, or clears the field', () => {
    const c: { groupHealthPlanStartedOn?: string | null } = {}
    setHealthPlan(c, 'yes', '2025-05-12')
    expect(c.groupHealthPlanStartedOn).toBe('2025-05-12')
    setHealthPlan(c, 'no', '2025-05-12')
    expect(c.groupHealthPlanStartedOn).toBeNull()
    setHealthPlan(c, 'unknown', '')
    expect('groupHealthPlanStartedOn' in c).toBe(false)
  })
})
