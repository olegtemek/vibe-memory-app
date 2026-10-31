<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { processFile, processVideoFrame } from '@/image/process'
import { repository } from '@/storage/repository'
import type { ProcessedPhoto } from '@/storage/types'
import { useUiStore } from '@/stores/ui'
import { currentTzOffsetMin } from '@/utils/date'
import { currentLocation, nextLocation, startLocation, stopLocation } from '@/utils/geo'
import { reportError } from '@/utils/errors'

const router = useRouter()
const ui = useUiStore()

const video = ref<HTMLVideoElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const stream = ref<MediaStream | null>(null)
const error = ref<string | null>(null)
const starting = ref(false)
const busy = ref(false)
/** Bumped on every shot to replay the shutter flash. */
const flash = ref(0)
const ready = ref(false)
const hasMultipleCameras = ref(true)

const isHidden = () => document.visibilityState === 'hidden'
/** True while a shot without a position waits for the first fix in the background. */
let awaitingFix = false

const mirrored = computed(() => ui.facingMode === 'user')

function stopStream() {
  stream.value?.getTracks().forEach((t) => t.stop())
  stream.value = null
  ready.value = false
  if (video.value) video.value.srcObject = null
}

function describeError(e: unknown): string {
  const name = (e as Error)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Нет доступа к камере. Разрешите доступ в настройках Safari или воспользуйтесь системной камерой.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена.'
  if (name === 'NotReadableError') return 'Камера занята другим приложением.'
  if (!window.isSecureContext) return 'Камера работает только по HTTPS.'
  return 'Не удалось запустить камеру.'
}

async function startStream() {
  if (starting.value || isHidden()) return
  stopStream()
  error.value = null
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = window.isSecureContext ? 'Браузер не поддерживает камеру в приложении.' : 'Камера работает только по HTTPS.'
    return
  }
  starting.value = true
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: ui.facingMode, width: { ideal: 4096 }, height: { ideal: 3072 } },
      audio: false,
    })
    // The user may have left the screen while permission was pending.
    if (!video.value || isHidden()) {
      s.getTracks().forEach((t) => t.stop())
      return
    }
    stream.value = s
    video.value.srcObject = s
    await video.value.play().catch(() => undefined)
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    hasMultipleCameras.value = devices.filter((d) => d.kind === 'videoinput').length !== 1
  } catch (e) {
    error.value = describeError(e)
  } finally {
    starting.value = false
  }
}

function onVisibility() {
  if (isHidden()) stopStream()
  else startStream()
}

async function finish(photo: ProcessedPhoto) {
  // The draft is stored first, so iOS unloading the app does not lose the shot.
  const location = currentLocation()
  await repository.saveDraft({
    ...photo,
    takenAt: new Date().toISOString(),
    tzOffsetMin: currentTzOffsetMin(),
    comment: '',
    location,
  })
  // No fix yet (cold GPS): attach one that arrives within a few seconds, without holding up the shot.
  if (!location) {
    awaitingFix = true
    nextLocation(10_000)
      .then((late) => late && repository.updateDraftLocation(late))
      .catch(() => undefined)
      .finally(() => {
        awaitingFix = false
        stopLocation()
      })
  }
  stopStream()
  router.replace('/new')
}

async function shoot() {
  if (!video.value || !ready.value || busy.value) return
  busy.value = true
  flash.value++
  try {
    await finish(await processVideoFrame(video.value))
  } catch (e) {
    reportError(e, 'Не удалось сохранить снимок')
  } finally {
    busy.value = false
  }
}

function switchCamera() {
  ui.facingMode = ui.facingMode === 'environment' ? 'user' : 'environment'
  startStream()
}

function openSystemCamera() {
  fileInput.value?.click()
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    await finish(await processFile(file))
  } catch (e) {
    reportError(e, 'Не удалось обработать фото')
  } finally {
    busy.value = false
  }
}

function close() {
  stopStream()
  router.replace('/')
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  startStream()
  // Started together with the viewfinder, so a fix is usually ready by the time of the shot.
  startLocation()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  stopStream()
  if (!awaitingFix) stopLocation()
})
</script>

<template>
  <div class="camera">
    <video
      ref="video"
      class="viewfinder"
      :class="{ mirrored }"
      playsinline
      muted
      autoplay
      @loadedmetadata="ready = true"
    />

    <div v-if="error" class="error">
      <p>{{ error }}</p>
      <button class="btn btn-primary" type="button" @click="openSystemCamera">Открыть системную камеру</button>
      <button class="btn" type="button" @click="startStream">Попробовать снова</button>
    </div>

    <button class="close" type="button" aria-label="Закрыть" @click="close">✕</button>

    <div class="controls">
      <button class="side-btn" type="button" aria-label="Системная камера" @click="openSystemCamera">⧉</button>
      <button
        class="shutter"
        type="button"
        aria-label="Снять"
        :disabled="!ready || busy || !!error"
        @click="shoot"
      >
        <span />
      </button>
      <button
        class="side-btn"
        type="button"
        aria-label="Переключить камеру"
        :disabled="!hasMultipleCameras || busy"
        @click="switchCamera"
      >
        ⟲
      </button>
    </div>

    <input
      ref="fileInput"
      class="visually-hidden"
      type="file"
      accept="image/*"
      capture="environment"
      @change="onFile"
    />

    <div v-if="flash" :key="flash" class="flash" aria-hidden="true" />
    <Transition name="busy">
      <div v-if="busy" class="busy">Сохраняю…</div>
    </Transition>
  </div>
</template>

<style scoped>
.camera {
  position: fixed;
  inset: 0;
  background: #000;
  color: #fff;
  overflow: hidden;
}
.viewfinder {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mirrored {
  transform: scaleX(-1);
}
.close {
  position: absolute;
  top: calc(12px + var(--safe-top));
  left: calc(12px + var(--safe-left));
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 20px;
}
.controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 20px 32px calc(28px + var(--safe-bottom));
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
}
.shutter {
  width: 78px;
  height: 78px;
  border-radius: 50%;
  border: 4px solid #fff;
  background: transparent;
  padding: 4px;
}
.shutter span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.12s var(--ease-out);
}
.shutter {
  transition: transform 0.15s var(--ease-out), opacity 0.2s;
}
.shutter:not(:disabled):active {
  transform: scale(0.94);
}
.shutter:active span {
  transform: scale(0.86);
}
.viewfinder {
  animation: fade-in 0.4s ease backwards;
}
.flash {
  position: absolute;
  inset: 0;
  background: #fff;
  pointer-events: none;
  animation: flash 0.35s ease-out forwards;
}
@keyframes flash {
  from {
    opacity: 0.85;
  }
  to {
    opacity: 0;
  }
}
.side-btn {
  transition: transform 0.15s var(--ease-out), opacity 0.2s;
}
.side-btn:not(:disabled):active {
  transform: scale(0.88) rotate(-20deg);
}
.busy-enter-active {
  transition: opacity 0.2s 0.15s;
}
.busy-enter-from {
  opacity: 0;
}
.shutter:disabled {
  opacity: 0.4;
}
.side-btn {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 22px;
}
.side-btn:disabled {
  opacity: 0.3;
}
.error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  background: #111;
}
.error .btn:not(.btn-primary) {
  background: #333;
  color: #fff;
}
.busy {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  font-weight: 600;
}
</style>
