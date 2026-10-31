import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastKind = 'info' | 'error'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel: string
  /** Paints the confirm button red, for actions that cannot be undone. */
  danger?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

/** UI-only state. The source of truth for data is IndexedDB via the repository. */
export const useUiStore = defineStore('ui', () => {
  const toast = ref<{ text: string; kind: ToastKind; action?: { label: string; to: string } } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  function showToast(text: string, kind: ToastKind = 'info', action?: { label: string; to: string }) {
    toast.value = { text, kind, action }
    clearTimeout(timer)
    timer = setTimeout(() => (toast.value = null), action ? 8000 : 3500)
  }

  function hideToast() {
    toast.value = null
  }

  // In-app dialog instead of window.confirm: iOS home-screen apps may not show native dialogs.
  const confirmRequest = ref<ConfirmRequest | null>(null)

  function confirm(options: ConfirmOptions): Promise<boolean> {
    confirmRequest.value?.resolve(false)
    return new Promise((resolve) => (confirmRequest.value = { ...options, resolve }))
  }

  function answerConfirm(ok: boolean) {
    const request = confirmRequest.value
    confirmRequest.value = null
    request?.resolve(ok)
  }

  /** Set right before switching between the month and the months overview, to animate the zoom. */
  const calendarZoom = ref<{ dir: 'in' | 'out'; x: number; y: number } | null>(null)

  const facingMode = ref<'environment' | 'user'>('environment')
  const installBannerDismissed = ref(false)
  const draftPromptHandled = ref(false)

  return {
    toast,
    showToast,
    hideToast,
    confirmRequest,
    confirm,
    answerConfirm,
    calendarZoom,
    facingMode,
    installBannerDismissed,
    draftPromptHandled,
  }
})
