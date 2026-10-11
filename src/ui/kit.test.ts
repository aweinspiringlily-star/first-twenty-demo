// Pure helpers behind the UI kit: chart ticks, weekend-aware date chips and the undo history ids.
import { describe, expect, it } from 'vitest'
import { useDB } from '@/store/db'
import { monthTickLabels, niceTicks } from './charts'
import { defaultDateChips } from './Chips'

describe('chart ticks (design-6)', () => {
  it('uses round steps, never odd halves', () => {
    expect(niceTicks(25)).toEqual([0, 5, 10, 15, 20, 25])
    expect(niceTicks(20)).toEqual([0, 5, 10, 15, 20])
    expect(niceTicks(10)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(5)).toEqual([0, 1, 2, 3, 4, 5])
    expect(niceTicks(100)).toEqual([0, 20, 40, 60, 80, 100])
  })

  it('names the year on the first tick and wherever it changes', () => {
    expect(monthTickLabels(['2025-03-01', '2025-09-01', '2026-03-01', '2026-09-01'])).toEqual(['Mar 2025', 'Sep', 'Mar 2026', 'Sep'])
  })
})

describe('date chips on a weekend (flow-13)', () => {
  it('never shows Today or Tomorrow picking Monday, and has one chip per date', () => {
    const chips = defaultDateChips('2026-10-10', true) // Saturday
    expect(chips.map((c) => c.label)).toEqual(['Next Mon', 'Mon, Oct 19', 'Mon, Oct 26'])
    expect(new Set(chips.map((c) => c.date)).size).toBe(chips.length)
  })

  it('keeps the usual chips on a weekday', () => {
    expect(defaultDateChips('2026-10-08', true).map((c) => c.label)).toEqual(['Today', 'Tomorrow', 'Next Mon', '+1 week', '+2 weeks'])
  })
})

describe('undo history (cq-1)', () => {
  it('undoes a change by id only while it is the newest one', () => {
    const { mutate } = useDB.getState()
    mutate('First change', (d) => {
      d.company.name = 'One'
    })
    const first = useDB.getState().past.at(-1)
    mutate('Second change', (d) => {
      d.company.name = 'Two'
    })
    const second = useDB.getState().past.at(-1)
    expect(first && second && first.id !== second.id).toBe(true)
    if (!first || !second) return
    expect(useDB.getState().undoEntry(first.id)).toBe('newer')
    expect(useDB.getState().db.company.name).toBe('Two')
    expect(useDB.getState().undoEntry(second.id)).toBe('undone')
    expect(useDB.getState().db.company.name).toBe('One')
    expect(useDB.getState().undoEntry(second.id)).toBe('gone')
    expect(useDB.getState().undoEntry(first.id)).toBe('undone')
  })
})
