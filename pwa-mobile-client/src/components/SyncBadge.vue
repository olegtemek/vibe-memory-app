<script setup lang="ts">
import { useSyncStore } from '@/stores/sync'

/** `true`: the server has both files of the photo. */
defineProps<{ onServer: boolean }>()
const sync = useSyncStore()
</script>

<template>
  <span
    v-if="sync.configured"
    class="sync-badge"
    :class="onServer ? 'done' : 'waiting'"
    role="img"
    :aria-label="onServer ? 'На сервере' : 'Не выгружено на сервер'"
  >
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        v-if="onServer"
        fill="currentColor"
        d="M9.5 16.6 5.4 12.5l1.4-1.4 2.7 2.7 7.7-7.7 1.4 1.4-9.1 9.1Z"
      />
      <path v-else fill="currentColor" d="M11 20V8.8l-4.1 4.1-1.4-1.4L12 5l6.5 6.5-1.4 1.4L13 8.8V20h-2Z" />
    </svg>
  </span>
</template>

<style scoped>
.sync-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #fff;
  pointer-events: none;
}
.done {
  background: rgba(0, 0, 0, 0.35);
}
.waiting {
  background: #ff9500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
</style>
