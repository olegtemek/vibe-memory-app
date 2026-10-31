import { StorageFullError } from '@/storage/repository'
import { useUiStore } from '@/stores/ui'

/** Shows a readable message for a failed operation. */
export function reportError(e: unknown, fallback = 'Что-то пошло не так') {
  const ui = useUiStore()
  if (e instanceof StorageFullError) {
    ui.showToast('Место на устройстве закончилось. Сделайте экспорт и освободите место.', 'error', {
      label: 'Экспорт',
      to: '/settings',
    })
    return
  }
  console.error(e)
  ui.showToast(fallback, 'error')
}
