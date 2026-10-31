<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const router = useRouter()

function act(to: string) {
  ui.hideToast()
  router.push(to)
}
</script>

<template>
  <Transition name="toast">
    <div v-if="ui.toast" class="toast" :class="ui.toast.kind" role="alert" @click="ui.hideToast">
      <span>{{ ui.toast.text }}</span>
      <button v-if="ui.toast.action" class="btn-link" type="button" @click.stop="act(ui.toast.action.to)">
        {{ ui.toast.action.label }}
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  z-index: 100;
  top: calc(var(--safe-top) + 8px);
  left: calc(12px + var(--safe-left));
  right: calc(12px + var(--safe-right));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
  font-size: 15px;
}
.toast.error {
  border-left: 4px solid var(--danger);
}
.toast-enter-active,
.toast-leave-active {
  transition: transform 0.2s, opacity 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  transform: translateY(-20px);
  opacity: 0;
}
</style>
