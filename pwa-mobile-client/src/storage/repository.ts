import Dexie from 'dexie'
import { db as defaultDb, type VibeMemoryDB } from './db'
import { computeDayKey } from '@/utils/date'
import { extractTags, normalizeTag } from '@/utils/tags'
import { summarizeMonths, type MonthSummary } from './months'
import {
  COMMENT_MAX_LENGTH,
  type DayGroup,
  type Draft,
  type DraftFilter,
  type Entry,
  type GeoPoint,
  type MetaKey,
  type ServerEntry,
  type ServerStatus,
  type StoredBlob,
  type UsageInfo,
} from './types'

/** Thrown when the device ran out of storage. Nothing is partially saved. */
export class StorageFullError extends Error {
  constructor(cause?: unknown) {
    super('Недостаточно места на устройстве', { cause })
    this.name = 'StorageFullError'
  }
}

export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { name?: string; inner?: unknown }
  if (err.name === 'QuotaExceededError' || err.name === Dexie.errnames.QuotaExceeded) return true
  return err.inner ? isQuotaError(err.inner) : false
}

async function guardQuota<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (isQuotaError(e)) throw new StorageFullError(e)
    throw e
  }
}

interface BlobInput {
  hash: string
  kind: StoredBlob['kind']
  blob: Blob
}

const nowIso = () => new Date().toISOString()

/** Files an entry needs on the device. An offloaded original is on the server only. */
function localHashes(e: Entry): string[] {
  const hashes = [e.thumbHash]
  if (!e.offloaded) hashes.push(e.photoHash)
  if (e.mediumHash) hashes.push(e.mediumHash)
  return hashes
}
const clampComment = (text: string) => text.slice(0, COMMENT_MAX_LENGTH)
/** A plain copy: IndexedDB cannot store the reactive proxies a draft held in a Vue ref carries. */
const plainLocation = (p: GeoPoint | null | undefined): GeoPoint | null =>
  p ? { lat: p.lat, lon: p.lon, accuracy: p.accuracy } : null

export function createRepository(db: VibeMemoryDB = defaultDb) {
  // Notified after any change to entries, e.g. to schedule an upload.
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((fn) => fn())
  // Notified when the server confirms entries or files. Kept apart from `listeners`: it must not schedule an upload.
  const statusListeners = new Set<() => void>()
  const notifyStatus = () => statusListeners.forEach((fn) => fn())

  async function getMeta<T>(key: MetaKey): Promise<T | undefined> {
    return (await db.meta.get(key))?.value as T | undefined
  }

  async function setMeta(key: MetaKey, value: unknown): Promise<void> {
    await guardQuota(() => db.meta.put({ key, value }))
  }

  /** Deletes blobs that no live (not purged) entry references. Must run inside a rw transaction. */
  async function collectGarbage(hashes: Iterable<string>): Promise<void> {
    const candidates = new Set(hashes)
    if (candidates.size === 0) return
    await db.entries
      .filter((e) => e.purgedAt === null && localHashes(e).some((h) => candidates.has(h)))
      .each((e) => localHashes(e).forEach((h) => candidates.delete(h)))
    if (candidates.size) await db.blobs.bulkDelete([...candidates])
  }

  async function putBlobIfMissing(file: BlobInput): Promise<void> {
    if (await db.blobs.get(file.hash)) return
    await db.blobs.add({ hash: file.hash, kind: file.kind, blob: file.blob, size: file.blob.size })
  }

  async function sortedDay(dayKey: string, deleted: boolean): Promise<Entry[]> {
    const rows = await db.entries.where('dayKey').equals(dayKey).toArray()
    return rows
      .filter((e) => e.deleted === deleted && e.purgedAt === null)
      .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
  }

  return {
    getMeta,
    setMeta,

    /** Subscribes to entry changes; returns the unsubscribe function. */
    onChange(fn: () => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /** Subscribes to server confirmations (seq, serverStatus); returns the unsubscribe function. */
    onServerStatus(fn: () => void): () => void {
      statusListeners.add(fn)
      return () => statusListeners.delete(fn)
    },

    // --- drafts ---------------------------------------------------------

    async getDraft(): Promise<Draft | undefined> {
      return getMeta<Draft>('draft')
    },

    async saveDraft(draft: Draft): Promise<void> {
      await setMeta('draft', draft)
    },

    async updateDraftComment(comment: string): Promise<void> {
      await db.meta.where('key').equals('draft').modify((row) => {
        ;(row.value as Draft).comment = clampComment(comment)
      })
    },

    async updateDraftLocation(location: GeoPoint): Promise<void> {
      await db.meta.where('key').equals('draft').modify((row) => {
        ;(row.value as Draft).location = plainLocation(location)
      })
    },

    async updateDraftFilter(filter: DraftFilter): Promise<void> {
      await db.meta.where('key').equals('draft').modify((row) => {
        ;(row.value as Draft).filter = filter
      })
    },

    async deleteDraft(): Promise<void> {
      await db.meta.delete('draft')
    },

    // --- entries --------------------------------------------------------

    /** Saves the entry and both files atomically, then removes the draft. */
    async createEntry(draft: Draft): Promise<Entry> {
      const now = nowIso()
      const entry: Entry = {
        id: crypto.randomUUID(),
        takenAt: draft.takenAt,
        tzOffsetMin: draft.tzOffsetMin,
        dayKey: computeDayKey(draft.takenAt, draft.tzOffsetMin),
        comment: clampComment(draft.comment.trim()),
        photoHash: draft.photoHash,
        thumbHash: draft.thumbHash,
        width: draft.width,
        height: draft.height,
        location: plainLocation(draft.location),
        createdAt: now,
        updatedAt: now,
        deleted: false,
        purgedAt: null,
        syncStatus: 'pending',
      }
      await guardQuota(() =>
        db.transaction('rw', db.entries, db.blobs, db.meta, async () => {
          await putBlobIfMissing({ hash: draft.photoHash, kind: 'original', blob: draft.original })
          await putBlobIfMissing({ hash: draft.thumbHash, kind: 'thumb', blob: draft.thumb })
          await db.entries.add(entry)
          await db.meta.delete('draft')
        }),
      )
      notify()
      return entry
    },

    async updateComment(id: string, text: string): Promise<void> {
      await guardQuota(() =>
        db.entries.update(id, { comment: clampComment(text), updatedAt: nowIso(), syncStatus: 'pending' }),
      )
      notify()
    },

    async softDelete(id: string): Promise<void> {
      await db.entries.update(id, { deleted: true, updatedAt: nowIso(), syncStatus: 'pending' })
      notify()
    },

    async restore(id: string): Promise<void> {
      await db.entries
        .where('id')
        .equals(id)
        .and((e) => e.purgedAt === null)
        .modify({ deleted: false, updatedAt: nowIso(), syncStatus: 'pending' })
      notify()
    },

    /** Final deletion from the trash: files go away, the entry stays as a tombstone. */
    async purge(id: string): Promise<void> {
      await db.transaction('rw', db.entries, db.blobs, async () => {
        const entry = await db.entries.get(id)
        if (!entry || !entry.deleted || entry.purgedAt) return
        const now = nowIso()
        await db.entries.update(id, { purgedAt: now, updatedAt: now, syncStatus: 'pending' })
        await collectGarbage(localHashes(entry))
      })
      notify()
    },

    /**
     * Days with live entries, newest first, strictly before `beforeDayKey`
     * (pass null to start from the newest day).
     */
    async listDays(beforeDayKey: string | null, limit: number): Promise<DayGroup[]> {
      const keys = (await db.entries.orderBy('dayKey').reverse().uniqueKeys()) as string[]
      const result: DayGroup[] = []
      for (const dayKey of keys) {
        if (beforeDayKey !== null && dayKey >= beforeDayKey) continue
        const entries = await sortedDay(dayKey, false)
        if (entries.length) result.push({ dayKey, entries })
        if (result.length >= limit) break
      }
      return result
    },

    /** Live entries with fromDayKey <= dayKey <= toDayKey, grouped by day, oldest day first. */
    async listDayRange(fromDayKey: string, toDayKey: string): Promise<DayGroup[]> {
      const rows = await db.entries.where('dayKey').between(fromDayKey, toDayKey, true, true).toArray()
      const byDay = new Map<string, Entry[]>()
      for (const e of rows) {
        if (e.deleted || e.purgedAt !== null) continue
        const list = byDay.get(e.dayKey)
        if (list) list.push(e)
        else byDay.set(e.dayKey, [e])
      }
      return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dayKey, entries]) => ({ dayKey, entries: entries.sort((a, b) => a.takenAt.localeCompare(b.takenAt)) }))
    },

    /** Live photos per month, for the zoomed-out calendar. */
    async listMonths(): Promise<Map<string, MonthSummary>> {
      return summarizeMonths(await db.entries.filter((e) => !e.deleted && e.purgedAt === null).toArray())
    },

    /** Live entries whose comment has the hashtag (case-insensitive, `#` optional), newest first. */
    async searchByTag(tag: string): Promise<Entry[]> {
      const wanted = normalizeTag(tag)
      if (!wanted) return []
      const rows = await db.entries
        .filter((e) => !e.deleted && e.purgedAt === null && extractTags(e.comment).includes(wanted))
        .toArray()
      return rows.sort((a, b) => b.takenAt.localeCompare(a.takenAt))
    },

    /** Every hashtag used by live entries with its photo count, most used first. */
    async listTags(): Promise<Array<{ tag: string; count: number }>> {
      const counts = new Map<string, number>()
      await db.entries
        .filter((e) => !e.deleted && e.purgedAt === null)
        .each((e) => extractTags(e.comment).forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)))
      return [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    },

    async getDay(dayKey: string): Promise<Entry[]> {
      return sortedDay(dayKey, false)
    },

    async getEntry(id: string): Promise<Entry | undefined> {
      return db.entries.get(id)
    },

    async getBlob(hash: string): Promise<Blob | undefined> {
      return (await db.blobs.get(hash))?.blob
    },

    async getBlobRecord(hash: string): Promise<StoredBlob | undefined> {
      return db.blobs.get(hash)
    },

    async listTrash(): Promise<Entry[]> {
      const rows = await db.entries.filter((e) => e.deleted && e.purgedAt === null).toArray()
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    /** All entries (including deleted and purged) whose day falls in [from, to]. */
    async listForExport(fromDayKey: string | null, toDayKey: string | null): Promise<Entry[]> {
      const lower = fromDayKey ?? Dexie.minKey
      const upper = toDayKey ?? Dexie.maxKey
      const rows = await db.entries.where('dayKey').between(lower, upper, true, true).toArray()
      return rows.sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    },

    async blobSizes(hashes: string[]): Promise<Map<string, number>> {
      const map = new Map<string, number>()
      const rows = await db.blobs.bulkGet(hashes)
      rows.forEach((row) => row && map.set(row.hash, row.size))
      return map
    },

    // --- upload to the home server ----------------------------------------

    /** Entries changed since the last successful upload, oldest change first. */
    async listPending(limit: number): Promise<Entry[]> {
      const rows = await db.entries.where('syncStatus').equals('pending').toArray()
      return rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit)
    },

    async countPending(): Promise<number> {
      return db.entries.where('syncStatus').equals('pending').count()
    },

    /**
     * Records the server's answer for sent entries. An entry edited while the
     * request was in flight has a newer updatedAt and stays pending.
     */
    async markSynced(
      sent: Array<Pick<Entry, 'id' | 'updatedAt'> & { seq: number; status: ServerStatus | 'purged' }>,
    ): Promise<void> {
      await db.transaction('rw', db.entries, async () => {
        for (const s of sent) {
          await db.entries
            .where('id')
            .equals(s.id)
            .modify((e) => {
              e.seq = s.seq
              if (s.status !== 'purged') e.serverStatus = s.status
              if (e.updatedAt === s.updatedAt) e.syncStatus = 'synced'
            })
        }
      })
      notifyStatus()
    },

    /** Server status after a file upload. */
    async setServerStatus(id: string, seq: number, status: ServerStatus): Promise<void> {
      await db.entries.update(id, { seq, serverStatus: status })
      notifyStatus()
    },

    /**
     * Applies one version from the server's change feed (last write wins).
     * A local edit that is newer and not yet sent is kept. An entry new to
     * this device has its original on the server only. Returns whether the
     * local entry changed.
     */
    async applyRemote(remote: ServerEntry, seq: number, status: ServerStatus | 'purged'): Promise<boolean> {
      const changed = await guardQuota(() =>
        db.transaction('rw', db.entries, db.blobs, async () => {
          const local = await db.entries.get(remote.id)
          if (local && local.syncStatus === 'pending' && local.updatedAt > remote.updatedAt) return false
          const serverStatus = status === 'purged' ? local?.serverStatus : status
          if (!local) {
            await db.entries.add({ ...remote, syncStatus: 'synced', seq, serverStatus, offloaded: remote.purgedAt === null })
            return true
          }
          await db.entries.put({
            ...remote,
            syncStatus: 'synced',
            seq,
            serverStatus,
            offloaded: local.offloaded,
            mediumHash: local.mediumHash,
          })
          if (remote.purgedAt !== null && local.purgedAt === null) await collectGarbage(localHashes(local))
          return local.updatedAt !== remote.updatedAt
        }),
      )
      if (changed) notify()
      return changed
    },

    /** Stores a thumbnail downloaded from the server. */
    async putThumb(hash: string, blob: Blob): Promise<void> {
      await guardQuota(() => putBlobIfMissing({ hash, kind: 'thumb', blob }))
    },

    async hasBlob(hash: string): Promise<boolean> {
      return (await db.blobs.get(hash)) !== undefined
    },

        // --- originals kept only on the server -------------------------------

    /** Live entries taken before `beforeIso` that the server holds in full, with the original still on the device. */
    async listOffloadCandidates(beforeIso: string): Promise<Entry[]> {
      const rows = await db.entries.where('takenAt').below(beforeIso).toArray()
      return rows.filter((e) => e.serverStatus === 'complete' && !e.offloaded && !e.deleted && e.purgedAt === null)
    },

    /**
     * Replaces the original with the medium copy. Local only: updatedAt and
     * syncStatus stay as they are, and listeners are not notified (nothing to upload).
     * Returns false when the entry changed meanwhile.
     */
    async offloadOriginal(id: string, medium: { hash: string; blob: Blob }): Promise<boolean> {
      return guardQuota(() =>
        db.transaction('rw', db.entries, db.blobs, async () => {
          const entry = await db.entries.get(id)
          if (!entry || entry.offloaded || entry.deleted || entry.purgedAt) return false
          await putBlobIfMissing({ hash: medium.hash, kind: 'medium', blob: medium.blob })
          await db.entries.update(id, { offloaded: true, mediumHash: medium.hash })
          await collectGarbage([entry.photoHash])
          return true
        }),
      )
    },

    async countOffloaded(): Promise<number> {
      return db.entries.filter((e) => e.offloaded === true && e.purgedAt === null).count()
    },

    /** Forgets everything known about the server: the next sync sends all entries and reads the whole feed. */
    async resetSync(): Promise<void> {
      await db.transaction('rw', db.entries, db.meta, async () => {
        await db.entries.toCollection().modify((e) => {
          e.syncStatus = 'pending'
          delete e.seq
          delete e.serverStatus
        })
        await db.meta.delete('lastSeq')
      })
      notify()
    },

    async estimateUsage(): Promise<UsageInfo> {
      const entryCount = await db.entries.filter((e) => e.purgedAt === null).count()
      const offloadedCount = await db.entries.filter((e) => e.offloaded === true && e.purgedAt === null).count()
      let usage: number | null = null
      let quota: number | null = null
      let persisted: boolean | null = null
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate()
        usage = est.usage ?? null
        quota = est.quota ?? null
      }
      if (navigator.storage?.persisted) persisted = await navigator.storage.persisted()
      return { usage, quota, entryCount, persisted, offloadedCount }
    },

    /**
     * Asks for persistent storage unless the browser already granted it. The answer is never cached:
     * iOS may revoke it, and Safari decides better when the call comes straight from a tap.
     */
    async ensurePersisted(): Promise<boolean | undefined> {
      if (!navigator.storage?.persist) return undefined
      if (await navigator.storage.persisted()) return true
      return navigator.storage.persist()
    },
  }
}

export type Repository = ReturnType<typeof createRepository>

export const repository = createRepository()
