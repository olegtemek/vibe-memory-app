<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import ThumbImage from '@/components/ThumbImage.vue'
import { usePinch, type Point } from '@/composables/usePinch'
import { useServerStatusRefresh } from '@/composables/useServerStatusRefresh'
import { repository } from '@/storage/repository'
import type { Entry } from '@/storage/types'
import { useUiStore } from '@/stores/ui'
import { formatMonthTitle, isMonthKey, monthKeyOf, monthWeeks, shiftMonth, todayDayKey } from '@/utils/date'
import { reportError } from '@/utils/errors'
import { isOnServer } from '@/sync/status'
import { useSyncStore } from '@/stores/sync'

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const sync = useSyncStore()
const today = ref(todayDayKey())
const byDay = ref(new Map<string, Entry[]>())
const main = ref<HTMLElement>()

const currentMonth = computed(() => monthKeyOf(today.value))
/** Shown month: ?month=YYYY-MM, never in the future; the current month by default. */
const month = computed(() => {
  const q = route.query.month
  return isMonthKey(q) && q < currentMonth.value ? q : currentMonth.value
})
const weeks = computed(() => monthWeeks(`${month.value}-01`))
const monthTitle = computed(() => formatMonthTitle(`${month.value}-01`))
const year = computed(() => month.value.slice(0, 4))
const isCurrent = computed(() => month.value === currentMonth.value)

async function load() {
  today.value = todayDayKey()
  const flat = weeks.value.flat().filter((k): k is string => k !== null)
  try {
    const days = await repository.listDayRange(flat[0]!, flat.at(-1)!)
    byDay.value = new Map(days.map((d) => [d.dayKey, d.entries]))
  } catch (e) {
    reportError(e, 'Не удалось загрузить календарь')
  }
}

// --- zoom from / to the months overview ---
const zoom = ref<{ x: number; y: number } | null>(null)
function takeZoom() {
  const z = ui.calendarZoom
  ui.calendarZoom = null
  zoom.value = z?.dir === 'in' ? { x: z.x, y: z.y + window.scrollY } : null
}

// The calendar is kept alive; reload when coming back (new photos, new day).
let firstActivation = true
onMounted(() => {
  takeZoom()
  load()
})
onActivated(() => {
  if (firstActivation) firstActivation = false
  else {
    takeZoom()
    load()
  }
})

useServerStatusRefresh(load)

const slide = ref<'next' | 'prev'>('next')
watch(month, (to, from) => {
  slide.value = to > from ? 'next' : 'prev'
  load()
})

function openMonth(key: string) {
  router.replace({ name: 'feed', query: key === currentMonth.value ? {} : { month: key } })
}

function zoomOut(center?: Point) {
  const rect = main.value?.querySelector('.month')?.getBoundingClientRect()
  const from = center ?? { x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.top : 0 }
  ui.calendarZoom = { dir: 'out', ...from }
  router.replace({ name: 'months', query: { focus: month.value } })
}

// Pinch with two fingers zooms out to all months.
const pinch = usePinch(main, { onPinchIn: zoomOut })

// Horizontal swipe changes the month, like in the Calendar app.
let touchX = 0
let touchY = 0
function onTouchStart(ev: TouchEvent) {
  if (ev.touches.length !== 1) return
  touchX = ev.touches[0]!.clientX
  touchY = ev.touches[0]!.clientY
}
function onTouchEnd(ev: TouchEvent) {
  if (ev.touches.length) return
  if (pinch.consumePinch()) return
  const dx = ev.changedTouches[0]!.clientX - touchX
  const dy = ev.changedTouches[0]!.clientY - touchY
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return
  if (dx > 0) openMonth(shiftMonth(month.value, -1))
  else if (!isCurrent.value) openMonth(shiftMonth(month.value, 1))
}

const dayNumber = (dayKey: string) => Number(dayKey.slice(8))
/** The cover of a day is its latest photo. */
const cover = (dayKey: string) => byDay.value.get(dayKey)?.at(-1)
const count = (dayKey: string) => byDay.value.get(dayKey)?.length ?? 0
/** The day has photos the server does not have yet. */
const waiting = (dayKey: string) => sync.configured && !!byDay.value.get(dayKey)?.some((e) => !isOnServer(e))
</script>

<template>
  <AppHeader>
    <template #left>
      <button class="btn-link year-btn" type="button" aria-label="Все месяцы" @click="zoomOut()">‹ {{ year }}</button>
    </template>
    <template #right>
      <button v-if="!isCurrent" class="btn-link" type="button" @click="openMonth(currentMonth)">Сегодня</button>
      <RouterLink class="btn-link icon" to="/search" aria-label="Поиск по тегам">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10 3a7 7 0 0 1 5.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
          />
        </svg>
      </RouterLink>
      <RouterLink class="btn-link icon" to="/settings" aria-label="Настройки">⚙︎</RouterLink>
    </template>
  </AppHeader>

  <main
    ref="main"
    class="page calendar"
    :class="{ 'zoom-in': zoom }"
    :style="zoom ? { transformOrigin: `${zoom.x}px ${zoom.y}px` } : undefined"
    @animationend.self="zoom = null"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"
  >
    <div class="month-row">
      <h1 class="month">{{ monthTitle }}</h1>
      <div class="arrows">
        <button class="btn-link arrow" type="button" aria-label="Предыдущий месяц" @click="openMonth(shiftMonth(month, -1))">
          ‹
        </button>
        <button
          class="btn-link arrow"
          type="button"
          aria-label="Следующий месяц"
          :disabled="isCurrent"
          @click="openMonth(shiftMonth(month, 1))"
        >
          ›
        </button>
      </div>
    </div>

    <div class="weekdays" aria-hidden="true">
      <span v-for="(w, i) in WEEKDAYS" :key="w" :class="{ weekend: i >= 5 }">{{ w }}</span>
    </div>

    <Transition :name="`month-${slide}`" mode="out-in">
      <div :key="month">
        <div v-for="(week, wi) in weeks" :key="wi" class="week">
          <template v-for="(dayKey, di) in week" :key="dayKey ?? `empty-${wi}-${di}`">
            <div v-if="!dayKey" class="day" />
            <div v-else-if="dayKey > today" class="day future">
              <span class="num" :class="{ weekend: di >= 5 }">{{ dayNumber(dayKey) }}</span>
            </div>
            <RouterLink
              v-else
              :to="`/day/${dayKey}`"
              class="day"
              :aria-label="`${dayNumber(dayKey)}, фото: ${count(dayKey)}`"
            >
              <span class="num" :class="{ today: dayKey === today, weekend: di >= 5 }">{{ dayNumber(dayKey) }}</span>
              <span v-if="cover(dayKey)" class="preview">
                <ThumbImage :hash="cover(dayKey)!.thumbHash" />
                <span v-if="count(dayKey) > 1" class="badge">{{ count(dayKey) }}</span>
                <span v-if="waiting(dayKey)" class="waiting" aria-label="Есть фото не на сервере" />
              </span>
            </RouterLink>
          </template>
        </div>
      </div>
    </Transition>
  </main>

  <RouterLink to="/camera" class="fab" aria-label="Сделать фото">
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
      />
    </svg>
  </RouterLink>
</template>

<style scoped>
.icon {
  font-size: 24px;
  text-decoration: none;
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center;
}
.calendar {
  /* Two-finger pinch is handled by the app instead of the page zoom. */
  touch-action: pan-y;
  padding-left: calc(8px + var(--safe-left));
  padding-right: calc(8px + var(--safe-right));
}
.year-btn {
  border: none;
  min-height: 44px;
  font-size: 17px;
}
.month-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.arrows {
  display: flex;
}
.arrow {
  border: none;
  min-width: 44px;
  min-height: 44px;
  font-size: 28px;
  line-height: 1;
}
.arrow:disabled {
  opacity: 0.3;
}
.zoom-in {
  animation: zoom-in 0.38s var(--ease-out) backwards;
}
@keyframes zoom-in {
  from {
    opacity: 0;
    transform: scale(0.3);
  }
}
.month-next-enter-active,
.month-prev-enter-active,
.month-next-leave-active,
.month-prev-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.month-next-enter-from,
.month-prev-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
.month-next-leave-to,
.month-prev-enter-from {
  opacity: 0;
  transform: translateX(-24px);
}
.month {
  margin: 4px 8px 12px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.weekdays,
.week {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.weekdays {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  color: var(--text-2);
}
.week {
  border-bottom: 1px solid var(--border);
}
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-height: 84px;
  padding: 6px 2px 8px;
  color: var(--text);
  text-decoration: none;
}
.day {
  transition: background-color 0.2s;
}
.day:active {
  background: var(--surface-2);
  transition-duration: 0s;
}
.num {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.weekend {
  color: var(--text-2);
}
.num.today {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.future .num {
  opacity: 0.35;
}
.preview {
  position: relative;
  width: 100%;
  max-width: 44px;
  border-radius: 6px;
  overflow: hidden;
}
.badge {
  position: absolute;
  right: 2px;
  bottom: 2px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
.waiting {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff9500;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.5);
}
.fab {
  position: fixed;
  z-index: 20;
  left: 50%;
  bottom: calc(20px + var(--safe-bottom));
  transform: translateX(-50%);
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
}
.fab {
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s;
  animation: fab-in 0.4s 0.1s cubic-bezier(0.2, 0.9, 0.3, 1.3) backwards;
}
@keyframes fab-in {
  from {
    transform: translateX(-50%) scale(0.4);
    opacity: 0;
  }
}
.fab:active {
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  transform: translateX(-50%) scale(0.94);
}
</style>
