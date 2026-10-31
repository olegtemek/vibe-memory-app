import { sha256Hex } from '@/image/process'
import type { BlobKind, Entry, ServerEntry, ServerSettings, ServerStatus } from '@/storage/types'

/**
 * HTTP client for the home server. The contract is described in pwa-mobile-client/SERVER_API.md.
 * All paths are relative to the configured base URL.
 */
export const API_PREFIX = '/api/v1'
const REQUEST_TIMEOUT_MS = 30_000
const BLOB_TIMEOUT_MS = 120_000
export const PAGE_SIZE = 100

/** Server status of an entry; `purged` marks a final deletion. */
export type EntryStatus = ServerStatus | 'purged'

export interface PushResult {
  id: string
  seq: number
  status: EntryStatus
  missing: BlobKind[]
}

export interface PartialItem {
  id: string
  seq: number
  missing: BlobKind[]
}

export interface FileResult {
  seq: number
  status: EntryStatus
  missing: BlobKind[]
}

export interface ChangeItem {
  seq: number
  status: EntryStatus
  missing: BlobKind[]
  entry: ServerEntry
}

export interface Page<T> {
  items: T[]
  hasMore: boolean
}

/** Drops the fields that exist only on this device. */
export function toServerEntry(e: Entry): ServerEntry {
  const { syncStatus: _s, offloaded: _o, mediumHash: _m, seq: _q, serverStatus: _t, ...rest } = e
  return { ...rest, location: rest.location ?? null }
}

export type ServerErrorKind = 'network' | 'auth' | 'server' | 'protocol'

export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

export interface HealthInfo {
  ok: boolean
  name?: string
  version?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Trims spaces and trailing slashes; throws on anything that is not http(s). */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ServerError('protocol', 'Некорректный адрес сервера')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ServerError('protocol', 'Адрес должен начинаться с https:// или http://')
  return trimmed
}

/** Trims the token; throws when it is empty or not a valid header value. */
export function normalizeToken(raw: string): string {
  const token = raw.trim()
  if (!token) throw new ServerError('auth', 'Укажите токен доступа')
  // RFC 6750 b64token characters; also keeps the header free of spaces and line breaks.
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new ServerError('auth', 'Токен содержит недопустимые символы')
  return token
}

/** An https page cannot call an http server (mixed content), except localhost in some browsers. */
export function isMixedContent(serverUrl: string, pageProtocol = globalThis.location?.protocol): boolean {
  try {
    const url = new URL(serverUrl)
    return pageProtocol === 'https:' && url.protocol === 'http:' && url.hostname !== 'localhost'
  } catch {
    return false
  }
}

export function createServerClient(settings: Pick<ServerSettings, 'url' | 'token'>, fetchImpl: FetchLike = fetch) {
  const base = normalizeServerUrl(settings.url) + API_PREFIX
  const authorization = `Bearer ${normalizeToken(settings.token)}`

  async function request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', authorization)
    let res: Response
    try {
      res = await fetchImpl(base + path, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      const name = (e as Error)?.name
      const message =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'Сервер не ответил вовремя'
          : 'Сервер недоступен. Проверьте адрес, сеть и HTTPS-сертификат.'
      throw new ServerError('network', message)
    }
    if (res.status === 401 || res.status === 403)
      throw new ServerError('auth', 'Сервер отклонил токен доступа', res.status)
    if (!res.ok) throw new ServerError('server', `Ошибка сервера: HTTP ${res.status}`, res.status)
    return res
  }

  async function json<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T
    } catch {
      throw new ServerError('protocol', 'Сервер вернул некорректный ответ')
    }
  }

  async function page<T>(res: Response): Promise<Page<T>> {
    const data = await json<{ items?: unknown; hasMore?: unknown }>(res)
    if (!Array.isArray(data.items) || typeof data.hasMore !== 'boolean')
      throw new ServerError('protocol', 'Сервер вернул некорректный ответ')
    return { items: data.items as T[], hasMore: data.hasMore }
  }

  const postJson = (path: string, body: unknown) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  return {
    async health(): Promise<HealthInfo> {
      const data = await json<HealthInfo>(await request('/health'))
      if (!data || data.ok !== true) throw new ServerError('protocol', 'Сервер ответил, но это не vibe-memory')
      return data
    },

    /** Highest sequence number among this account's entries; 0 for an empty account. */
    async state(): Promise<{ lastSeq: number }> {
      const data = await json<{ lastSeq?: unknown }>(await request('/gallery/state'))
      if (typeof data.lastSeq !== 'number') throw new ServerError('protocol', 'Сервер вернул некорректный ответ')
      return { lastSeq: data.lastSeq }
    },

    /** Sends entry versions. Ids missing from the result were rejected and stay pending. */
    async pushEntries(entries: Entry[]): Promise<PushResult[]> {
      const data = await json<{ results?: unknown }>(
        await postJson('/gallery', { entries: entries.map(toServerEntry) }),
      )
      if (!Array.isArray(data.results)) throw new ServerError('protocol', 'Сервер вернул некорректный ответ')
      return data.results as PushResult[]
    },

    /** Entries the server still lacks files for, ordered by seq, starting after `afterSeq`. */
    async listPartial(afterSeq: number, limit = PAGE_SIZE): Promise<Page<PartialItem>> {
      return page<PartialItem>(await request(`/gallery/partial?after=${afterSeq}&limit=${limit}`))
    },

    /** Uploads one file of an entry; the server checks it against the entry's hash. */
    async putFile(id: string, kind: BlobKind, blob: Blob): Promise<FileResult> {
      const res = await request(
        `/gallery/${id}/${kind}`,
        { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob },
        BLOB_TIMEOUT_MS,
      )
      return json<FileResult>(res)
    },

    /** True when the server has the file. A 404 is an answer here, not an error. */
    async hasFile(id: string, kind: BlobKind): Promise<boolean> {
      try {
        await request(`/gallery/${id}/${kind}`, { method: 'HEAD' })
        return true
      } catch (e) {
        if (e instanceof ServerError && e.status === 404) return false
        throw e
      }
    },

    /** Downloads one file of an entry and checks it against the expected hash. */
    async getFile(id: string, kind: BlobKind, expectedHash: string): Promise<Blob> {
      const res = await request(`/gallery/${id}/${kind}`, {}, BLOB_TIMEOUT_MS)
      const blob = await res.blob()
      if ((await sha256Hex(blob)) !== expectedHash) throw new ServerError('protocol', 'Сервер вернул повреждённый файл')
      return blob.type ? blob : new Blob([blob], { type: 'image/jpeg' })
    },

    /** Entry versions changed after `afterSeq`, oldest first. */
    async changes(afterSeq: number, limit = PAGE_SIZE): Promise<Page<ChangeItem>> {
      return page<ChangeItem>(await request(`/gallery/changes?after=${afterSeq}&limit=${limit}`))
    },
  }
}

export type ServerClient = ReturnType<typeof createServerClient>
