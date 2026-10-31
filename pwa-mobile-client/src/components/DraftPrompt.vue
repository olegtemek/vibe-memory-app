<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { repository } from '@/storage/repository'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const route = useRoute()
const router = useRouter()
const visible = ref(false)

onMounted(async () => {
  if (ui.draftPromptHandled) return
  ui.draftPromptHandled = true
  await router.isReady()
  // On /new the draft is already in front of the user.
  if (route.name === 'new') return
  if (await repository.getDraft()) visible.value = true
})

function open() {
  visible.value = false
  router.push('/new')
}

async function discard() {
  visible.value = false
  await repository.deleteDraft()
}
</script>

<template>
  <Transition name="dialog">
    <div v-if="visible" class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="draft-title">
        <h2 id="draft-title">Несохранённый снимок</h2>
        <p class="muted">В прошлый раз снимок остался несохранённым. Сохранить его?</p>
        <div class="buttons">
          <button class="btn btn-primary" type="button" @click="open">Открыть и сохранить</button>
          <button class="btn btn-danger" type="button" @click="discard">Удалить</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--overlay);
}
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-enter-active .dialog,
.dialog-leave-active .dialog {
  transition: transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .dialog,
.dialog-leave-to .dialog {
  transform: scale(0.92);
}
.dialog {
  width: min(360px, 100%);
  padding: 20px;
  border-radius: 16px;
  background: var(--surface);
}
h2 {
  margin: 0 0 8px;
  font-size: 19px;
}
.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
</style>
