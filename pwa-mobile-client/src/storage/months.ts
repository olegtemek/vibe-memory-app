import type { Entry } from './types'

export const MONTH_COVERS = 4

/** Photos of one calendar month, for the zoomed-out calendar. */
export interface MonthSummary {
  /** YYYY-MM in the local time of capture. */
  monthKey: string
  count: number
  /** Thumbnail hashes of a few photos of the month. */
  covers: string[]
}

/**
 * Groups live entries by month. Covers are picked by photo hash: random-looking,
 * but stable between visits as long as the month's photos stay the same.
 */
export function summarizeMonths(entries: Entry[]): Map<string, MonthSummary> {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    if (e.deleted || e.purgedAt !== null) continue
    const key = e.dayKey.slice(0, 7)
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }
  const result = new Map<string, MonthSummary>()
  for (const [monthKey, list] of groups) {
    const covers = [...list]
      .sort((a, b) => a.photoHash.localeCompare(b.photoHash))
      .slice(0, MONTH_COVERS)
      .map((e) => e.thumbHash)
    result.set(monthKey, { monthKey, count: list.length, covers })
  }
  return result
}
