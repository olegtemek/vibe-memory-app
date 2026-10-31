import type { GeoPoint } from '@/storage/types'

/** A fix older than this is not attached to a new photo. */
const MAX_FIX_AGE_MS = 2 * 60 * 1000

let latest: { point: GeoPoint; at: number } | null = null
let watchId: number | null = null
const waiters = new Set<(p: GeoPoint) => void>()

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** Starts listening for the position. iOS asks for permission on the first call; a refusal is silent. */
export function startLocation(): void {
  if (watchId !== null || !navigator.geolocation) return
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      // ~1 m precision is plenty for a diary and keeps the stored numbers short.
      const point = {
        lat: round(pos.coords.latitude, 5),
        lon: round(pos.coords.longitude, 5),
        accuracy: Math.round(pos.coords.accuracy),
      }
      latest = { point, at: Date.now() }
      waiters.forEach((fn) => fn(point))
      waiters.clear()
    },
    () => undefined,
    { enableHighAccuracy: true, maximumAge: 60_000 },
  )
}

export function stopLocation(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId)
  watchId = null
}

/** The last fix if it is fresh enough, otherwise null. Never waits. */
export function currentLocation(): GeoPoint | null {
  return latest && Date.now() - latest.at < MAX_FIX_AGE_MS ? latest.point : null
}

/** Resolves with the next fix, or null after `timeoutMs`. */
export function nextLocation(timeoutMs: number): Promise<GeoPoint | null> {
  return new Promise((resolve) => {
    const done = (p: GeoPoint | null) => {
      clearTimeout(timer)
      waiters.delete(done)
      resolve(p)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    waiters.add(done)
  })
}
