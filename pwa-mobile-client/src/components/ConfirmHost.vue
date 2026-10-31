<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const cancelButton = ref<HTMLButtonElement>()

watch(
  () => ui.confirmRequest,
  async (request) => {
    if (!request) return
    await nextTick()
    cancelButton.value?.focus()
  },
)
</script>

<template>
  <Transition name="sheet">
    <div v-if="ui.confirmRequest" class="backdrop" @click.self="ui.answerConfirm(false)" @keydown.esc="ui.answerConfirm(false)">
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{{ ui.confirmRequest.title }}</h2>
        <p v-if="ui.confirmRequest.message" class="muted">{{ ui.confirmRequest.message }}</p>
        <div class="buttons">
          <button
            class="btn"
            :class="ui.confirmRequest.danger ? 'btn-destructive' : 'btn-primary'"
            type="button"
            @click="ui.answerConfirm(true)"
          >
            {{ ui.confirmRequest.confirmLabel }}
          </button>
          <button ref="cancelButton" class="btn" type="button" @click="ui.answerConfirm(false)">Отмена</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px calc(12px + var(--safe-right)) calc(12px + var(--safe-bottom)) calc(12px + var(--safe-left));
  background: var(--overlay);
}
.sheet {
  width: min(420px, 100%);
  padding: 20px;
  border-radius: 18px;
  background: var(--surface);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
h2 {
  margin: 0 0 6px;
  font-size: 19px;
}
p {
  margin: 0;
}
.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.btn-destructive {
  background: var(--danger);
  color: #fff;
}
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.22s ease;
}
.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}
.sheet-leave-active .sheet {
  transition-timing-function: ease-in;
  transition-duration: 0.2s;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(110%);
}
</style>
