import { describe, expect, it } from 'vitest'
import { computeDayKey, formatDayTitle, formatMonthTitle, formatTime, monthWeeks, plural } from '@/utils/date'

describe('computeDayKey', () => {
  it('uses the local time of capture, not UTC', () => {
    // 23:30 UTC on Oct 28 is 02:30 on Oct 29 in UTC+3
    expect(computeDayKey('2026-10-28T23:30:00.000Z', 180)).toBe('2026-10-29')
    expect(computeDayKey('2026-10-28T23:30:00.000Z', 0)).toBe('2026-10-28')
    // 03:00 UTC is still the previous day in UTC-5
    expect(computeDayKey('2026-10-29T03:00:00.000Z', -300)).toBe('2026-10-28')
  })

  it('formats time in the capture time zone', () => {
    expect(formatTime('2026-10-28T23:30:00.000Z', 180)).toBe('02:30')
  })
})

describe('formatDayTitle', () => {
  const now = new Date(2026, 9, 29)
  it('omits the current year', () => {
    expect(formatDayTitle('2026-10-29', now)).toBe('29 октября, четверг')
  })
  it('adds a different year', () => {
    expect(formatDayTitle('2025-01-01', now)).toBe('1 января 2025, среда')
  })
})

describe('plural', () => {
  const f: [string, string, string] = ['фотография', 'фотографии', 'фотографий']
  it.each([
    [1, 'фотография'],
    [2, 'фотографии'],
    [5, 'фотографий'],
    [11, 'фотографий'],
    [21, 'фотография'],
    [104, 'фотографии'],
  ])('%i → %s', (n, word) => expect(plural(n, f)).toBe(word))
})

describe('monthWeeks', () => {
  it('lays out a month in Monday-first weeks', () => {
    // October 2026 starts on Thursday and has 31 days.
    const weeks = monthWeeks('2026-10-29')
    expect(weeks).toHaveLength(5)
    expect(weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(weeks[4]).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null])
  })

  it('formats the month title', () => {
    expect(formatMonthTitle('2026-10-29')).toBe('Октябрь 2026')
  })
})
