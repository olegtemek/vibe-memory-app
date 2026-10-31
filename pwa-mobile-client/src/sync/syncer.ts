import type { Repository } from '@/storage/repository'
import type { Entry } from '@/storage/types'
import { ServerError, type ServerClient } from './client'

export const PUSH_BATCH_SIZE = 20

export type SyncPhase = 'pull' | 'push' | 'files'

export interface SyncProgress {
  phase: SyncPhase
  done: number
  /** Unknown while paging through the server's lists. */
  total: number | null
}

export interface SyncResult {
  /** Local entries added or changed from the server. */
  pulled: number
  /** Entry versions the server accepted. */
  pushed: number
  /** Files uploaded. */
  files: number
  failed: number
  errors: string[]
}

/**
 * One full exchange with the server:
 * 1. pull: apply every change after the stored lastSeq, download missing thumbnails;
 * 2. push: send pending entries (metadata only), record seq and status from the answer;
 * 3. files: upload the files the server reports missing, one at a time.
 * Network, auth and server errors abort the run (thrown as ServerError) and are
 * safe to retry: every step is idempotent.
 */
export async function syncAll(
  repo: Repository,
  client: ServerClient,
  onProgress?: (p: SyncProgress) => void,
  batchSize = PUSH_BATCH_SIZE,
): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, files: 0, failed: 0, errors: [] }
  await pull(repo, client, result, onProgress)
  await push(repo, client, result, onProgress, batchSize)
  await uploadFiles(repo, client, result, onProgress)
  await repo.setMeta('lastUploadAt', new Date().toISOString())
  return result
}

async function pull(repo: Repository, client: ServerClient, result: SyncResult, onProgress?: (p: SyncProgress) => void) {
  let after = (await repo.getMeta<number>('lastSeq')) ?? 0
  let done = 0
  onProgress?.({ phase: 'pull', done, total: null })
  for (;;) {
    const page = await client.changes(after)
    for (const item of page.items) {
      if (await repo.applyRemote(item.entry, item.seq, item.status)) result.pulled++
      const thumbHash = item.entry.thumbHash
      if (item.status !== 'purged' && !item.missing.includes('thumb') && !(await repo.hasBlob(thumbHash))) {
        try {
          await repo.putThumb(thumbHash, await client.getFile(item.entry.id, 'thumb', thumbHash))
        } catch (e) {
          // A broken file is reported; the feed moves on and the thumbnail comes with the entry's next change.
          if (!(e instanceof ServerError) || e.kind !== 'protocol') throw e
          result.failed++
          result.errors.push(`Запись ${item.entry.id}: ${e.message.toLowerCase()}`)
        }
      }
      after = Math.max(after, item.seq)
      onProgress?.({ phase: 'pull', done: ++done, total: null })
    }
    await repo.setMeta('lastSeq', after)
    if (!page.hasMore) break
  }
}

async function push(
  repo: Repository,
  client: ServerClient,
  result: SyncResult,
  onProgress: ((p: SyncProgress) => void) | undefined,
  batchSize: number,
) {
  // Snapshot so rejected entries are not retried in an endless loop within one run.
  const pending = await repo.listPending(Number.POSITIVE_INFINITY)
  onProgress?.({ phase: 'push', done: 0, total: pending.length })
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const sent = new Map<string, Entry>(batch.map((e) => [e.id, e]))
    const results = (await client.pushEntries(batch)).filter((r) => sent.has(r.id))
    await repo.markSynced(results.map((r) => ({ ...r, updatedAt: sent.get(r.id)!.updatedAt })))
    result.pushed += results.length
    const rejected = batch.length - results.length
    if (rejected) {
      result.failed += rejected
      result.errors.push(`Сервер не принял записей: ${rejected}`)
    }
    onProgress?.({ phase: 'push', done: Math.min(i + batchSize, pending.length), total: pending.length })
  }
}

async function uploadFiles(
  repo: Repository,
  client: ServerClient,
  result: SyncResult,
  onProgress?: (p: SyncProgress) => void,
) {
  let after = 0
  onProgress?.({ phase: 'files', done: 0, total: null })
  for (;;) {
    const page = await client.listPartial(after)
    for (const item of page.items) {
      after = Math.max(after, item.seq)
      const entry = await repo.getEntry(item.id)
      // Entries from another device: that device uploads their files.
      if (!entry || entry.purgedAt !== null) continue
      for (const kind of item.missing) {
        const hash = kind === 'original' ? entry.photoHash : entry.thumbHash
        const blob = kind === 'original' && entry.offloaded ? undefined : await repo.getBlob(hash)
        if (!blob) {
          // An original this device once had (it kept a medium copy) is lost for this server.
          if (kind === 'original' && entry.mediumHash) {
            result.failed++
            result.errors.push(`Запись ${entry.id}: оригинала нет ни на устройстве, ни на этом сервере`)
          }
          continue
        }
        const res = await client.putFile(entry.id, kind, blob)
        if (res.status !== 'purged') await repo.setServerStatus(entry.id, res.seq, res.status)
        result.files++
        onProgress?.({ phase: 'files', done: result.files, total: null })
      }
    }
    if (!page.hasMore) break
  }
}
