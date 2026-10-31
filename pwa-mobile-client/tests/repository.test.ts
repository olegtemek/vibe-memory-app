import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { freshRepo, makeDraft } from './helpers'

describe('repository', () => {
  it('creates an entry with both files and removes the draft', async () => {
    const { db, repo } = freshRepo()
    const draft = await makeDraft('a', { comment: '  привет  ' })
    await repo.saveDraft(draft)
    const entry = await repo.createEntry(draft)

    expect(entry.dayKey).toBe('2026-10-29')
    expect(entry.comment).toBe('привет')
    expect(entry.syncStatus).toBe('pending')
    expect(await db.blobs.count()).toBe(2)
    expect(await repo.getDraft()).toBeUndefined()
    expect((await repo.getDay('2026-10-29')).map((e) => e.id)).toEqual([entry.id])
  })

  it('stores the chosen film filter in the draft', async () => {
    const { repo } = freshRepo()
    await repo.saveDraft(await makeDraft('f'))
    await repo.updateDraftFilter({ id: 'hp5', strength: 0.6 })
    expect((await repo.getDraft())?.filter).toEqual({ id: 'hp5', strength: 0.6 })
  })

  it('does not duplicate identical files', async () => {
    const { db, repo } = freshRepo()
    const draft = await makeDraft('same')
    await repo.createEntry(draft)
    await repo.createEntry(draft)
    expect(await db.entries.count()).toBe(2)
    expect(await db.blobs.count()).toBe(2)
  })

  it('rolls back the whole transaction on failure', async () => {
    const { db, repo } = freshRepo()
    const draft = await makeDraft('x')
    const first = await repo.createEntry(draft)
    // Same id twice violates the primary key: nothing from the second attempt may remain.
    const other = await makeDraft('y')
    const original = crypto.randomUUID
    crypto.randomUUID = () => first.id as ReturnType<typeof crypto.randomUUID>
    try {
      await expect(repo.createEntry(other)).rejects.toThrow()
    } finally {
      crypto.randomUUID = original
    }
    expect(await db.entries.count()).toBe(1)
    expect(await db.blobs.get(other.photoHash)).toBeUndefined()
  })

  it('soft-deletes, restores and purges', async () => {
    const { db, repo } = freshRepo()
    const draft = await makeDraft('d')
    const e = await repo.createEntry(draft)

    await repo.softDelete(e.id)
    expect(await repo.getDay(e.dayKey)).toHaveLength(0)
    expect(await repo.listTrash()).toHaveLength(1)
    const deleted = await repo.getEntry(e.id)
    expect(deleted!.updatedAt >= e.updatedAt).toBe(true)

    await repo.restore(e.id)
    expect(await repo.getDay(e.dayKey)).toHaveLength(1)

    await repo.softDelete(e.id)
    await repo.purge(e.id)
    const tomb = await repo.getEntry(e.id)
    expect(tomb!.purgedAt).not.toBeNull()
    expect(await db.blobs.count()).toBe(0)
    expect(await repo.listTrash()).toHaveLength(0)
  })

  it('keeps files still referenced by another entry on purge', async () => {
    const { db, repo } = freshRepo()
    const draft = await makeDraft('shared')
    const a = await repo.createEntry(draft)
    await repo.createEntry(draft)
    await repo.softDelete(a.id)
    await repo.purge(a.id)
    expect(await db.blobs.count()).toBe(2)
  })

  it('lists days newest first with paging', async () => {
    const { repo } = freshRepo()
    for (const day of ['01', '02', '03', '04']) {
      await repo.createEntry(await makeDraft(day, { takenAt: `2026-10-${day}T12:00:00.000Z`, tzOffsetMin: 0 }))
    }
    const first = await repo.listDays(null, 2)
    expect(first.map((d) => d.dayKey)).toEqual(['2026-10-04', '2026-10-03'])
    const next = await repo.listDays('2026-10-03', 2)
    expect(next.map((d) => d.dayKey)).toEqual(['2026-10-02', '2026-10-01'])
  })

  it('skips days that only have deleted entries', async () => {
    const { repo } = freshRepo()
    const e = await repo.createEntry(await makeDraft('z', { takenAt: '2026-10-05T12:00:00.000Z', tzOffsetMin: 0 }))
    await repo.createEntry(await makeDraft('w', { takenAt: '2026-10-04T12:00:00.000Z', tzOffsetMin: 0 }))
    await repo.softDelete(e.id)
    expect((await repo.listDays(null, 14)).map((d) => d.dayKey)).toEqual(['2026-10-04'])
  })

  it('lists live entries in a day range grouped by day', async () => {
    const { repo } = freshRepo()
    for (const day of ['09-30', '10-01', '10-15', '10-31', '11-01']) {
      await repo.createEntry(await makeDraft(day, { takenAt: `2026-${day}T12:00:00.000Z`, tzOffsetMin: 0 }))
    }
    const gone = await repo.createEntry(await makeDraft('gone', { takenAt: '2026-10-20T12:00:00.000Z', tzOffsetMin: 0 }))
    await repo.softDelete(gone.id)
    const days = await repo.listDayRange('2026-10-01', '2026-10-31')
    expect(days.map((d) => d.dayKey)).toEqual(['2026-10-01', '2026-10-15', '2026-10-31'])
  })

  it('clamps comments to 5000 characters', async () => {
    const { repo } = freshRepo()
    const e = await repo.createEntry(await makeDraft('c'))
    await repo.updateComment(e.id, 'x'.repeat(6000))
    expect((await repo.getEntry(e.id))!.comment).toHaveLength(5000)
  })
})

describe('repository.onServerStatus', () => {
  it('fires on server confirmations but not on local edits', async () => {
    const { repo } = freshRepo()
    let status = 0
    let changes = 0
    repo.onServerStatus(() => status++)
    repo.onChange(() => changes++)
    const entry = await repo.createEntry(await makeDraft('s'))
    expect([status, changes]).toEqual([0, 1])

    await repo.markSynced([{ id: entry.id, updatedAt: entry.updatedAt, seq: 1, status: 'partial' }])
    await repo.setServerStatus(entry.id, 2, 'complete')
    expect([status, changes]).toEqual([2, 1])
    expect((await repo.getEntry(entry.id))?.serverStatus).toBe('complete')
  })
})

describe('repository.createEntry with a Vue draft', () => {
  it('stores an entry whose draft came from a deep ref', async () => {
    const { repo } = freshRepo()
    // Views keep the draft in a ref: nested objects such as location become reactive proxies.
    const draft = ref(await makeDraft('geo', { location: { lat: 43.25, lon: 76.95, accuracy: 12 } }))
    const entry = await repo.createEntry({ ...draft.value, comment: 'x' })
    expect((await repo.getEntry(entry.id))?.location).toEqual({ lat: 43.25, lon: 76.95, accuracy: 12 })
  })
})
