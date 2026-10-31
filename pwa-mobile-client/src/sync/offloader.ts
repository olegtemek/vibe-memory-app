import { makeMedium } from '@/image/process'
import type { Repository } from '@/storage/repository'
import type { ServerClient } from './client'

const DAY_MS = 24 * 60 * 60 * 1000

export interface OffloadOptions {
  keepDays: number
  now?: Date
  makeMedium?: (original: Blob) => Promise<{ hash: string; blob: Blob }>
}

/**
 * Removes originals older than `keepDays` from the device, keeping a medium
 * copy instead. Only entries the server reported as complete qualify, and each
 * original is checked on the server right before removal. Returns how many
 * originals were removed.
 */
export async function offloadOldOriginals(repo: Repository, client: ServerClient, opts: OffloadOptions): Promise<number> {
  const now = opts.now ?? new Date()
  const encode = opts.makeMedium ?? makeMedium
  const cutoff = new Date(now.getTime() - opts.keepDays * DAY_MS).toISOString()
  let removed = 0

  for (const entry of await repo.listOffloadCandidates(cutoff)) {
    if (!(await client.hasFile(entry.id, 'original'))) continue
    const original = await repo.getBlob(entry.photoHash)
    if (!original) continue
    // One original at a time: decoding several 2048 px images at once is heavy for iOS.
    const medium = await encode(original)
    if (await repo.offloadOriginal(entry.id, medium)) removed++
  }
  return removed
}
