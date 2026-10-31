import type { Entry } from '@/storage/types'
import { EXPORT_PART_MAX_BYTES } from './format'

export interface ExportPart {
  entries: Entry[]
  photoHashes: string[]
  thumbHashes: string[]
  mediumHashes: string[]
  bytes: number
}

/**
 * Splits entries into parts of at most `maxBytes` of file data.
 * An entry always lands in the same part as its files. A single entry larger
 * than the limit gets a part of its own. Purged entries carry no files.
 */
export function planParts(
  entries: Entry[],
  sizes: Map<string, number>,
  maxBytes = EXPORT_PART_MAX_BYTES,
): ExportPart[] {
  const parts: ExportPart[] = []
  let current: ExportPart | null = null
  let seen = new Set<string>()

  for (const entry of entries) {
    const files =
      entry.purgedAt === null
        ? [
            { hash: entry.photoHash, kind: 'photo' as const },
            { hash: entry.thumbHash, kind: 'thumb' as const },
            ...(entry.mediumHash ? [{ hash: entry.mediumHash, kind: 'medium' as const }] : []),
          ].filter((f) => sizes.has(f.hash))
        : []
    const extra = (s: Set<string>) =>
      files.reduce((sum, f) => (s.has(f.hash) ? sum : sum + (sizes.get(f.hash) ?? 0)), 0)

    if (!current || (current.entries.length > 0 && current.bytes + extra(seen) > maxBytes)) {
      current = { entries: [], photoHashes: [], thumbHashes: [], mediumHashes: [], bytes: 0 }
      seen = new Set()
      parts.push(current)
    }
    current.bytes += extra(seen)
    for (const f of files) {
      if (seen.has(f.hash)) continue
      seen.add(f.hash)
      if (f.kind === 'photo') current.photoHashes.push(f.hash)
      else if (f.kind === 'thumb') current.thumbHashes.push(f.hash)
      else current.mediumHashes.push(f.hash)
    }
    current.entries.push(entry)
  }
  return parts
}

export type PeriodKind = 'all' | 'year' | 'month' | 'range'

/** Inclusive dayKey bounds for an export period; null means unbounded. */
export function periodBounds(
  kind: PeriodKind,
  opts: { year?: number; month?: string; from?: string; to?: string } = {},
): { from: string | null; to: string | null } {
  switch (kind) {
    case 'all':
      return { from: null, to: null }
    case 'year':
      return { from: `${opts.year}-01-01`, to: `${opts.year}-12-31` }
    case 'month':
      // month is "YYYY-MM"
      return { from: `${opts.month}-01`, to: `${opts.month}-31` }
    case 'range':
      return { from: opts.from || null, to: opts.to || null }
  }
}
