<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { acquireUrl, releaseUrl } from '@/composables/objectUrlCache'

const props = defineProps<{ hash: string; alt?: string }>()
const root = ref<HTMLElement | null>(null)
const url = ref<string>()
const loaded = ref(false)
let held = false
let observer: IntersectionObserver | null = null

async function load() {
  if (held) return
  held = true
  url.value = await acquireUrl(props.hash)
  if (!held) releaseUrl(props.hash)
}

function unload() {
  if (!held) return
  held = false
  url.value = undefined
  loaded.value = false
  releaseUrl(props.hash)
}

onMounted(() => {
  // Object URLs exist only for thumbnails near the viewport.
  observer = new IntersectionObserver(
    ([entry]) => (entry?.isIntersecting ? load() : unload()),
    { rootMargin: '400px 0px' },
  )
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  unload()
})
</script>

<template>
  <div ref="root" class="thumb">
    <img
      v-if="url"
      class="reveal"
      :class="{ loaded }"
      :src="url"
      :alt="alt ?? ''"
      decoding="async"
      draggable="false"
      @load="loaded = true"
    />
  </div>
</template>

<style scoped>
.thumb {
  position: relative;
  aspect-ratio: 1;
  background: var(--surface-2);
  overflow: hidden;
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
