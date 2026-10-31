import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { planParts, periodBounds } from '@/export/plan'
import { buildPart, prepareExport } from '@/export/exporter'
import { sha256Hex } from '@/image/process'
import type { Entry } from '@/storage/types'
import { freshRepo, makeDraft } from './helpers'

const fakeEntry = (id: string, photoHash: string, thumbHash: string, purged = false): Entry => ({
  id,
  takenAt: '2026-10-29T10:00:00.000Z',
  tzOffsetMin: 0,
  dayKey: '2026-10-29',
  comment: '',
  photoHash,
  thumbHash,
  width: 1,
  height: 1,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  deleted: purged,
  purgedAt: purged ? '2026-10-29T11:00:00.000Z' : null,
  syncStatus: 'pending',
})

describe('planParts', () => {
  const sizes = new Map([
    ['p1', 60], ['t1', 5],
    ['p2', 60], ['t2', 5],
    ['p3', 200], ['t3', 5],
  ])

  it('keeps an entry with its files and respects the limit', () => {
    const parts = planParts(
      [fakeEntry('1', 'p1', 't1'), fakeEntry('2', 'p2', 't2'), fakeEntry('3', 'p3', 't3')],
      sizes,
      100,
    )
    expect(parts.map((p) => p.entries.map((e) => e.id))).toEqual([['1'], ['2'], ['3']])
    expect(parts[0]!.photoHashes).toEqual(['p1'])
    expect(parts[0]!.thumbHashes).toEqual(['t1'])
    expect(parts[2]!.bytes).toBe(205)
  })

  it('does not count shared files twice in one part', () => {
    const parts = planParts([fakeEntry('1', 'p1', 't1'), fakeEntry('2', 'p1', 't1')], sizes, 100)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.bytes).toBe(65)
    expect(parts[0]!.photoHashes).toEqual(['p1'])
  })

  it('exports purged entries without files', () => {
    const parts = planParts([fakeEntry('1', 'p1', 't1', true)], sizes, 100)
    expect(parts[0]!.bytes).toBe(0)
    expect(parts[0]!.photoHashes).toEqual([])
  })

  it('exports the medium copy of an offloaded original', () => {
    const entry = { ...fakeEntry('1', 'p9', 't1'), offloaded: true, mediumHash: 'm1' }
    const parts = planParts([entry], new Map([...sizes, ['m1', 20]]), 100)
    expect(parts[0]!.photoHashes).toEqual([])
    expect(parts[0]!.mediumHashes).toEqual(['m1'])
    expect(parts[0]!.bytes).toBe(25)
  })
})

describe('periodBounds', () => {
  it('builds inclusive dayKey bounds', () => {
    expect(periodBounds('year', { year: 2025 })).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(periodBounds('month', { month: '2026-02' })).toEqual({ from: '2026-02-01', to: '2026-02-31' })
    expect(periodBounds('all')).toEqual({ from: null, to: null })
  })
})

describe('export', () => {
  async function exportAll(repo: ReturnType<typeof freshRepo>['repo'], maxBytes?: number) {
    const prepared = await prepareExport(null, null, repo, maxBytes)
    const files: File[] = []
    for (let i = 0; i < prepared.parts.length; i++) files.push(await buildPart(prepared, i, repo))
    return files
  }

  it('writes manifest, entries and files with matching hashes', async () => {
    const src = freshRepo()
    const a = await src.repo.createEntry(await makeDraft('a', { comment: 'первое' }))
    const b = await src.repo.createEntry(await makeDraft('b'))
    await src.repo.softDelete(b.id)
    await src.repo.purge(b.id)

    const files = await exportAll(src.repo)
    expect(files).toHaveLength(1)
    const unzipped = unzipSync(new Uint8Array(await files[0]!.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']!))
    expect(manifest).toMatchObject({ format: 'photodiary-export', version: 1, part: 1, totalParts: 1, entryCount: 2 })
    expect(Object.keys(unzipped).sort()).toEqual(
      ['entries.json', 'manifest.json', `photos/${a.photoHash}.jpg`, `thumbs/${a.thumbHash}.jpg`].sort(),
    )
    expect(await sha256Hex(unzipped[`photos/${a.photoHash}.jpg`]!)).toBe(a.photoHash)

    const entries = JSON.parse(strFromU8(unzipped['entries.json']!)) as Entry[]
    expect(entries.find((e) => e.id === a.id)?.comment).toBe('первое')
    expect(entries.find((e) => e.id === b.id)?.purgedAt).not.toBeNull()
  })

  it('splits into parts', async () => {
    const src = freshRepo()
    await src.repo.createEntry(await makeDraft('a'))
    await src.repo.createEntry(await makeDraft('b'))
    const files = await exportAll(src.repo, 1)
    expect(files).toHaveLength(2)
    expect(files[0]!.name).toMatch(/part1of2\.zip$/)
  })

  it('exports only the selected period', async () => {
    const src = freshRepo()
    await src.repo.createEntry(await makeDraft('a', { takenAt: '2025-06-01T12:00:00.000Z', tzOffsetMin: 0 }))
    const b = await src.repo.createEntry(await makeDraft('b', { takenAt: '2026-06-01T12:00:00.000Z', tzOffsetMin: 0 }))
    const { from, to } = periodBounds('year', { year: 2026 })
    const prepared = await prepareExport(from, to, src.repo)
    expect(prepared.parts.flatMap((p) => p.entries.map((e) => e.id))).toEqual([b.id])
  })
})
