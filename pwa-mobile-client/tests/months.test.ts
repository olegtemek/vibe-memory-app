import { describe, expect, it } from 'vitest'
import { MONTH_COVERS, summarizeMonths } from '@/storage/months'
import type { Entry } from '@/storage/types'
import { formatBadgeCount, isMonthKey, shiftMonth } from '@/utils/date'
import { freshRepo, makeDraft } from './helpers'

function entry(id: string, dayKey: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    takenAt: `${dayKey}T12:00:00.000Z`,
    tzOffsetMin: 0,
    dayKey,
    comment: '',
    photoHash: `p-${id}`,
    thumbHash: `t-${id}`,
    width: 1,
    height: 1,
    createdAt: '',
    updatedAt: '',
    deleted: false,
    purgedAt: null,
    syncStatus: 'pending',
    ...extra,
  }
}

describe('summarizeMonths', () => {
  it('counts live photos per month and picks a few stable covers', () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => entry(`o${i}`, `2026-10-0${i + 1}`)),
      entry('s1', '2026-09-30'),
      entry('gone', '2026-09-01', { deleted: true }),
      entry('purged', '2026-08-01', { deleted: true, purgedAt: 'x' }),
    ]
    const months = summarizeMonths(list)
    expect(months.get('2026-10')?.count).toBe(6)
    expect(months.get('2026-10')?.covers).toHaveLength(MONTH_COVERS)
    expect(months.get('2026-09')).toEqual({ monthKey: '2026-09', count: 1, covers: ['t-s1'] })
    expect(months.has('2026-08')).toBe(false)
    // The same photos give the same covers in any order.
    expect(summarizeMonths([...list].reverse()).get('2026-10')?.covers).toEqual(months.get('2026-10')?.covers)
  })

  it('is available from the repository', async () => {
    const { repo } = freshRepo()
    await repo.createEntry(await makeDraft('a', { takenAt: '2026-05-10T12:00:00.000Z', tzOffsetMin: 0 }))
    await repo.createEntry(await makeDraft('b', { takenAt: '2026-05-11T12:00:00.000Z', tzOffsetMin: 0 }))
    expect((await repo.listMonths()).get('2026-05')?.count).toBe(2)
  })
})

describe('month helpers', () => {
  it('shifts months across years', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2025-12', 1)).toBe('2026-01')
    expect(shiftMonth('2026-10', -22)).toBe('2024-12')
  })

  it('validates month keys', () => {
    expect(isMonthKey('2026-10')).toBe(true)
    expect(isMonthKey('2026-13')).toBe(false)
    expect(isMonthKey(['2026-10'])).toBe(false)
  })

  it('caps the badge at 99+', () => {
    expect(formatBadgeCount(7)).toBe('7')
    expect(formatBadgeCount(99)).toBe('99')
    expect(formatBadgeCount(100)).toBe('99+')
  })
})

describe('pinch', () => {
  it('detects pinch in and out past the thresholds', async () => {
    const { pinchOutcome, feedbackScale, distance, midpoint } = await import('@/composables/usePinch')
    expect(pinchOutcome(0.6)).toBe('in')
    expect(pinchOutcome(1)).toBeNull()
    expect(pinchOutcome(1.5)).toBe('out')
    expect(feedbackScale(0.2)).toBe(0.8)
    expect(feedbackScale(3)).toBe(1.25)
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual({ x: 2, y: 1 })
  })
})
