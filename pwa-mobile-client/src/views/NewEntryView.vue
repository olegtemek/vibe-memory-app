<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { repository } from '@/storage/repository'
import { COMMENT_MAX_LENGTH, type Draft, type DraftFilter } from '@/storage/types'
import {
  DEFAULT_FILTER,
  FILM_PRESETS,
  finishPhoto,
  formatDateStamp,
  getPreset,
  isIdentity,
  readPixels,
  renderFilteredPhoto,
  seedFromHash,
  type FinishOptions,
  type PresetGroup,
} from '@/image/filters'
import { useUiStore } from '@/stores/ui'
import { reportError } from '@/utils/errors'

const router = useRouter()
const ui = useUiStore()
// Shallow: the draft is replaced, never edited in place, and its parts go to IndexedDB as they are.
const draft = shallowRef<Draft | null>(null)
const previewUrl = ref<string>()
const comment = ref('')
const saving = ref(false)
const filter = ref<DraftFilter>({ ...DEFAULT_FILTER })
const group = ref<PresetGroup>('film')
const filterThumbs = ref<Record<string, string>>({})
const canvas = ref<HTMLCanvasElement>()
let previewBase: ImageData | undefined
let renderFrame = 0
let commentTimer: ReturnType<typeof setTimeout> | undefined
let filterTimer: ReturnType<typeof setTimeout> | undefined

const PREVIEW_MAX_SIDE = 1080
const FILTER_THUMB_SIDE = 160
const GROUPS: Array<{ id: PresetGroup; label: string }> = [
  { id: 'film', label: 'Плёнка' },
  { id: 'camera', label: 'Камеры' },
]

const presets = computed(() => FILM_PRESETS.filter((p) => p.group === 'none' || p.group === group.value))
const activePreset = computed(() => getPreset(filter.value.id))

onMounted(async () => {
  const d = await repository.getDraft()
  if (!d) {
    router.replace('/')
    return
  }
  draft.value = d
  comment.value = d.comment
  filter.value = { ...DEFAULT_FILTER, ...d.filter }
  const g = activePreset.value.group
  if (g !== 'none') group.value = g
  previewUrl.value = URL.createObjectURL(d.original)
  await preparePreview(d.original).catch((e) => reportError(e, 'Фильтры недоступны'))
})

onBeforeUnmount(() => {
  clearTimeout(commentTimer)
  clearTimeout(filterTimer)
  cancelAnimationFrame(renderFrame)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

function finishOptions(f: DraftFilter): FinishOptions {
  const d = draft.value!
  return { filter: f, stamp: formatDateStamp(d.takenAt, d.tzOffsetMin), seed: seedFromHash(d.photoHash) }
}

/** Decodes the draft once into small pixel buffers for the live preview and filter tiles. */
async function preparePreview(original: Blob) {
  const bitmap = await createImageBitmap(original)
  try {
    const frame = { source: bitmap, width: bitmap.width, height: bitmap.height }
    previewBase = readPixels(frame, PREVIEW_MAX_SIDE)
    const thumbBase = readPixels(frame, FILTER_THUMB_SIDE)
    const thumbs: Record<string, string> = {}
    for (const preset of FILM_PRESETS) {
      const c = finishPhoto(thumbBase, finishOptions({ id: preset.id, strength: 1, date: false }))
      thumbs[preset.id] = c.toDataURL('image/jpeg', 0.8)
      c.width = 0
      c.height = 0
    }
    filterThumbs.value = thumbs
  } finally {
    bitmap.close()
  }
  renderPreview()
}

function renderPreview() {
  cancelAnimationFrame(renderFrame)
  renderFrame = requestAnimationFrame(() => {
    const el = canvas.value
    if (!el || !previewBase) return
    const result = finishPhoto(previewBase, finishOptions(filter.value))
    el.width = result.width
    el.height = result.height
    el.getContext('2d')?.drawImage(result, 0, 0)
    result.width = 0
    result.height = 0
  })
}

watch(
  filter,
  (f) => {
    renderPreview()
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => repository.updateDraftFilter({ ...f }).catch(() => undefined), 300)
  },
  { deep: true },
)

function selectFilter(id: DraftFilter['id']) {
  if (filter.value.id === id) return
  const preset = getPreset(id)
  // Cameras with a date back switch the imprint on; the user can still turn it off.
  const date = preset.group === 'camera' ? preset.dateStamp : (filter.value.date ?? false)
  filter.value = { id, strength: 1, date }
}

// Keep the typed comment in the draft too: iOS may unload the app at any moment.
watch(comment, (text) => {
  clearTimeout(commentTimer)
  commentTimer = setTimeout(() => repository.updateDraftComment(text).catch(() => undefined), 500)
})

async function save() {
  if (!draft.value || saving.value) return
  saving.value = true
  clearTimeout(commentTimer)
  clearTimeout(filterTimer)
  try {
    // The draft keeps the unfiltered original, so the look can still be changed until saving.
    const photo = isIdentity(filter.value) ? draft.value : await renderFilteredPhoto(draft.value.original, finishOptions(filter.value))
    await repository.createEntry({ ...draft.value, ...photo, comment: comment.value })
    repository.ensurePersisted().catch(() => undefined)
    router.replace('/')
  } catch (e) {
    reportError(e, 'Не удалось сохранить запись')
    saving.value = false
  }
}

async function retake() {
  clearTimeout(commentTimer)
  await repository.deleteDraft()
  router.replace('/camera')
}

async function cancel() {
  clearTimeout(commentTimer)
  await repository.deleteDraft()
  ui.showToast('Снимок удалён')
  router.replace('/')
}
</script>

<template>
  <div v-if="draft" class="new screen-in">
    <div class="preview">
      <canvas v-if="filterThumbs.none" ref="canvas" role="img" aria-label="Снятый кадр" />
      <img v-else :src="previewUrl" alt="Снятый кадр" />
    </div>
    <div v-if="filterThumbs.none" class="filters fade-in">
      <div class="filter-head">
        <div class="tabs" role="tablist">
          <button
            v-for="g in GROUPS"
            :key="g.id"
            type="button"
            role="tab"
            class="tab"
            :class="{ active: group === g.id }"
            :aria-selected="group === g.id"
            @click="group = g.id"
          >
            {{ g.label }}
          </button>
        </div>
        <button
          type="button"
          class="chip"
          :class="{ active: filter.date }"
          :aria-pressed="!!filter.date"
          :disabled="saving"
          @click="filter.date = !filter.date"
        >
          Дата
        </button>
      </div>
      <div class="filter-list" role="radiogroup" aria-label="Плёнка или камера">
        <button
          v-for="preset in presets"
          :key="preset.id"
          type="button"
          role="radio"
          class="filter"
          :class="{ active: filter.id === preset.id }"
          :aria-checked="filter.id === preset.id"
          :disabled="saving"
          @click="selectFilter(preset.id)"
        >
          <img :src="filterThumbs[preset.id]" alt="" />
          <span>{{ preset.name }}</span>
        </button>
      </div>
      <Transition name="note" mode="out-in">
        <p v-if="activePreset.note" :key="activePreset.id" class="note">{{ activePreset.note }}</p>
      </Transition>
      <Transition name="note">
        <label v-if="filter.id !== 'none'" class="strength">
          <span>Сила</span>
          <input v-model.number="filter.strength" type="range" min="0" max="1" step="0.05" :disabled="saving" />
          <span class="strength-value">{{ Math.round(filter.strength * 100) }}%</span>
        </label>
      </Transition>
    </div>
    <form class="form" @submit.prevent="save">
      <label class="visually-hidden" for="comment">Комментарий</label>
      <textarea
        id="comment"
        v-model="comment"
        class="textarea"
        placeholder="Комментарий (необязательно)"
        :maxlength="COMMENT_MAX_LENGTH"
        rows="3"
      />
      <div class="buttons">
        <button class="btn" type="button" :disabled="saving" @click="cancel">Отмена</button>
        <button class="btn" type="button" :disabled="saving" @click="retake">Переснять</button>
        <button class="btn btn-primary" type="submit" :disabled="saving">
          {{ saving ? (isIdentity(filter) ? 'Сохраняю…' : 'Обрабатываю…') : 'Сохранить' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.new {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  background: var(--bg);
}
.preview {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  background: #000;
}
.preview img,
.preview canvas {
  max-width: 100%;
  max-height: 50dvh;
  object-fit: contain;
  display: block;
}
.filters {
  padding: 10px 0 0;
}
.filter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 16px 8px;
}
.tabs {
  display: flex;
  padding: 2px;
  border-radius: 9px;
  background: var(--surface-2);
}
.tab,
.chip {
  min-height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: 7px;
  background: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
}
.tab.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.chip {
  border: 1px solid var(--border);
  border-radius: 16px;
}
.chip.active {
  border-color: #ff8a1e;
  color: #ff8a1e;
}
.note {
  margin: 6px 16px 0;
  font-size: 13px;
  color: var(--text-2);
}
.filter-list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 16px;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.filter-list::-webkit-scrollbar {
  display: none;
}
.filter {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: none;
  font-size: 12px;
  color: var(--text-2);
}
.filter span {
  max-width: 72px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.filter {
  transition: color 0.2s;
}
.filter img {
  transition:
    transform 0.2s var(--ease-out),
    border-color 0.2s;
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  border: 2px solid transparent;
  display: block;
}
.filter.active {
  color: var(--text);
  font-weight: 600;
}
.filter.active img {
  border-color: var(--accent);
  transform: scale(1.06);
}
.filter:active img {
  transform: scale(0.92);
}
.tab {
  transition:
    background-color 0.2s,
    color 0.2s,
    box-shadow 0.2s;
}
.chip {
  transition:
    border-color 0.2s,
    color 0.2s,
    transform 0.15s var(--ease-out);
}
.chip:active {
  transform: scale(0.94);
}
.note-enter-active,
.note-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.note-enter-from,
.note-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.strength {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px 0;
  font-size: 15px;
  color: var(--text-2);
}
.strength input {
  flex: 1;
  accent-color: var(--accent);
}
.strength-value {
  width: 3em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.form {
  padding: 12px 16px 16px;
}
.buttons {
  display: grid;
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: 8px;
  margin-top: 12px;
}
</style>
