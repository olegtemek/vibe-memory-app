import { computed, ref } from 'vue'
import { useRegisterSW } from 'virtual:pwa-register/vue'

let instance: ReturnType<typeof create> | null = null

function create() {
  // registerType: 'prompt' — the new worker waits until the user taps "Обновить".
  const { needRefresh, updateServiceWorker } = useRegisterSW({ immediate: true })
  const standalone = ref(
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  )
  return {
    needRefresh,
    applyUpdate: () => updateServiceWorker(true),
    dismissUpdate: () => (needRefresh.value = false),
    isStandalone: computed(() => standalone.value),
  }
}

export function usePwa() {
  instance ??= create()
  return instance
}
