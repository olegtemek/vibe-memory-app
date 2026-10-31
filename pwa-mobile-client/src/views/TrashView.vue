<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import ThumbImage from '@/components/ThumbImage.vue'
import { repository } from '@/storage/repository'
import type { Entry } from '@/storage/types'
import { formatDateTime } from '@/utils/date'
import { reportError } from '@/utils/errors'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const entries = ref<Entry[]>([])
const loaded = ref(false)
const busyId = ref<string | null>(null)

async function load() {
  entries.value = await repository.listTrash()
  loaded.value = true
}
onMounted(() => load().catch((e) => reportError(e)))

async function restore(e: Entry) {
  if (busyId.value) return
  busyId.value = e.id
  try {
    await repository.restore(e.id)
    await load()
    ui.showToast('Фото восстановлено')
  } catch (err) {
    reportError(err, 'Не удалось восстановить')
  } finally {
    busyId.value = null
  }
}

async function purge(e: Entry) {
  if (busyId.value) return
  const ok = await ui.confirm({
    title: 'Удалить фото навсегда?',
    message: 'Это действие нельзя отменить.',
    confirmLabel: 'Удалить навсегда',
    danger: true,
  })
  if (!ok) return
  busyId.value = e.id
  try {
    await repository.purge(e.id)
    await load()
  } catch (err) {
    reportError(err, 'Не удалось удалить')
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <AppHeader title="Корзина" back="/settings" />
  <main class="page">
    <Transition name="fade">
      <p v-if="loaded && entries.length === 0" class="muted">Корзина пуста.</p>
    </Transition>
    <TransitionGroup name="row" tag="div" class="list">
      <article v-for="e in entries" :key="e.id" class="row">
        <ThumbImage class="thumb" :hash="e.thumbHash" :alt="e.comment" />
        <div class="info">
          <div>{{ formatDateTime(e.takenAt, e.tzOffsetMin) }}</div>
          <div v-if="e.comment" class="muted comment">{{ e.comment }}</div>
          <div class="actions">
            <button class="btn" type="button" :disabled="busyId === e.id" @click="restore(e)">Восстановить</button>
            <button class="btn btn-danger" type="button" :disabled="busyId === e.id" @click="purge(e)">Удалить</button>
          </div>
        </div>
      </article>
    </TransitionGroup>
  </main>
</template>

<style scoped>
.list {
  position: relative;
}
.row-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.row-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}
.row-move {
  transition: transform 0.3s ease;
}
.fade-enter-active {
  transition: opacity 0.3s 0.15s;
}
.fade-enter-from {
  opacity: 0;
}
.row {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.thumb {
  width: 88px;
  flex-shrink: 0;
  border-radius: 8px;
}
.info {
  flex: 1;
  min-width: 0;
}
.comment {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.actions .btn {
  min-height: 36px;
  padding: 0 12px;
  font-size: 15px;
}
</style>
