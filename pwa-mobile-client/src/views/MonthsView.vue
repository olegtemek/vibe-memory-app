<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import ThumbImage from '@/components/ThumbImage.vue'
import { usePinch, type Point } from '@/composables/usePinch'
import { repository } from '@/storage/repository'
import type { MonthSummary } from '@/storage/months'
import { useUiStore } from '@/stores/ui'
import { formatBadgeCount, isMonthKey, monthKeyOf, monthName, plural, todayDayKey } from '@/utils/date'
import { reportError } from '@/utils/errors'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const currentMonth = monthKeyOf(todayDayKey())
const currentYear = Number(currentMonth.slice(0, 4))
const focus = isMonthKey(route.query.focus) ? route.query.focus : currentMonth

const months = ref(new Map<string, MonthSummary>())
const loaded = ref(false)
const page = ref<HTMLElement>()
const zoomOrigin = ref<string | null>(null)

/** Shown year; starts at the year of the month we zoomed out of. */
const year = ref(Number(focus.slice(0, 4)))

/** Years from the oldest photo (or the focused month) up to now, oldest first. */
const years = computed(() => {
  let first = Math.min(currentYear, Number(focus.slice(0, 4)))
  for (const key of months.value.keys()) first = Math.min(first, Number(key.slice(0, 4)))
  const list: number[] = []
  for (let y = first; y <= currentYear; y++) list.push(y)
  return list
})

const monthKey = (y: number, index: number) => `${y}-${String(index + 1).padStart(2, '0')}`
const firstYear = computed(() => years.value[0]!)
const yearCount = computed(() => {
  let n = 0
  for (const [key, m] of months.value) if (key.startsWith(`${year.value}-`)) n += m.count
  return n
})

const slide = ref<'next' | 'prev'>('next')
watch(year, async (to, from) => {
  slide.value = to > from ? 'next' : 'prev'
  // Keep the chip of the shown year visible when there are many years.
  await nextTick()
  page.value?.querySelector('.year-chip.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
})

function showYear(y: number) {
  year.value = Math.min(currentYear, Math.max(firstYear.value, y))
}

onMounted(async () => {
  try {
    months.value = await repository.listMonths()
  } catch (e) {
    reportError(e, 'Не удалось загрузить месяцы')
  }
  loaded.value = true
  await nextTick()
  page.value?.querySelector('.year-chip.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  // Grow out of the tile of the month we zoomed out of.
  const tile = page.value?.querySelector<HTMLElement>(`[data-month="${focus}"]`)
  const zoom = ui.calendarZoom
  ui.calendarZoom = null
  if (tile && zoom?.dir === 'out') {
    const rect = tile.getBoundingClientRect()
    zoomOrigin.value = `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2 + window.scrollY}px`
  }
})

function open(key: string, from: Point) {
  ui.calendarZoom = { dir: 'in', ...from }
  router.replace({ name: 'feed', query: key === currentMonth ? {} : { month: key } })
}

function openTile(key: string, ev: MouseEvent) {
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  open(key, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
}

// Spreading two fingers over a month opens it.
const pinch = usePinch(page, {
  onPinchOut(center) {
    const tile = document.elementFromPoint(center.x, center.y)?.closest<HTMLElement>('[data-month]')
    const key = tile?.dataset.month
    if (key) open(key, center)
  },
})

// Horizontal swipe switches years, like months in the month view.
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
  showYear(year.value + (dx > 0 ? -1 : 1))
}
</script>

<template>
  <AppHeader title="Месяцы">
    <template #left>
      <button class="btn-link today" type="button" @click="router.replace({ name: 'feed' })">Сегодня</button>
    </template>
    <template #right>
      <RouterLink class="btn-link icon" to="/settings" aria-label="Настройки">⚙︎</RouterLink>
    </template>
  </AppHeader>

  <main
    v-show="loaded"
    ref="page"
    class="page months"
    :class="{ 'zoom-out': zoomOrigin }"
    :style="zoomOrigin ? { transformOrigin: zoomOrigin } : undefined"
    @animationend.self="zoomOrigin = null"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"
  >
    <div class="year-row">
      <div>
        <h1 class="year-title" :class="{ current: year === currentYear }">{{ year }}</h1>
        <p class="muted total">{{ yearCount ? `${yearCount} ${plural(yearCount, ['фото', 'фото', 'фото'])}` : 'Нет фото' }}</p>
      </div>
      <div class="arrows">
        <button
          class="btn-link arrow"
          type="button"
          aria-label="Предыдущий год"
          :disabled="year <= firstYear"
          @click="showYear(year - 1)"
        >
          ‹
        </button>
        <button
          class="btn-link arrow"
          type="button"
          aria-label="Следующий год"
          :disabled="year >= currentYear"
          @click="showYear(year + 1)"
        >
          ›
        </button>
      </div>
    </div>

    <div v-if="years.length > 1" class="year-chips" role="tablist" aria-label="Год">
      <button
        v-for="y in years"
        :key="y"
        type="button"
        role="tab"
        class="year-chip"
        :class="{ active: y === year }"
        :aria-selected="y === year"
        @click="showYear(y)"
      >
        {{ y }}
      </button>
    </div>

    <Transition :name="`year-${slide}`" mode="out-in">
      <div :key="year" class="grid">
        <template v-for="i in 12" :key="i">
          <div v-if="monthKey(year, i - 1) > currentMonth" class="tile future">
            <span class="cover empty" />
            <span class="name">{{ monthName(i - 1) }}</span>
          </div>
          <button
            v-else
            type="button"
            class="tile"
            :data-month="monthKey(year, i - 1)"
            :aria-label="`${monthName(i - 1)} ${year}, фото: ${months.get(monthKey(year, i - 1))?.count ?? 0}`"
            @click="openTile(monthKey(year, i - 1), $event)"
          >
            <span
              class="cover"
              :class="[
                `n${months.get(monthKey(year, i - 1))?.covers.length ?? 0}`,
                { current: monthKey(year, i - 1) === currentMonth },
              ]"
            >
              <ThumbImage v-for="hash in months.get(monthKey(year, i - 1))?.covers ?? []" :key="hash" :hash="hash" />
              <span v-if="months.get(monthKey(year, i - 1))" class="badge">
                {{ formatBadgeCount(months.get(monthKey(year, i - 1))!.count) }}
              </span>
            </span>
            <span class="name" :class="{ current: monthKey(year, i - 1) === currentMonth }">
              {{ monthName(i - 1) }}
            </span>
          </button>
        </template>
      </div>
    </Transition>
  </main>
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
.today {
  border: none;
  min-height: 44px;
  font-size: 17px;
}
.zoom-out {
  animation: zoom-out 0.38s var(--ease-out) backwards;
}
@keyframes zoom-out {
  from {
    opacity: 0;
    transform: scale(2.4);
  }
}
.months {
  /* Two-finger pinch is handled by the app instead of the page zoom. */
  touch-action: pan-y;
}
.year-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 4px 8px;
}
.year-title {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.year-title.current {
  color: var(--accent);
}
.total {
  margin: 0;
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
.year-chips {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  margin: 0 -4px 16px;
  padding: 2px 4px;
  scrollbar-width: none;
}
.year-chips::-webkit-scrollbar {
  display: none;
}
.year-chip {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: 16px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 15px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  transition:
    background-color 0.2s,
    color 0.2s,
    transform 0.15s var(--ease-out);
}
.year-chip:active {
  transform: scale(0.94);
}
.year-chip.active {
  background: var(--accent);
  color: var(--accent-text);
}
.year-next-enter-active,
.year-prev-enter-active,
.year-next-leave-active,
.year-prev-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.year-next-enter-from,
.year-prev-leave-to {
  opacity: 0;
  transform: translateX(32px);
}
.year-next-leave-to,
.year-prev-enter-from {
  opacity: 0;
  transform: translateX(-32px);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px 12px;
}
@media (min-width: 600px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  text-align: left;
  transition: transform 0.15s var(--ease-out);
}
.tile:not(.future):active {
  transform: scale(0.95);
}
.cover {
  position: relative;
  display: grid;
  aspect-ratio: 1;
  gap: 2px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-2);
}
.cover.current {
  box-shadow: 0 0 0 2px var(--accent);
}
/* Collage layouts for 1-4 photos. */
.cover.n2 {
  grid-template-columns: 1fr 1fr;
}
.cover.n3 {
  grid-template: 1fr 1fr / 1fr 1fr;
}
.cover.n3 > :first-child {
  grid-row: span 2;
}
.cover.n4 {
  grid-template: 1fr 1fr / 1fr 1fr;
}
.cover :deep(.thumb) {
  aspect-ratio: auto;
  min-height: 0;
}
.future .cover {
  opacity: 0.35;
}
.badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  min-width: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
}
.name {
  font-size: 15px;
  font-weight: 600;
}
.name.current {
  color: var(--accent);
}
.future .name {
  color: var(--text-2);
  font-weight: 500;
}
</style>
