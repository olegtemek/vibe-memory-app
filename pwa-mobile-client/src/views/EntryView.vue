<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { repository } from '@/storage/repository'
import { COMMENT_MAX_LENGTH, type Entry } from '@/storage/types'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { ServerError } from '@/sync/client'
import { formatDateTime } from '@/utils/date'
import { reportError } from '@/utils/errors'
import { splitByTags } from '@/utils/tags'

const props = defineProps<{ id: string }>()
const router = useRouter()
const ui = useUiStore()
const sync = useSyncStore()

const entry = ref<Entry | null>(null)
const siblings = ref<Entry[]>([])
const photoUrl = ref<string>()
const notFound = ref(false)
const editing = ref(false)
const draftComment = ref('')
const editor = ref<HTMLTextAreaElement | null>(null)
const photoLoaded = ref(false)
/** Blurred medium copy shown while an offloaded original comes from the server. */
const placeholderUrl = ref<string>()
type RemoteState = { step: 'loading' } | { step: 'failed'; text: string } | { step: 'no-server' }
const remote = ref<RemoteState | null>(null)
/** Direction the new photo slides in from when moving between photos of the day. */
const slideFrom = ref<'next' | 'prev' | null>(null)

const index = computed(() => siblings.value.findIndex((e) => e.id === props.id))
const prev = computed(() => (index.value > 0 ? siblings.value[index.value - 1] : undefined))
const next = computed(() => (index.value >= 0 ? siblings.value[index.value + 1] : undefined))

function revokePhoto() {
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value)
  if (placeholderUrl.value) URL.revokeObjectURL(placeholderUrl.value)
  photoUrl.value = undefined
  placeholderUrl.value = undefined
  remote.value = null
}

async function load(id: string) {
  editing.value = false
  notFound.value = false
  const e = await repository.getEntry(id)
  if (!e || e.purgedAt) {
    entry.value = null
    notFound.value = true
    revokePhoto()
    return
  }
  entry.value = e
  if (siblings.value[0]?.dayKey !== e.dayKey || !siblings.value.some((s) => s.id === id))
    siblings.value = await repository.getDay(e.dayKey)
  // Originals are loaded only on this screen, one at a time.
  // An offloaded original is stood in for by its medium copy, or the thumbnail for entries from another device.
  const blob = await repository.getBlob(e.offloaded ? (e.mediumHash ?? e.thumbHash) : e.photoHash)
  if (props.id !== id) return
  revokePhoto()
  photoLoaded.value = false
  if (!blob) return
  if (!e.offloaded) {
    photoUrl.value = URL.createObjectURL(blob)
    return
  }
  placeholderUrl.value = URL.createObjectURL(blob)
  await loadRemote(e)
}

async function loadRemote(e: Entry) {
  await sync.init()
  if (!sync.configured) {
    remote.value = { step: 'no-server' }
    return
  }
  remote.value = { step: 'loading' }
  try {
    const blob = await sync.fetchOriginal(e)
    if (props.id !== e.id) return
    photoUrl.value = URL.createObjectURL(blob)
    remote.value = null
  } catch (err) {
    if (props.id !== e.id) return
    if (!(err instanceof ServerError)) console.error(err)
    remote.value = { step: 'failed', text: err instanceof ServerError ? err.message : 'Не удалось загрузить' }
  }
}

function retryRemote() {
  if (entry.value) loadRemote(entry.value).catch((e) => reportError(e))
}

watch(() => props.id, (id) => load(id).catch((e) => reportError(e, 'Не удалось открыть фото')), {
  immediate: true,
})

onBeforeUnmount(revokePhoto)

function go(target: Entry | undefined) {
  if (!target) return
  slideFrom.value = target === next.value ? 'next' : 'prev'
  router.replace(`/entry/${target.id}`)
}

// --- touch: swipe sideways between photos of the day, drag down to close ---
/** Released lower than this, or flicked faster than DISMISS_SPEED, the drag closes the viewer. */
const DISMISS_DISTANCE = 120
/** px per ms over the whole drag. */
const DISMISS_SPEED = 0.6
const DISMISS_MS = 200

let touchX = 0
let touchY = 0
let touchT = 0
/** Decided on the first move: `down` drags the viewer, `other` leaves the gesture to swipes and zoom. */
let gesture: 'down' | 'other' | null = null
const dragY = ref(0)
const dragging = ref(false)

/** Pinch-zoomed: a vertical drag pans the photo instead. */
const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01

function onTouchStart(ev: TouchEvent) {
  touchX = ev.touches[0]!.clientX
  touchY = ev.touches[0]!.clientY
  touchT = ev.timeStamp
  gesture = ev.touches.length === 1 && !editing.value && !zoomed() ? null : 'other'
}

function onTouchMove(ev: TouchEvent) {
  if (gesture === 'other') return
  if (ev.touches.length !== 1) {
    // A second finger: this is a pinch, not a drag.
    gesture = 'other'
    dragging.value = false
    dragY.value = 0
    return
  }
  const dx = ev.touches[0]!.clientX - touchX
  const dy = ev.touches[0]!.clientY - touchY
  if (gesture === null) {
    if (Math.hypot(dx, dy) < 10) return
    gesture = dy > 0 && dy > Math.abs(dx) * 1.2 ? 'down' : 'other'
    if (gesture === 'other') return
    dragging.value = true
  }
  ev.preventDefault()
  dragY.value = Math.max(0, dy)
}

function onTouchEnd(ev: TouchEvent) {
  const dx = ev.changedTouches[0]!.clientX - touchX
  const dy = ev.changedTouches[0]!.clientY - touchY
  if (gesture === 'down') {
    gesture = null
    dragging.value = false
    const speed = dy / Math.max(1, ev.timeStamp - touchT)
    if (dy > DISMISS_DISTANCE || speed > DISMISS_SPEED) dismiss()
    else dragY.value = 0
    return
  }
  gesture = null
  if (editing.value) return
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
  go(dx < 0 ? next.value : prev.value)
}

function onTouchCancel() {
  gesture = null
  dragging.value = false
  dragY.value = 0
}

let dismissTimer: ReturnType<typeof setTimeout> | undefined
/** Lets the photo fall off the screen, then closes. */
function dismiss() {
  dragY.value = window.innerHeight
  dismissTimer = setTimeout(close, DISMISS_MS)
}
onBeforeUnmount(() => clearTimeout(dismissTimer))

/** 0 at rest, 1 when dragged half the screen down. */
const dragProgress = computed(() => Math.min(dragY.value / (window.innerHeight / 2), 1))
const stageStyle = computed(() =>
  dragY.value || dragging.value
    ? {
        transform: `translateY(${dragY.value}px) scale(${1 - dragProgress.value * 0.25})`,
        transition: dragging.value ? 'none' : `transform ${DISMISS_MS}ms ease-out`,
      }
    : undefined,
)
const chromeStyle = computed(() =>
  dragY.value ? { opacity: 1 - dragProgress.value, transition: dragging.value ? 'none' : `opacity ${DISMISS_MS}ms` } : undefined,
)
function onKey(ev: KeyboardEvent) {
  if (editing.value) return
  if (ev.key === 'ArrowLeft') go(prev.value)
  if (ev.key === 'ArrowRight') go(next.value)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// --- keyboard ---
// iOS does not shrink fixed elements when the keyboard opens: the footer with the editor
// ends up under the keyboard. While editing, the viewer follows the visual viewport instead.
// Only while editing, so pinch-zooming the photo does not resize the viewer.
const viewport = ref<{ top: number; height: number } | null>(null)
const viewerStyle = computed(() => ({
  ...(viewport.value && { top: `${viewport.value.top}px`, height: `${viewport.value.height}px`, bottom: 'auto' }),
  // The page behind shows through while the photo is dragged down.
  ...(dragY.value && { background: `rgba(0, 0, 0, ${1 - dragProgress.value * 0.7})` }),
}))

function syncViewport() {
  const vv = window.visualViewport
  if (vv) viewport.value = { top: vv.offsetTop, height: vv.height }
}

watch(editing, (on) => {
  const vv = window.visualViewport
  if (!vv) return
  if (on) {
    vv.addEventListener('resize', syncViewport)
    vv.addEventListener('scroll', syncViewport)
    syncViewport()
  } else {
    vv.removeEventListener('resize', syncViewport)
    vv.removeEventListener('scroll', syncViewport)
    viewport.value = null
    // iOS may leave the page scrolled after the keyboard closes.
    window.scrollTo(0, 0)
  }
})

onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', syncViewport)
  window.visualViewport?.removeEventListener('scroll', syncViewport)
})

// --- comment ---
const commentParts = computed(() => splitByTags(entry.value?.comment ?? ''))

function openTag(tag: string) {
  router.push({ name: 'search', query: { tag } })
}
async function startEdit() {
  if (!entry.value) return
  draftComment.value = entry.value.comment
  editing.value = true
  await nextTick()
  editor.value?.focus()
}

async function saveComment() {
  if (!entry.value) return
  const text = draftComment.value.trim()
  editing.value = false
  if (text === entry.value.comment) return
  try {
    await repository.updateComment(entry.value.id, text)
    entry.value = { ...entry.value, comment: text }
  } catch (e) {
    reportError(e, 'Не удалось сохранить комментарий')
  }
}

// --- actions ---
async function share() {
  if (!entry.value) return
  const e = entry.value
  // Without the server, an offloaded photo is shared as its medium copy (or thumbnail).
  const blob = e.offloaded
    ? await sync.fetchOriginal(e).catch(() => repository.getBlob(e.mediumHash ?? e.thumbHash))
    : await repository.getBlob(e.photoHash)
  if (!blob) return
  const file = new File([blob], `photo-${entry.value.dayKey}-${entry.value.id.slice(0, 8)}.jpg`, {
    type: 'image/jpeg',
  })
  if (!navigator.canShare?.({ files: [file] })) {
    ui.showToast('«Поделиться» недоступно в этом браузере', 'error')
    return
  }
  try {
    await navigator.share({ files: [file] })
  } catch (e) {
    if ((e as Error).name !== 'AbortError') reportError(e, 'Не удалось поделиться')
  }
}

async function remove() {
  if (!entry.value) return
  const target = next.value ?? prev.value
  const dayKey = entry.value.dayKey
  try {
    await repository.softDelete(entry.value.id)
    const removedId = entry.value.id
    siblings.value = siblings.value.filter((s) => s.id !== removedId)
    ui.showToast('Перемещено в корзину', 'info', { label: 'Корзина', to: '/trash' })
    if (target) router.replace(`/entry/${target.id}`)
    else router.replace(`/day/${dayKey}`)
  } catch (e) {
    reportError(e, 'Не удалось удалить')
  }
}

async function restore() {
  if (!entry.value) return
  await repository.restore(entry.value.id)
  await load(entry.value.id)
}

let closed = false
function close() {
  // Once only: the ✕ button may be tapped while a drag-to-close is finishing.
  if (closed) return
  closed = true
  clearTimeout(dismissTimer)
  if (window.history.state?.back) router.back()
  else router.replace(entry.value ? `/day/${entry.value.dayKey}` : '/')
}
</script>

<template>
  <div class="viewer fade-in" :class="{ editing }" :style="viewerStyle">
    <header class="top" :style="chromeStyle">
      <button class="icon-btn" type="button" aria-label="Закрыть" @click="close">✕</button>
      <div v-if="entry" class="when">
        {{ formatDateTime(entry.takenAt, entry.tzOffsetMin) }}
        <span v-if="siblings.length > 1 && index >= 0" class="counter">{{ index + 1 }} / {{ siblings.length }}</span>
      </div>
      <span class="icon-btn" />
    </header>

    <div
      class="stage"
      :style="stageStyle"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
      <img
        v-if="placeholderUrl"
        :key="placeholderUrl"
        class="placeholder-photo"
        :class="{ gone: photoLoaded }"
        :src="placeholderUrl"
        alt=""
        draggable="false"
      />
      <img
        v-if="photoUrl"
        :key="photoUrl"
        class="photo"
        :class="[slideFrom, { loaded: photoLoaded }]"
        :src="photoUrl"
        alt=""
        draggable="false"
        @load="photoLoaded = true"
      />
      <p v-else-if="notFound" class="missing">Фото не найдено</p>
      <div v-if="remote" class="remote-note">
        <p class="remote-title">Оригинал хранится на сервере</p>
        <p v-if="remote.step === 'loading'">Получаю фото с сервера…</p>
        <template v-else-if="remote.step === 'failed'">
          <p>{{ remote.text }}</p>
          <button class="btn" type="button" @click="retryRemote">Повторить</button>
        </template>
        <p v-else>Чтобы открыть оригинал, подключите сервер в настройках.</p>
      </div>
      <button v-if="prev && !editing" class="nav left" type="button" aria-label="Предыдущее" @click="go(prev)">‹</button>
      <button v-if="next && !editing" class="nav right" type="button" aria-label="Следующее" @click="go(next)">›</button>
    </div>

    <footer v-if="entry" class="bottom" :style="chromeStyle">
      <div v-if="entry.deleted" class="trash-note">
        Фото в корзине.
        <button class="btn-link" type="button" @click="restore">Восстановить</button>
      </div>
      <template v-else>
        <div v-if="editing" class="edit">
          <textarea
            ref="editor"
            v-model="draftComment"
            class="textarea"
            :maxlength="COMMENT_MAX_LENGTH"
            rows="3"
            placeholder="Комментарий"
          />
          <div class="edit-actions">
            <button class="btn" type="button" @click="editing = false">Отмена</button>
            <button class="btn btn-primary" type="button" @click="saveComment">Готово</button>
          </div>
        </div>
        <button v-else class="comment" type="button" @click="startEdit">
          <span v-if="entry.comment"
            ><template v-for="(part, i) in commentParts" :key="i"
              ><span v-if="part.tag" class="tag" role="link" @click.stop="openTag(part.tag)">{{ part.text }}</span
              ><template v-else>{{ part.text }}</template></template
            ></span
          >
          <span v-else class="placeholder">Добавить комментарий</span>
        </button>
        <div class="actions">
          <button class="btn" type="button" @click="share">Поделиться</button>
          <button class="btn btn-danger" type="button" @click="remove">Удалить</button>
        </div>
      </template>
    </footer>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #000;
  color: #fff;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(6px + var(--safe-top)) calc(8px + var(--safe-right)) 6px calc(8px + var(--safe-left));
}
.when {
  font-size: 15px;
  font-weight: 600;
  text-align: center;
}
.counter {
  display: block;
  font-weight: 400;
  font-size: 13px;
  opacity: 0.7;
}
.icon-btn {
  width: 44px;
  height: 44px;
  border: none;
  background: none;
  color: #fff;
  font-size: 20px;
}
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  /* Definite track sizes, so max-height: 100% on the photo resolves and it never spills over the footer. */
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
  overflow: hidden;
  touch-action: pan-y pinch-zoom;
}
.stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-select: none;
}
.photo {
  opacity: 0;
  transform: scale(0.98);
  transition:
    opacity 0.25s ease,
    transform 0.32s var(--ease-out);
}
.photo.next {
  transform: translateX(32px);
}
.photo.prev {
  transform: translateX(-32px);
}
.photo.loaded {
  opacity: 1;
  transform: none;
}
.missing {
  opacity: 0.7;
}
.stage > * {
  grid-area: 1 / 1;
}
.placeholder-photo {
  filter: blur(16px);
  opacity: 0.8;
  transition: opacity 0.3s ease;
}
.placeholder-photo.gone {
  opacity: 0;
}
.remote-note {
  z-index: 1;
  max-width: 280px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.55);
  text-align: center;
  font-size: 14px;
}
.remote-note p {
  margin: 0 0 6px;
}
.remote-title {
  font-weight: 600;
}
.remote-note .btn {
  margin-top: 6px;
  background: #2c2c2e;
  color: #fff;
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 64px;
  border: none;
  background: rgba(0, 0, 0, 0.3);
  color: #fff;
  font-size: 32px;
  display: none;
}
.left {
  left: 0;
}
.right {
  right: 0;
}
@media (hover: hover) {
  .nav {
    display: block;
  }
}
.bottom {
  position: relative;
  z-index: 1;
  padding: 10px calc(16px + var(--safe-right)) calc(12px + var(--safe-bottom)) calc(16px + var(--safe-left));
  background: rgba(28, 28, 30, 0.9);
}
.comment {
  display: block;
  width: 100%;
  max-height: 30dvh;
  overflow: auto;
  padding: 6px 0 10px;
  border: none;
  background: none;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #fff;
}
.placeholder {
  color: #98989f;
}
.tag {
  color: #64d2ff;
}
.textarea {
  background: #2c2c2e;
  color: #fff;
  border-color: #3a3a3c;
}
.edit-actions,
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.actions .btn,
.edit-actions .btn:not(.btn-primary) {
  background: #2c2c2e;
  color: #fff;
}
.actions .btn-danger {
  color: #ff453a;
}
.trash-note {
  padding: 8px 0;
}
</style>
