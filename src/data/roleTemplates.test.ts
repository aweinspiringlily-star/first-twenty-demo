import { describe, expect, it } from 'vitest'
import { DEFAULT_BANDS, DEFAULT_DEPARTMENTS, DEFAULT_FAMILIES, DEFAULT_LEVELS, DEFAULT_STAGES } from '@/data/defaults'
import { postingLint, salaryHistoryLint } from '@/domain/hiring/postings'
import { SAMPLE_ROLE_TEMPLATES } from './roleTemplates'

const T = SAMPLE_ROLE_TEMPLATES

describe('SAMPLE_ROLE_TEMPLATES (Ledgerlark)', () => {
  it('has the 13 roles with unique ids', () => {
    expect(T.map((t) => t.name)).toEqual([
      'Senior full-stack engineer',
      'ML engineer (agents)',
      'Applied AI engineer (evals)',
      'Data engineer (ERP connectors)',
      'Security and compliance engineer',
      'Product designer',
      'Product manager (close and reconciliation)',
      'Founding account executive',
      'Solutions engineer',
      'Implementation lead',
      'Customer success manager',
      'Accounting lead',
      'Ops and people generalist',
    ])
    expect(new Set(T.map((t) => t.id)).size).toBe(13)
  })

  it('uses real family, level and department ids with a band for each', () => {
    for (const t of T) {
      expect(DEFAULT_FAMILIES.some((f) => f.id === t.familyId)).toBe(true)
      expect(DEFAULT_LEVELS.some((l) => l.id === t.levelId)).toBe(true)
      expect(DEFAULT_DEPARTMENTS.some((d) => d.id === t.departmentId)).toBe(true)
      expect(DEFAULT_BANDS.some((b) => b.familyId === t.familyId && b.levelId === t.levelId)).toBe(true)
    }
  })

  it('uses the default stages and SLAs, with the sales role renaming Technical', () => {
    for (const t of T) {
      expect(t.stages.map((s) => [s.id, s.kind, s.slaBusinessDays ?? null])).toEqual(DEFAULT_STAGES.map((s) => [s.id, s.kind, s.slaBusinessDays ?? null]))
      const technical = t.stages.find((s) => s.id === 'technical')?.name
      expect(technical).toBe(t.id === 'rt-ae-founding' ? 'Mock discovery call' : 'Technical')
    }
  })

  it('has an interview plan on real stages with 3 to 5 attributes, each with an anchor and 2 questions', () => {
    for (const t of T) {
      expect(t.interviewPlan.length).toBeGreaterThanOrEqual(3)
      const stepIds = new Set<string>()
      for (const s of t.interviewPlan) {
        expect(t.stages.some((st) => st.id === s.stageId)).toBe(true)
        expect(stepIds.has(s.id)).toBe(false)
        stepIds.add(s.id)
        expect(s.durationMin).toBeGreaterThan(0)
        expect(s.attributes.length).toBeGreaterThanOrEqual(3)
        expect(s.attributes.length).toBeLessThanOrEqual(5)
        for (const a of s.attributes) {
          expect(a.anchor && a.anchor.length > 20).toBe(true)
          expect(a.questions).toHaveLength(2)
        }
      }
      for (const stage of ['intro', 'technical', 'onsite']) expect(t.interviewPlan.some((s) => s.stageId === stage)).toBe(true)
    }
  })

  it('has JD outlines with the three sections and domain specifics', () => {
    const all = T.map((t) => t.jdOutline).join('\n')
    for (const t of T) {
      expect(t.jdOutline).toContain("What you'll do\n- ")
      expect(t.jdOutline).toContain('\n\nWhat you bring\n- ')
      expect(t.jdOutline).toContain('\n\nNice to have\n- ')
    }
    for (const term of ['NetSuite', 'Sage Intacct', 'QuickBooks Online', 'reconcil', 'accrual', 'flux', 'SOC 2', 'eval']) expect(all).toContain(term)
  })

  it('passes the posting linter and copy rules', () => {
    for (const t of T) {
      const text = [t.name, t.jdOutline, ...t.interviewPlan.flatMap((s) => [s.name, ...s.attributes.flatMap((a) => [a.name, a.anchor ?? '', ...(a.questions ?? [])])])].join('\n')
      expect(postingLint({ payMin: 1, payMax: 2, description: text })).toEqual([])
      expect(salaryHistoryLint(text)).toBeNull()
      expect(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2013))).toBe(false)
      expect(t.name.charAt(0)).toBe(t.name.charAt(0).toUpperCase())
    }
  })

  it('keeps posting qualifiers out of the names (they become job, letter and employee titles)', () => {
    for (const t of T) expect(t.name, t.id).not.toMatch(/\b(CPA|preferred|required)\b/i)
    const csm = T.find((t) => t.id === 'rt-csm')
    expect(csm).toMatchObject({ name: 'Customer success manager', hint: 'CPA preferred' })
    expect(csm?.jdOutline).toContain('CPA license')
    expect(T.find((t) => t.id === 'rt-accounting-lead')).toMatchObject({ name: 'Accounting lead', hint: 'CPA' })
  })
})
