<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import { repository } from '@/storage/repository'
import type { ServerSettings, UsageInfo } from '@/storage/types'
import { buildPart, deliverFile, prepareExport, type PreparedExport } from '@/export/exporter'
import { periodBounds, type PeriodKind } from '@/export/plan'
import { usePwa } from '@/composables/usePwa'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { isMixedContent, ServerError } from '@/sync/client'
import type { SyncPhase } from '@/sync/syncer'
import { formatBytes, plural } from '@/utils/date'
import { reportError } from '@/utils/errors'

const version = __APP_VERSION__
const { isStandalone } = usePwa()

const sync = useSyncStore()
const ui = useUiStore()

const usage = ref<UsageInfo | null>(null)
const lastExportAt = ref<string | null>(null)

async function refresh() {
  usage.value = await repository.estimateUsage()
  lastExportAt.value = (await repository.getMeta<string>('lastExportAt')) ?? null
}
onMounted(async () => {
  try {
    await sync.init()
    serverForm.value = initialForm(sync.settings)
    await refresh()
  } catch (e) {
    reportError(e)
  }
})

// --- home server ---
/** The production build is served by the home server itself, so its address is the page's own origin. */
const initialForm = (s: ServerSettings) => ({ ...s, url: s.url || (import.meta.env.PROD ? location.origin : '') })
const serverForm = ref(initialForm(sync.settings))
const checking = ref(false)
const connection = ref<{ ok: boolean; text: string } | null>(null)
const formDirty = computed(
  () =>
    serverForm.value.url.trim() !== sync.settings.url ||
    serverForm.value.token.trim() !== sync.settings.token ||
    serverForm.value.autoUpload !== sync.settings.autoUpload ||
    (serverForm.value.keepOriginalsDays ?? null) !== (sync.settings.keepOriginalsDays ?? null),
)
const keepOptions = [
  { value: null, label: 'Все' },
  { value: 30, label: 'За 30 дней' },
  { value: 90, label: 'За 3 месяца' },
  { value: 180, label: 'За полгода' },
  { value: 365, label: 'За год' },
]
const mixedContent = computed(() => isMixedContent(serverForm.value.url.trim()))

async function checkServer() {
  checking.value = true
  connection.value = null
  try {
    const info = await sync.testConnection(serverForm.value)
    connection.value = { ok: true, text: `Соединение есть${info.name ? `: ${info.name}` : ''}` }
  } catch (e) {
    connection.value = { ok: false, text: e instanceof ServerError ? e.message : 'Не удалось проверить' }
  } finally {
    checking.value = false
  }
}

async function saveServer() {
  const targetChanged =
    serverForm.value.url.trim() !== sync.settings.url || serverForm.value.token.trim() !== sync.settings.token
  const offloaded = usage.value?.offloadedCount ?? 0
  if (targetChanged && offloaded > 0) {
    const ok = await ui.confirm({
      title: 'Сменить сервер?',
      message: `Оригиналы ${offloaded} фото есть только на текущем сервере. На новый сервер или аккаунт они не попадут, а открыть их можно будет только с текущего.`,
      confirmLabel: 'Сменить',
      danger: true,
    })
    if (!ok) return
  }
  try {
    await sync.saveSettings(serverForm.value)
    serverForm.value = { ...sync.settings }
    ui.showToast(sync.configured ? 'Сервер сохранён' : 'Выгрузка на сервер отключена')
  } catch (e) {
    if (e instanceof ServerError) ui.showToast(e.message, 'error')
    else reportError(e)
  }
}

async function syncNow() {
  try {
    const result = await sync.syncNow()
    if (!result) return
    const summary = `Отправлено: ${result.pushed}, файлов: ${result.files}, получено: ${result.pulled}`
    if (result.failed) ui.showToast(`${summary}, с ошибками: ${result.failed}`, 'error')
    else ui.showToast(result.pushed || result.files || result.pulled ? summary : 'Всё синхронизировано')
  } catch {
    // The message is shown in the section via sync.lastError.
  }
}

async function resyncAll() {
  const ok = await ui.confirm({
    title: 'Синхронизировать всё заново?',
    message:
      'Записи уйдут на сервер повторно, а изменения с сервера будут прочитаны с начала. Файлы, которые уже есть на сервере, повторно не загружаются.',
    confirmLabel: 'Синхронизировать',
  })
  if (!ok) return
  await sync.resyncAll()
  await syncNow()
}

const phaseLabel: Record<SyncPhase, string> = {
  pull: 'Получаю изменения',
  push: 'Отправляю записи',
  files: 'Загружаю файлы',
}

const persistLabel = computed(() => {
  const p = usage.value?.persisted
  if (p === true) return 'Включено'
  if (p === false) return 'Не включено — система может удалить данные при нехватке места'
  return 'Неизвестно'
})

const formatStamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' }) : 'ещё не было'

// --- export ---
const now = new Date()
const period = ref<PeriodKind>('all')
const year = ref(now.getFullYear())
const month = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
const rangeFrom = ref('')
const rangeTo = ref('')

type ExportState =
  | { step: 'idle' }
  | { step: 'building'; part: number; total: number }
  | { step: 'ready'; part: number; total: number; file: File }
  | { step: 'done'; total: number }

const exportState = ref<ExportState>({ step: 'idle' })
let prepared: PreparedExport | null = null

async function startExport() {
  try {
    const { from, to } = periodBounds(period.value, {
      year: year.value,
      month: month.value,
      from: rangeFrom.value,
      to: rangeTo.value,
    })
    prepared = await prepareExport(from, to)
    if (prepared.parts.length === 0) {
      exportState.value = { step: 'idle' }
      alert('За выбранный период записей нет.')
      return
    }
    await buildNext(0)
  } catch (e) {
    exportState.value = { step: 'idle' }
    reportError(e, 'Не удалось подготовить экспорт')
  }
}

async function buildNext(index: number) {
  if (!prepared) return
  const total = prepared.parts.length
  exportState.value = { step: 'building', part: index + 1, total }
  const file = await buildPart(prepared, index)
  // Sharing needs a fresh tap, so each built part waits for the user.
  exportState.value = { step: 'ready', part: index + 1, total, file }
}

async function deliverCurrent() {
  const state = exportState.value
  if (state.step !== 'ready' || !prepared) return
  try {
    const result = await deliverFile(state.file)
    if (result === 'cancelled') return
    if (state.part < state.total) {
      await buildNext(state.part)
    } else {
      await repository.setMeta('lastExportAt', new Date().toISOString())
      exportState.value = { step: 'done', total: state.total }
      prepared = null
      await refresh()
    }
  } catch (e) {
    reportError(e, 'Не удалось сохранить архив')
  }
}

function resetExport() {
  prepared = null
  exportState.value = { step: 'idle' }
}

const parts = (n: number) => `${n} ${plural(n, ['часть', 'части', 'частей'])}`
</script>

<template>
  <AppHeader title="Настройки" back="/" />
  <main class="page">
    <section class="card">
      <h2>Хранилище</h2>
      <dl v-if="usage" class="rows">
        <dt>Записей</dt>
        <dd>{{ usage.entryCount }}</dd>
        <dt>Занято</dt>
        <dd>
          {{ formatBytes(usage.usage) }}
          <span v-if="usage.quota" class="muted">из {{ formatBytes(usage.quota) }}</span>
        </dd>
        <dt>Постоянное хранение</dt>
        <dd>{{ persistLabel }}</dd>
        <template v-if="usage.offloadedCount">
          <dt>Оригиналы только на сервере</dt>
          <dd>{{ usage.offloadedCount }}</dd>
        </template>
      </dl>
      <RouterLink to="/trash" class="link-row">Корзина ›</RouterLink>
    </section>

    <section class="card">
      <h2>Домашний сервер</h2>
      <p class="muted">
        Записи и фото синхронизируются с вашим сервером в аккаунте, которому принадлежит токен: новые уходят на
        сервер, а записи с других устройств приходят сюда. Нужен разрешённый CORS. Очистите адрес, чтобы отключить
        синхронизацию.
      </p>
      <form @submit.prevent="saveServer">
        <label class="field column">
          <span>Адрес сервера</span>
          <input
            v-model="serverForm.url"
            type="url"
            inputmode="url"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="https://diary.home.lan:8443"
          />
        </label>
        <label class="field column">
          <span>Токен доступа</span>
          <input
            v-model="serverForm.token"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Токен аккаунта с сервера"
            :required="!!serverForm.url.trim()"
          />
        </label>
        <label class="field">
          <span>Синхронизировать автоматически</span>
          <input v-model="serverForm.autoUpload" type="checkbox" class="switch" />
        </label>
        <label class="field">
          <span>Оригиналы на устройстве</span>
          <select v-model="serverForm.keepOriginalsDays">
            <option v-for="o in keepOptions" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <p v-if="serverForm.keepOriginalsDays" class="muted">
          Оригиналы старше этого срока удаляются с устройства, когда сервер подтвердит, что они у него есть. На телефоне
          остаётся копия 1080 px, а оригинал открывается только при связи с сервером. Нужна автосинхронизация.
        </p>
        <p v-if="mixedContent" class="warning">
          Приложение открыто по HTTPS, а сервер указан по HTTP — браузер заблокирует такие запросы. Включите HTTPS на
          сервере.
        </p>
        <p v-if="connection" :class="connection.ok ? 'ok' : 'warning'">{{ connection.text }}</p>
        <div class="two">
          <button
            class="btn"
            type="button"
            :disabled="!serverForm.url.trim() || !serverForm.token.trim() || checking"
            @click="checkServer"
          >
            {{ checking ? 'Проверяю…' : 'Проверить' }}
          </button>
          <button class="btn btn-primary" type="submit" :disabled="!formDirty">Сохранить</button>
        </div>
      </form>

      <template v-if="sync.configured">
        <dl class="rows top-gap">
          <dt>Ожидают отправки</dt>
          <dd>{{ sync.pendingCount }}</dd>
          <dt>Последняя синхронизация</dt>
          <dd>{{ formatStamp(sync.lastUploadAt) }}</dd>
        </dl>
        <template v-if="sync.running">
          <progress v-if="sync.progress?.total" :value="sync.progress.done" :max="sync.progress.total" />
          <progress v-else />
          <p v-if="sync.progress" class="muted">
            {{ phaseLabel[sync.progress.phase] }}: {{ sync.progress.done
            }}<template v-if="sync.progress.total !== null"> из {{ sync.progress.total }}</template>…
          </p>
        </template>
        <p v-if="sync.lastError" class="warning">{{ sync.lastError }}</p>
        <ul v-if="sync.lastResult?.errors.length" class="errors">
          <li v-for="(err, i) in sync.lastResult.errors" :key="i">{{ err }}</li>
        </ul>
        <button class="btn btn-primary wide" type="button" :disabled="sync.running || formDirty" @click="syncNow">
          Синхронизировать сейчас
        </button>
        <button class="btn-link wide" type="button" :disabled="sync.running || formDirty" @click="resyncAll">
          Синхронизировать всё заново
        </button>
      </template>
    </section>

    <section class="card">
      <h2>Экспорт в файл (ZIP)</h2>
      <p class="muted">Разовая выгрузка архивом, например в «Файлы» или iCloud Drive.</p>
      <p class="muted">Последний экспорт: {{ formatStamp(lastExportAt) }}</p>
      <p v-if="usage?.offloadedCount" class="muted">
        Для фото, чьи оригиналы только на сервере, в архив попадает копия 1080 px (папка medium).
      </p>
      <p class="warning">
        Удаление иконки с экрана «Домой» удаляет все данные приложения. Держите копию на сервере или в архиве.
      </p>

      <template v-if="exportState.step === 'idle' || exportState.step === 'done'">
        <label class="field">
          <span>Период</span>
          <select v-model="period">
            <option value="all">Всё</option>
            <option value="year">Год</option>
            <option value="month">Месяц</option>
            <option value="range">Диапазон дат</option>
          </select>
        </label>
        <label v-if="period === 'year'" class="field">
          <span>Год</span>
          <input v-model.number="year" type="number" min="2000" max="2100" />
        </label>
        <label v-if="period === 'month'" class="field">
          <span>Месяц</span>
          <input v-model="month" type="month" />
        </label>
        <template v-if="period === 'range'">
          <label class="field">
            <span>С</span>
            <input v-model="rangeFrom" type="date" />
          </label>
          <label class="field">
            <span>По</span>
            <input v-model="rangeTo" type="date" />
          </label>
        </template>
        <p v-if="exportState.step === 'done'" class="muted">Готово: сохранено {{ parts(exportState.total) }}.</p>
        <button class="btn btn-primary wide" type="button" @click="startExport">Экспортировать</button>
      </template>

      <template v-else>
        <progress :value="exportState.part - (exportState.step === 'building' ? 1 : 0)" :max="exportState.total" />
        <p v-if="exportState.step === 'building'" class="muted">
          Собираю часть {{ exportState.part }} из {{ exportState.total }}…
        </p>
        <template v-else>
          <p class="muted">
            Часть {{ exportState.part }} из {{ exportState.total }} готова ({{ formatBytes(exportState.file.size) }}).
            Выберите «Сохранить в Файлы».
          </p>
          <button class="btn btn-primary wide" type="button" @click="deliverCurrent">
            Сохранить часть {{ exportState.part }}
          </button>
        </template>
        <button class="btn wide" type="button" @click="resetExport">Отменить экспорт</button>
      </template>
    </section>

    <section class="card">
      <h2>О приложении</h2>
      <p class="muted">Версия {{ version }} · {{ isStandalone ? 'установлено на экран «Домой»' : 'открыто во вкладке' }}</p>
    </section>
  </main>
</template>

<style scoped>
.rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0 0 8px;
}
dt {
  color: var(--text-2);
}
dd {
  margin: 0;
  text-align: right;
}
.link-row {
  display: block;
  padding: 10px 0 2px;
  text-decoration: none;
  font-weight: 500;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 0;
}
.field select,
.field input {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}
.wide {
  width: 100%;
  margin-top: 8px;
}
.column {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.column span {
  font-size: 15px;
  color: var(--text-2);
}
.switch {
  width: 22px;
  height: 22px;
  min-height: 0;
  accent-color: var(--accent);
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.top-gap {
  margin-top: 16px;
}
.ok {
  color: #248a3d;
  font-size: 15px;
}
progress {
  width: 100%;
  accent-color: var(--accent);
}
.errors {
  margin: 0;
  padding-left: 18px;
  color: var(--danger);
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
