import { onBeforeUnmount, onMounted } from 'vue'
import { repository } from '@/storage/repository'

/** Uploads confirm files one by one; reloading once per burst is enough. */
const REFRESH_DELAY_MS = 300

/** Calls `reload` while the component is mounted, whenever the server confirms entries or files. */
export function useServerStatusRefresh(reload: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let off: (() => void) | undefined
  onMounted(() => {
    off = repository.onServerStatus(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        reload()
      }, REFRESH_DELAY_MS)
    })
  })
  onBeforeUnmount(() => {
    off?.()
    clearTimeout(timer)
  })
}
