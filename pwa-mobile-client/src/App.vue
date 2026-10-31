<script setup lang="ts">
import AppBanners from '@/components/AppBanners.vue'
import DraftPrompt from '@/components/DraftPrompt.vue'
import ConfirmHost from '@/components/ConfirmHost.vue'
import ToastHost from '@/components/ToastHost.vue'
import { onMounted } from 'vue'
import { repository } from '@/storage/repository'
import { useSyncStore } from '@/stores/sync'

const sync = useSyncStore()
onMounted(() => {
  sync.init().catch((e) => console.error(e))
  // Every launch: without it iOS may clear the photos not yet on the server when space runs low.
  repository.ensurePersisted().catch(() => undefined)
})
</script>

<template>
  <RouterView v-slot="{ Component, route }">
    <KeepAlive include="FeedView">
      <component :is="Component" :key="route.name === 'entry' || route.name === 'feed' ? String(route.name) : route.fullPath" />
    </KeepAlive>
  </RouterView>
  <AppBanners />
  <DraftPrompt />
  <ToastHost />
  <ConfirmHost />
</template>
