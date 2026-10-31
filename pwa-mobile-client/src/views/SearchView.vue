<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import SyncBadge from '@/components/SyncBadge.vue'
import ThumbImage from '@/components/ThumbImage.vue'
import { useServerStatusRefresh } from '@/composables/useServerStatusRefresh'
import { repository } from '@/storage/repository'
import type { Entry } from '@/storage/types'
import { formatDayTitle, plural } from '@/utils/date'
import { reportError } from '@/utils/errors'
import { normalizeTag } from '@/utils/tags'
import { isOnServer } from '@/sync/status'

const route = useRoute()
const router = useRouter()

/** Searched tag lives in ?tag= so the back button from a photo returns to the results. */
const tag = computed(() => (typeof route.query.tag === 'string' ? normalizeTag(route.query.tag) : ''))
const query = ref(tag.value ? `#${tag.value}` : '')
const tags = ref<Array<{ tag: string; count: number }>>([])
const results = ref<Entry[]>([])
const loaded = ref(false)

/** Known tags matching what is typed, to pick from. */
const suggestions = computed(() => {
  const q = normalizeTag(query.value)
  return q ? tags.value.filter((t) => t.tag.includes(q)) : tags.value
})

onMounted(async () => {
  try {
    tags.value = await repository.listTags()
  } catch (e) {
    reportError(e, 'Не удалось загрузить теги')
  }
})

watch(
  tag,
  async (value) => {
    query.value = value ? `#${value}` : query.value
    loaded.value = false
    results.value = []
    if (!value) return
    try {
      results.value = await repository.searchByTag(value)
    } catch (e) {
      reportError(e, 'Не удалось выполнить поиск')
    } finally {
      loaded.value = true
    }
  },
  { immediate: true },
)

useServerStatusRefresh(async () => {
  if (tag.value) results.value = await repository.searchByTag(tag.value).catch(() => results.value)
})

function search(value: string) {
  const t = normalizeTag(value)
  router.replace({ name: 'search', query: t ? { tag: t } : {} })
}

function clear() {
  query.value = ''
  search('')
}

const photoWord = (n: number) => `${n} ${plural(n, ['фото', 'фото', 'фото'])}`
</script>

<template>
  <AppHeader title="Поиск по тегам" back="/" />
  <main class="page">
    <form class="search" role="search" @submit.prevent="search(query)">
      <input
        v-model="query"
        class="input"
        type="search"
        enterkeyhint="search"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        placeholder="#sport"
        aria-label="Тег"
      />
      <button v-if="tag" class="btn-link" type="button" @click="clear">Сброс</button>
    </form>

    <template v-if="!tag">
      <p v-if="tags.length === 0" class="muted hint">
        Добавьте в комментарий к фото теги, например #sport #street, и ищите по ним здесь.
      </p>
      <div v-else class="chips">
        <button v-for="t in suggestions" :key="t.tag" class="chip" type="button" @click="search(t.tag)">
          #{{ t.tag }} <span class="chip-count">{{ t.count }}</span>
        </button>
        <p v-if="suggestions.length === 0" class="muted">Таких тегов нет. Нажмите «Ввод», чтобы искать всё равно.</p>
      </div>
    </template>

    <template v-else>
      <p v-if="loaded && results.length === 0" class="muted hint">С тегом #{{ tag }} фотографий нет.</p>
      <p v-else-if="results.length" class="muted count">#{{ tag }}: {{ photoWord(results.length) }}</p>
      <div class="gallery">
        <RouterLink
          v-for="(e, i) in results"
          :key="e.id"
          :to="`/entry/${e.id}`"
          class="cell"
          :style="{ animationDelay: `${Math.min(i, 12) * 30}ms` }"
        >
          <ThumbImage :hash="e.thumbHash" :alt="e.comment" />
          <SyncBadge :on-server="isOnServer(e)" />
          <span class="date">{{ formatDayTitle(e.dayKey).split(',')[0] }}</span>
        </RouterLink>
      </div>
    </template>
  </main>
</template>

<style scoped>
.page {
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px;
}
.input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 17px;
}
.btn-link {
  border: none;
  min-height: 40px;
}
.hint {
  margin: 12px 16px;
  text-align: center;
  padding-top: 12vh;
}
.count {
  margin: 12px 16px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 16px;
}
.chip {
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 15px;
}
.chip:active {
  opacity: 0.7;
}
.chip-count {
  color: var(--text-2);
  font-size: 13px;
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
.date {
  position: absolute;
  left: 6px;
  bottom: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}
</style>
