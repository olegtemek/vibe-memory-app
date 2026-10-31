import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '@/stores/ui'

describe('ui.confirm', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('resolves with the answer and closes the dialog', async () => {
    const ui = useUiStore()
    const pending = ui.confirm({ title: 'Удалить?', confirmLabel: 'Удалить', danger: true })
    expect(ui.confirmRequest?.title).toBe('Удалить?')
    ui.answerConfirm(true)
    expect(await pending).toBe(true)
    expect(ui.confirmRequest).toBeNull()
  })

  it('cancels the previous request when a new one opens', async () => {
    const ui = useUiStore()
    const first = ui.confirm({ title: 'A', confirmLabel: 'Да' })
    const second = ui.confirm({ title: 'B', confirmLabel: 'Да' })
    expect(await first).toBe(false)
    ui.answerConfirm(false)
    expect(await second).toBe(false)
  })
})
