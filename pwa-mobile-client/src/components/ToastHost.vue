<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'

/** A swipe longer than this (sideways) or this (up), or a quick flick, removes the toast. */
const SWIPE_X = 80
const SWIPE_UP = 30
const SWIPE_SPEED = 0.5

const ui = useUiStore()
const router = useRouter()

function act(to: string) {
  ui.hideToast()
  router.push(to)
}

// --- swipe up or sideways to dismiss, like iOS notifications ---
const offset = ref({ x: 0, y: 0 })
const dragging = ref(false)
let startX = 0
let startY = 0
let startT = 0
/** Decided on the first move; a downward drag is ignored. */
let axis: 'x' | 'y' | 'none' | null = null

// Each new toast starts in place.
watch(
  () => ui.toast,
  () => (offset.value = { x: 0, y: 0 }),
)

function onTouchStart(ev: TouchEvent) {
  startX = ev.touches[0]!.clientX
  startY = ev.touches[0]!.clientY
  startT = ev.timeStamp
  axis = null
}

function onTouchMove(ev: TouchEvent) {
  const dx = ev.touches[0]!.clientX - startX
  const dy = ev.touches[0]!.clientY - startY
  if (axis === null) {
    if (Math.hypot(dx, dy) < 8) return
    axis = Math.abs(dx) > Math.abs(dy) ? 'x' : dy < 0 ? 'y' : 'none'
    dragging.value = axis !== 'none'
  }
  if (axis === 'x') offset.value = { x: dx, y: 0 }
  if (axis === 'y') offset.value = { x: 0, y: Math.min(0, dy) }
}

function onTouchEnd(ev: TouchEvent) {
  if (!dragging.value) return
  dragging.value = false
  const { x, y } = offset.value
  const speed = Math.hypot(x, y) / Math.max(1, ev.timeStamp - startT)
  const gone = axis === 'x' ? Math.abs(x) > SWIPE_X : -y > SWIPE_UP
  if (!gone && speed < SWIPE_SPEED) {
    offset.value = { x: 0, y: 0 }
    return
  }
  // Fly off in the swipe direction; the leave transition fades it out on the way.
  offset.value = axis === 'x' ? { x: Math.sign(x) * window.innerWidth, y: 0 } : { x: 0, y: -120 }
  ui.hideToast()
}

function onTouchCancel() {
  dragging.value = false
  offset.value = { x: 0, y: 0 }
}

const toastStyle = computed(() => {
  const { x, y } = offset.value
  if (!x && !y && !dragging.value) return undefined
  return {
    transform: `translate(${x}px, ${y}px)`,
    opacity: axis === 'x' ? 1 - Math.min(Math.abs(x) / window.innerWidth, 0.6) : 1,
    transition: dragging.value ? 'none' : 'transform 0.2s ease-out, opacity 0.2s',
  }
})
</script>

<template>
  <Transition name="toast">
    <div
      v-if="ui.toast"
      class="toast"
      :class="ui.toast.kind"
      :style="toastStyle"
      role="alert"
      @click="ui.hideToast"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
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
  /* The swipe is handled here; the page must not scroll under the finger. */
  touch-action: none;
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
