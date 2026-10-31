<script setup lang="ts">
import { ref, watch } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import SyncBadge from '@/components/SyncBadge.vue'
import ThumbImage from '@/components/ThumbImage.vue'
import { useServerStatusRefresh } from '@/composables/useServerStatusRefresh'
import { repository } from '@/storage/repository'
import type { Entry } from '@/storage/types'
import { formatDayTitle, formatTime, plural } from '@/utils/date'
import { reportError } from '@/utils/errors'
import { isOnServer } from '@/sync/status'

const props = defineProps<{ dayKey: string }>()
const entries = ref<Entry[]>([])
const loaded = ref(false)

async function load() {
  try {
    entries.value = await repository.getDay(props.dayKey)
  } catch (e) {
    reportError(e, 'Не удалось загрузить день')
  } finally {
    loaded.value = true
  }
}

watch(() => props.dayKey, load, { immediate: true })
useServerStatusRefresh(load)

const photoWord = (n: number) => `${n} ${plural(n, ['фото', 'фото', 'фото'])}`
</script>

<template>
  <AppHeader :title="formatDayTitle(dayKey)" :back="`/?month=${dayKey.slice(0, 7)}`" />
  <main class="page">
    <p v-if="loaded && entries.length === 0" class="muted empty">В этот день фотографий нет.</p>
    <p v-else-if="entries.length" class="muted count">{{ photoWord(entries.length) }}</p>
    <div class="gallery">
      <RouterLink
        v-for="(e, i) in entries"
        :key="e.id"
        :to="`/entry/${e.id}`"
        class="cell"
        :style="{ animationDelay: `${Math.min(i, 12) * 30}ms` }"
      >
        <ThumbImage :hash="e.thumbHash" :alt="e.comment" />
        <SyncBadge :on-server="isOnServer(e)" />
        <time class="time">{{ formatTime(e.takenAt, e.tzOffsetMin) }}</time>
      </RouterLink>
    </div>
  </main>
</template>

<style scoped>
.page {
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
.count,
.empty {
  margin: 12px 16px;
}
.empty {
  text-align: center;
  padding-top: 18vh;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
}
@media (min-width: 600px) {
  .gallery {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}
.cell {
  position: relative;
  display: block;
  animation: pop-in 0.3s var(--ease-out) backwards;
  transition: transform 0.15s var(--ease-out), opacity 0.15s;
}
.cell:active {
  opacity: 0.8;
  transform: scale(0.97);
}
.time {
  position: absolute;
  left: 6px;
  bottom: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}
</style>
