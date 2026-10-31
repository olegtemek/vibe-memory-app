<script setup lang="ts">
import { useRouter } from 'vue-router'

const props = defineProps<{ title?: string; back?: string | boolean }>()
const router = useRouter()

function goBack() {
  if (typeof props.back === 'string') router.push(props.back)
  else if (window.history.state?.back) router.back()
  else router.push('/')
}
</script>

<template>
  <header class="header">
    <div class="side">
      <button v-if="back" class="btn-link back" type="button" aria-label="Назад" @click="goBack">‹ Назад</button>
      <slot name="left" />
    </div>
    <h1 class="title">{{ title }}</h1>
    <div class="side right"><slot name="right" /></div>
  </header>
</template>

<style scoped>
.header {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 10;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  height: calc(var(--header-h) + var(--safe-top));
  padding: var(--safe-top) calc(8px + var(--safe-right)) 0 calc(8px + var(--safe-left));
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border);
}
.title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side {
  display: flex;
  align-items: center;
}
.right {
  justify-content: flex-end;
}
.back {
  border: none;
  min-height: 44px;
  font-size: 17px;
}
</style>
