// The sample company's moving dates: only loadSample moves them, so the banner's promise holds only
// while a loaded copy still matches this week (r2-39).
import { afterEach, describe, expect, it } from 'vitest'
import { addDays, setClockOverride } from '@/lib/dates'
import { loadSample, sampleIsCurrent } from './db'

afterEach(() => setClockOverride(null))

describe('sampleIsCurrent', () => {
  it('is true for a sample loaded this week, also on its anchor day (no shift)', () => {
    const anchor = loadSample().meta.sampleAnchor as string
    setClockOverride(anchor)
    expect(sampleIsCurrent(loadSample())).toBe(true)
    setClockOverride(addDays(anchor, 30))
    const later = loadSample()
    expect(later.meta.sampleShiftDays).toBe(28)
    expect(sampleIsCurrent(later)).toBe(true)
    // Two days on is still the same whole-week shift.
    setClockOverride(addDays(anchor, 31))
    expect(sampleIsCurrent(later)).toBe(true)
  })

  it('is false once a saved copy is opened in a later week', () => {
    const anchor = loadSample().meta.sampleAnchor as string
    setClockOverride(anchor)
    const saved = loadSample()
    setClockOverride(addDays(anchor, 14))
    expect(sampleIsCurrent(saved)).toBe(false)
  })

  it('is false for a workspace that is not the sample', () => {
    const db = loadSample()
    expect(sampleIsCurrent({ meta: { ...db.meta, sample: false } })).toBe(false)
    expect(sampleIsCurrent({ meta: { ...db.meta, sampleAnchor: undefined } })).toBe(false)
  })
})
