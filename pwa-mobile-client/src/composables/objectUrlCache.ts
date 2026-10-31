import { repository } from '@/storage/repository'

/** Max object URLs kept alive at once; unused ones are revoked oldest first. */
export const OBJECT_URL_CACHE_LIMIT = 300

interface CacheItem {
  url: string
  refs: number
}

// Map keeps insertion order; re-inserting on access makes it an LRU.
const cache = new Map<string, CacheItem>()
const pending = new Map<string, Promise<string | undefined>>()

function evict() {
  if (cache.size <= OBJECT_URL_CACHE_LIMIT) return
  for (const [hash, item] of cache) {
    if (cache.size <= OBJECT_URL_CACHE_LIMIT) break
    if (item.refs > 0) continue
    URL.revokeObjectURL(item.url)
    cache.delete(hash)
  }
}

/** Returns an object URL for a stored blob and holds a reference to it until release(). */
export async function acquireUrl(hash: string): Promise<string | undefined> {
  const hit = cache.get(hash)
  if (hit) {
    hit.refs++
    cache.delete(hash)
    cache.set(hash, hit)
    return hit.url
  }
  let p = pending.get(hash)
  if (!p) {
    p = repository.getBlob(hash).then((blob) => (blob ? URL.createObjectURL(blob) : undefined))
    pending.set(hash, p)
  }
  const url = await p
  pending.delete(hash)
  if (!url) return undefined
  const existing = cache.get(hash)
  if (existing) {
    if (existing.url !== url) URL.revokeObjectURL(url)
    existing.refs++
    return existing.url
  }
  cache.set(hash, { url, refs: 1 })
  evict()
  return url
}

export function releaseUrl(hash: string) {
  const item = cache.get(hash)
  if (!item) return
  item.refs = Math.max(0, item.refs - 1)
  evict()
}
