import { describe, expect, it } from 'vitest'
import { createServerClient, isMixedContent, normalizeServerUrl, ServerError, type FetchLike } from '@/sync/client'
import { offloadOldOriginals } from '@/sync/offloader'
import { syncAll } from '@/sync/syncer'
import { sha256Hex } from '@/image/process'
import type { BlobKind, ServerEntry } from '@/storage/types'
import { freshRepo, makeDraft } from './helpers'

/** In-memory implementation of the server contract from SERVER_API.md, for one account. */
const TOKEN = 'test-token'

interface Row {
  entry: ServerEntry
  seq: number
  files: Set<BlobKind>
}

function fakeServer(opts: { token?: string; rejectIds?: Set<string>; failFiles?: boolean } = {}) {
  const token = opts.token ?? TOKEN
  const rows = new Map<string, Row>()
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []
  let lastSeq = 0

  const status = (r: Row) =>
    r.entry.purgedAt !== null ? 'purged' : r.files.size === 2 ? 'complete' : 'partial'
  const missing = (r: Row): BlobKind[] =>
    r.entry.purgedAt !== null ? [] : (['original', 'thumb'] as const).filter((k) => !r.files.has(k))
  const hashOf = (r: Row, kind: BlobKind) => (kind === 'original' ? r.entry.photoHash : r.entry.thumbHash)
  const sorted = (after: number) => [...rows.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq)

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    const json = (data: unknown) => Response.json(data)
    // Open on the real server too.
    if (url.pathname === '/health') return json({ ok: true, name: 'test' })
    const auth = new Headers(init.headers).get('Authorization')
    if (auth !== `Bearer ${token}`) return new Response('no', { status: 401 })
    const after = Number(url.searchParams.get('after') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const path = url.pathname

    if (path === '/gallery/state') return json({ lastSeq })
    if (path === '/gallery' && method === 'POST') {
      const body = JSON.parse(init.body as string) as { entries: ServerEntry[] }
      const results = []
      for (const e of body.entries) {
        if (opts.rejectIds?.has(e.id)) continue
        let row = rows.get(e.id)
        if (row && (row.entry.photoHash !== e.photoHash || row.entry.thumbHash !== e.thumbHash)) continue
        // A purged row is final; otherwise last write wins.
        if (!row || (row.entry.purgedAt === null && row.entry.updatedAt < e.updatedAt)) {
          row = { entry: e, seq: ++lastSeq, files: row?.files ?? new Set() }
          if (e.purgedAt !== null) row.files.clear()
          rows.set(e.id, row)
        }
        results.push({ id: e.id, seq: row.seq, status: status(row), missing: missing(row) })
      }
      return json({ results })
    }
    if (path === '/gallery/partial') {
      const items = sorted(after).filter((r) => status(r) === 'partial')
      return json({
        items: items.slice(0, limit).map((r) => ({ id: r.entry.id, seq: r.seq, missing: missing(r) })),
        hasMore: items.length > limit,
      })
    }
    if (path === '/gallery/changes') {
      const items = sorted(after)
      return json({
        items: items.slice(0, limit).map((r) => ({ seq: r.seq, status: status(r), missing: missing(r), entry: r.entry })),
        hasMore: items.length > limit,
      })
    }
    const fileMatch = /^\/gallery\/([0-9a-f-]{36})\/(original|thumb)$/.exec(path)
    if (fileMatch) {
      const row = rows.get(fileMatch[1]!)
      const kind = fileMatch[2] as BlobKind
      if (!row || row.entry.purgedAt !== null) return new Response('no', { status: 404 })
      const hash = hashOf(row, kind)
      if (method === 'PUT') {
        if (opts.failFiles) return new Response('boom', { status: 500 })
        const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer())
        if ((await sha256Hex(bytes)) !== hash) return new Response('hash', { status: 422 })
        if (!row.files.has(kind)) {
          files.set(hash, bytes)
          row.files.add(kind)
          row.seq = ++lastSeq
        }
        return json({ seq: row.seq, status: status(row), missing: missing(row) })
      }
      if (!row.files.has(kind) || !files.has(hash)) return new Response('no', { status: 404 })
      if (method === 'HEAD') return new Response(null, { status: 200 })
      return new Response(new Blob([files.get(hash)! as BlobPart], { type: 'image/jpeg' }))
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, rows, files, calls, client: () => createServerClient({ url: 'https://h', token }, fetchImpl) }
}

describe('server url', () => {
  it('normalizes and validates', () => {
    expect(normalizeServerUrl(' https://home.lan:8443/ ')).toBe('https://home.lan:8443')
    expect(() => normalizeServerUrl('ftp://x')).toThrow(ServerError)
    expect(() => normalizeServerUrl('not a url')).toThrow(ServerError)
  })
  it('detects mixed content', () => {
    expect(isMixedContent('http://192.168.1.5', 'https:')).toBe(true)
    expect(isMixedContent('https://192.168.1.5', 'https:')).toBe(false)
    expect(isMixedContent('http://192.168.1.5', 'http:')).toBe(false)
  })
})

describe('server client', () => {
  it('requires a token', () => {
    expect(() => createServerClient({ url: 'https://h', token: '  ' })).toThrow('Укажите токен')
    expect(() => createServerClient({ url: 'https://h', token: 'a b' })).toThrow('недопустимые')
  })

  it('sends the token and maps 401 to an auth error', async () => {
    const server = fakeServer({ token: 'secret' })
    const good = createServerClient({ url: 'https://h', token: 'secret' }, server.fetchImpl)
    const bad = createServerClient({ url: 'https://h', token: 'wrong' }, server.fetchImpl)
    await expect(good.checkConnection()).resolves.toMatchObject({ ok: true })
    // /health is open, so only the second request of the check catches a wrong token.
    await expect(bad.health()).resolves.toMatchObject({ ok: true })
    await expect(bad.checkConnection()).rejects.toMatchObject({ kind: 'auth' })
  })
  it('maps fetch failures to network errors', async () => {
    const client = createServerClient({ url: 'https://h', token: TOKEN }, async () => {
      throw new TypeError('Load failed')
    })
    await expect(client.health()).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('syncAll: push', () => {
  it('sends metadata, then files, and records the server status', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a', { comment: 'hi', location: { lat: 55.75, lon: 37.62, accuracy: 12 } }))
    await repo.createEntry(await makeDraft('b'))
    const server = fakeServer()

    const result = await syncAll(repo, server.client())
    expect(result).toEqual({ pulled: 0, pushed: 2, files: 4, failed: 0, errors: [] })
    expect(server.files.size).toBe(4)
    const row = server.rows.get(a.id)!
    expect(row.entry.comment).toBe('hi')
    expect(row.entry.location).toEqual({ lat: 55.75, lon: 37.62, accuracy: 12 })
    expect(row.entry).not.toHaveProperty('syncStatus')
    expect(row.entry).not.toHaveProperty('seq')
    const stored = (await repo.getEntry(a.id))!
    expect(stored).toMatchObject({ syncStatus: 'synced', serverStatus: 'complete', seq: row.seq })
    expect(await repo.countPending()).toBe(0)
    expect(await repo.getMeta('lastUploadAt')).toBeTypeOf('string')

    // Nothing to send: only the feed and the partial list are read.
    server.calls.length = 0
    expect(await syncAll(repo, server.client())).toEqual({ pulled: 0, pushed: 0, files: 0, failed: 0, errors: [] })
    expect(server.calls).toEqual(['GET /gallery/changes', 'GET /gallery/partial'])
  })

  it('re-sends only the changed entry and no files', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a'))
    await repo.createEntry(await makeDraft('b'))
    const server = fakeServer()
    await syncAll(repo, server.client())

    await new Promise((r) => setTimeout(r, 5))
    await repo.updateComment(a.id, 'изменено')
    server.calls.length = 0
    const result = await syncAll(repo, server.client())
    expect(result.pushed).toBe(1)
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toEqual([])
    expect(server.rows.get(a.id)?.entry.comment).toBe('изменено')
  })

  it('sends purged entries as tombstones without files', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a'))
    await repo.softDelete(a.id)
    await repo.purge(a.id)
    const server = fakeServer()
    const result = await syncAll(repo, server.client())
    expect(result).toMatchObject({ pushed: 1, files: 0 })
    expect(server.files.size).toBe(0)
    expect(server.rows.get(a.id)?.entry.purgedAt).not.toBeNull()
  })

  it('keeps entries the server rejected pending', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a'))
    await repo.createEntry(await makeDraft('b'))
    const server = fakeServer({ rejectIds: new Set([a.id]) })
    const result = await syncAll(repo, server.client())
    expect(result).toMatchObject({ pushed: 1, failed: 1 })
    expect((await repo.getEntry(a.id))!.syncStatus).toBe('pending')
  })

  it('keeps an entry pending when it was edited during the push', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a'))
    const server = fakeServer()
    const editing: FetchLike = async (input, init) => {
      if (input.endsWith('/gallery') && init?.method === 'POST') {
        await new Promise((r) => setTimeout(r, 5))
        await repo.updateComment(a.id, 'новый текст во время выгрузки')
      }
      return server.fetchImpl(input, init)
    }
    await syncAll(repo, createServerClient({ url: 'https://h', token: TOKEN }, editing))
    expect((await repo.getEntry(a.id))!.syncStatus).toBe('pending')
  })

  it('leaves the entry partial when a file upload fails, and finishes it next time', async () => {
    const { repo } = freshRepo()
    const a = await repo.createEntry(await makeDraft('a'))
    const opts = { failFiles: true }
    const server = fakeServer(opts)
    await expect(syncAll(repo, server.client())).rejects.toMatchObject({ kind: 'server', status: 500 })
    expect((await repo.getEntry(a.id))!.serverStatus).toBe('partial')
    expect(server.rows.get(a.id)?.files.size).toBe(0)

    opts.failFiles = false
    expect((await syncAll(repo, server.client())).files).toBe(2)
    expect((await repo.getEntry(a.id))!.serverStatus).toBe('complete')
  })
})

describe('syncAll: pull', () => {
  async function twoDevices() {
    const server = fakeServer()
    const phone = freshRepo().repo
    const restored = freshRepo().repo
    return { server, phone, restored }
  }

  it('restores entries and thumbnails on a fresh device', async () => {
    const { server, phone, restored } = await twoDevices()
    const a = await phone.createEntry(await makeDraft('a', { comment: 'привет', location: { lat: 1, lon: 2, accuracy: 3 } }))
    await syncAll(phone, server.client())

    const result = await syncAll(restored, server.client())
    expect(result).toMatchObject({ pulled: 1, pushed: 0, files: 0, failed: 0 })
    const got = (await restored.getEntry(a.id))!
    expect(got).toMatchObject({ comment: 'привет', location: { lat: 1, lon: 2, accuracy: 3 }, syncStatus: 'synced' })
    expect(got).toMatchObject({ offloaded: true, serverStatus: 'complete' })
    expect(await (await restored.getBlob(a.thumbHash))!.text()).toBe('thumb-a')
    expect(await restored.getBlob(a.photoHash)).toBeUndefined()
    expect(await restored.getMeta('lastSeq')).toBe(server.rows.get(a.id)!.seq)
    // The original comes on demand.
    expect(await (await server.client().getFile(a.id, 'original', a.photoHash)).text()).toBe('original-a')
  })

  it('applies edits and deletions from another device', async () => {
    const { server, phone, restored } = await twoDevices()
    const a = await phone.createEntry(await makeDraft('a'))
    const b = await phone.createEntry(await makeDraft('b'))
    await syncAll(phone, server.client())
    await syncAll(restored, server.client())

    await new Promise((r) => setTimeout(r, 5))
    await restored.updateComment(a.id, 'с другого устройства')
    await restored.softDelete(b.id)
    await restored.purge(b.id)
    await syncAll(restored, server.client())

    const result = await syncAll(phone, server.client())
    expect(result.pulled).toBe(2)
    expect((await phone.getEntry(a.id))!.comment).toBe('с другого устройства')
    expect((await phone.getEntry(b.id))!.purgedAt).not.toBeNull()
    expect(await phone.getBlob(b.photoHash)).toBeUndefined()
    expect(await phone.getBlob(b.thumbHash)).toBeUndefined()
    // The phone still has its own original of a.
    expect(await phone.getBlob(a.photoHash)).toBeDefined()
  })

  it('keeps a newer local edit that is not sent yet, then sends it', async () => {
    const { server, phone, restored } = await twoDevices()
    const a = await phone.createEntry(await makeDraft('a'))
    await syncAll(phone, server.client())
    await syncAll(restored, server.client())

    await new Promise((r) => setTimeout(r, 5))
    await restored.updateComment(a.id, 'старая правка')
    await syncAll(restored, server.client())
    await new Promise((r) => setTimeout(r, 5))
    await phone.updateComment(a.id, 'новая правка')

    await syncAll(phone, server.client())
    expect((await phone.getEntry(a.id))!.comment).toBe('новая правка')
    expect(server.rows.get(a.id)!.entry.comment).toBe('новая правка')
  })

  it('does not upload files of entries made on another device', async () => {
    const opts = { failFiles: true }
    const server = fakeServer(opts)
    const { phone, restored } = await twoDevices()
    const a = await phone.createEntry(await makeDraft('a'))
    // Metadata reaches the server, files do not.
    await expect(syncAll(phone, server.client())).rejects.toMatchObject({ status: 500 })
    opts.failFiles = false

    const result = await syncAll(restored, server.client())
    expect(result).toMatchObject({ pulled: 1, files: 0, failed: 0 })
    expect((await restored.getEntry(a.id))!.serverStatus).toBe('partial')
    expect(await restored.getBlob(a.thumbHash)).toBeUndefined()

    // The phone finishes its files; the other device then gets the thumbnail.
    expect((await syncAll(phone, server.client())).files).toBe(2)
    await syncAll(restored, server.client())
    expect((await restored.getEntry(a.id))!.serverStatus).toBe('complete')
    expect(await restored.getBlob(a.thumbHash)).toBeDefined()
  })
})

describe('offloadOldOriginals', () => {
  const NOW = new Date('2027-03-01T12:00:00.000Z')
  const OLD = '2026-10-29T10:00:00.000Z'
  const RECENT = '2027-02-20T10:00:00.000Z'
  const fakeMedium = async (original: Blob) => {
    const blob = new Blob([`medium-${await original.text()}`], { type: 'image/jpeg' })
    return { hash: await sha256Hex(blob), blob }
  }

  async function setup() {
    const { repo } = freshRepo()
    const server = fakeServer()
    const client = server.client()
    const old = await repo.createEntry(await makeDraft('old', { takenAt: OLD }))
    const recent = await repo.createEntry(await makeDraft('recent', { takenAt: RECENT }))
    await syncAll(repo, client)
    return { repo, server, client, old, recent }
  }

  it('replaces old complete originals with a medium copy', async () => {
    const { repo, client, old, recent } = await setup()
    const removed = await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })
    expect(removed).toBe(1)

    const stored = (await repo.getEntry(old.id))!
    expect(stored.offloaded).toBe(true)
    expect(stored.updatedAt).toBe(old.updatedAt)
    expect(stored.syncStatus).toBe('synced')
    expect(await repo.getBlob(old.photoHash)).toBeUndefined()
    expect(await repo.getBlob(old.thumbHash)).toBeDefined()
    expect(await (await repo.getBlob(stored.mediumHash!))!.text()).toBe('medium-original-old')

    expect((await repo.getEntry(recent.id))!.offloaded).toBeUndefined()
    expect(await repo.getBlob(recent.photoHash)).toBeDefined()
    expect(await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })).toBe(0)
  })

  it('keeps originals the server does not have or did not confirm', async () => {
    const { repo, server, client, old } = await setup()
    server.rows.get(old.id)!.files.delete('original')
    const unsent = await repo.createEntry(await makeDraft('unsent', { takenAt: OLD }))
    expect(await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })).toBe(0)
    expect(await repo.getBlob(old.photoHash)).toBeDefined()
    expect(await repo.getBlob(unsent.photoHash)).toBeDefined()
  })

  it('downloads the original back and keeps local fields off the server', async () => {
    const { repo, server, client, old } = await setup()
    await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })
    expect(await (await client.getFile(old.id, 'original', old.photoHash)).text()).toBe('original-old')

    await new Promise((r) => setTimeout(r, 5))
    await repo.updateComment(old.id, 'после выгрузки оригинала')
    expect(await syncAll(repo, client)).toMatchObject({ pushed: 1, failed: 0 })
    const sent = server.rows.get(old.id)!.entry
    expect(sent.comment).toBe('после выгрузки оригинала')
    expect(sent).not.toHaveProperty('offloaded')
    expect(sent).not.toHaveProperty('mediumHash')
    // The pulled-back version keeps the local offload state.
    expect((await repo.getEntry(old.id))!.offloaded).toBe(true)
  })

  it('rejects a downloaded file with a wrong hash', async () => {
    const { client, server, old } = await setup()
    server.files.set(old.photoHash, new TextEncoder().encode('broken'))
    await expect(client.getFile(old.id, 'original', old.photoHash)).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('reports offloaded originals a new server lacks', async () => {
    const { repo, client, old } = await setup()
    await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })
    await repo.resetSync()
    const result = await syncAll(repo, fakeServer().client())
    expect(result).toMatchObject({ pushed: 2, files: 3, failed: 1 })
    expect(result.errors[0]).toContain(old.id)
    expect(result.errors[0]).toContain('ни на этом сервере')
  })

  it('purge removes the medium copy', async () => {
    const { repo, client, old } = await setup()
    await offloadOldOriginals(repo, client, { keepDays: 90, now: NOW, makeMedium: fakeMedium })
    const mediumHash = (await repo.getEntry(old.id))!.mediumHash!
    await repo.softDelete(old.id)
    await repo.purge(old.id)
    expect(await repo.getBlob(mediumHash)).toBeUndefined()
    expect(await repo.getBlob(old.thumbHash)).toBeUndefined()
  })
})
