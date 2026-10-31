import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { repository } from '@/storage/repository'
import type { Entry, ServerSettings } from '@/storage/types'
import { createServerClient, normalizeServerUrl, normalizeToken, ServerError, type HealthInfo } from '@/sync/client'
import { offloadOldOriginals } from '@/sync/offloader'
import { syncAll, type SyncProgress, type SyncResult } from '@/sync/syncer'

const AUTO_SYNC_DELAY_MS = 3000
/** Old originals are checked for removal at most this often. */
const OFFLOAD_INTERVAL_MS = 60 * 60 * 1000
/** Originals downloaded for viewing, kept in memory only, so swiping back does not download again. */
const REMOTE_CACHE_LIMIT = 5
const DEFAULT_SETTINGS: ServerSettings = { url: '', token: '', autoUpload: true, keepOriginalsDays: null }

/** Sync state for the UI. Settings themselves live in IndexedDB (meta.server). */
export const useSyncStore = defineStore('sync', () => {
  const settings = ref<ServerSettings>({ ...DEFAULT_SETTINGS })
  const running = ref(false)
  const progress = ref<SyncProgress | null>(null)
  const lastResult = ref<SyncResult | null>(null)
  const lastError = ref<string | null>(null)
  const pendingCount = ref(0)
  const lastUploadAt = ref<string | null>(null)
  let started: Promise<void> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let offloading = false
  let lastOffloadAt = 0
  const remoteCache = new Map<string, Blob>()

  const configured = computed(() => settings.value.url !== '' && settings.value.token !== '')

  async function refreshCounters() {
    pendingCount.value = await repository.countPending()
    lastUploadAt.value = (await repository.getMeta<string>('lastUploadAt')) ?? null
  }

  /** Loads settings and wires automatic uploads. Safe to call more than once; every caller waits for the load. */
  function init(): Promise<void> {
    started ??= start()
    return started
  }

  async function start() {
    const stored = await repository.getMeta<ServerSettings>('server')
    if (stored) settings.value = { ...DEFAULT_SETTINGS, ...stored }
    await refreshCounters()
    repository.onChange(() => {
      refreshCounters().catch(() => undefined)
      scheduleAuto()
    })
    window.addEventListener('online', () => scheduleAuto(0))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleAuto(0)
    })
    scheduleAuto(0)
  }

  async function saveSettings(next: ServerSettings) {
    // An empty address turns uploading off; otherwise both address and token are required.
    const off = next.url.trim() === ''
    const clean: ServerSettings = {
      url: off ? '' : normalizeServerUrl(next.url),
      token: off ? next.token.trim() : normalizeToken(next.token),
      autoUpload: next.autoUpload,
      keepOriginalsDays: next.keepOriginalsDays ?? null,
    }
    const targetChanged = clean.url !== settings.value.url || clean.token !== settings.value.token
    await repository.setMeta('server', clean)
    settings.value = clean
    // Another server or account: send everything there and read its whole feed.
    if (!off && targetChanged) {
      remoteCache.clear()
      await repository.resetSync()
    }
    lastOffloadAt = 0
    scheduleAuto(0)
  }

  async function testConnection(candidate: Pick<ServerSettings, 'url' | 'token'>): Promise<HealthInfo> {
    return createServerClient(candidate).checkConnection()
  }

  /** Pulls changes, pushes pending entries and missing files. Returns null when nothing ran (already running or not configured). */
  async function syncNow(): Promise<SyncResult | null> {
    if (running.value || !configured.value) return null
    running.value = true
    lastError.value = null
    progress.value = null
    try {
      const client = createServerClient(settings.value)
      const result = await syncAll(repository, client, (p) => (progress.value = p))
      lastResult.value = result
      offload().catch(() => undefined)
      return result
    } catch (e) {
      lastError.value = e instanceof ServerError ? e.message : 'Синхронизация прервана'
      if (!(e instanceof ServerError)) console.error(e)
      throw e
    } finally {
      running.value = false
      progress.value = null
      await refreshCounters()
    }
  }

  /** Removes old originals the server already has. Silent: a failed run is retried next time. */
  async function offload(): Promise<number> {
    const keepDays = settings.value.keepOriginalsDays
    if (offloading || !configured.value || !keepDays) return 0
    if (Date.now() - lastOffloadAt < OFFLOAD_INTERVAL_MS) return 0
    offloading = true
    try {
      const removed = await offloadOldOriginals(repository, createServerClient(settings.value), { keepDays })
      lastOffloadAt = Date.now()
      return removed
    } catch (e) {
      if (!(e instanceof ServerError)) console.error(e)
      return 0
    } finally {
      offloading = false
    }
  }

  /** Downloads an original that is kept only on the server. */
  async function fetchOriginal(entry: Pick<Entry, 'id' | 'photoHash'>): Promise<Blob> {
    const hash = entry.photoHash
    const hit = remoteCache.get(hash)
    if (hit) {
      remoteCache.delete(hash)
      remoteCache.set(hash, hit)
      return hit
    }
    if (!configured.value) throw new ServerError('protocol', 'Сервер не настроен')
    const blob = await createServerClient(settings.value).getFile(entry.id, 'original', hash)
    remoteCache.set(hash, blob)
    for (const key of remoteCache.keys()) {
      if (remoteCache.size <= REMOTE_CACHE_LIMIT) break
      remoteCache.delete(key)
    }
    return blob
  }

  function scheduleAuto(delay = AUTO_SYNC_DELAY_MS) {
    clearTimeout(autoTimer)
    if (!configured.value || !settings.value.autoUpload) return
    autoTimer = setTimeout(() => {
      if (!navigator.onLine || document.visibilityState === 'hidden') return
      // A change made during a run waits for that run to finish.
      if (running.value) return scheduleAuto()
      // Errors are shown in settings via lastError; automatic runs stay silent.
      syncNow().catch(() => undefined)
    }, delay)
  }

  async function resyncAll() {
    await repository.resetSync()
  }

  return {
    settings,
    running,
    progress,
    lastResult,
    lastError,
    pendingCount,
    lastUploadAt,
    configured,
    init,
    saveSettings,
    testConnection,
    syncNow,
    offload,
    fetchOriginal,
    resyncAll,
  }
})
