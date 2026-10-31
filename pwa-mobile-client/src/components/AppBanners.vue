<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { usePwa } from '@/composables/usePwa'
import { useUiStore } from '@/stores/ui'

const route = useRoute()
const ui = useUiStore()
const { needRefresh, applyUpdate, dismissUpdate, isStandalone } = usePwa()

// Never offer a reload while the user is shooting or describing a photo.
const busyRoute = computed(() => route.name === 'camera' || route.name === 'new')
const showUpdate = computed(() => needRefresh.value && !busyRoute.value)
const showInstall = computed(() => !isStandalone.value && !ui.installBannerDismissed && !busyRoute.value)
</script>

<template>
  <TransitionGroup name="banner" tag="div" class="banners">
    <div v-if="showUpdate" key="update" class="banner" role="status">
      <span>Доступно обновление</span>
      <span class="actions">
        <button class="btn btn-primary small" type="button" @click="applyUpdate">Обновить</button>
        <button class="btn-link close" type="button" aria-label="Позже" @click="dismissUpdate">✕</button>
      </span>
    </div>
    <div v-if="showInstall" key="install" class="banner" role="note">
      <span>
        Установите на экран «Домой»: «Поделиться» → «На экран „Домой“». Данные из вкладки не перенесутся в
        установленное приложение.
      </span>
      <button class="btn-link close" type="button" aria-label="Скрыть" @click="ui.installBannerDismissed = true">
        ✕
      </button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.banners {
  position: fixed;
  left: calc(12px + var(--safe-left));
  right: calc(12px + var(--safe-right));
  bottom: calc(96px + var(--safe-bottom));
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.banner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  font-size: 15px;
}
.banner-enter-active,
.banner-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s var(--ease-out);
}
.banner-enter-from,
.banner-leave-to {
  opacity: 0;
  transform: translateY(16px);
}
.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.small {
  min-height: 36px;
  padding: 0 12px;
}
.close {
  border: none;
  min-width: 36px;
  min-height: 36px;
  color: var(--text-2);
}
</style>
