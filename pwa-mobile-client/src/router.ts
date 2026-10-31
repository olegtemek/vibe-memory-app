import { createRouter, createWebHistory } from 'vue-router'
import FeedView from '@/views/FeedView.vue'

// The future server must serve index.html for unknown paths (history mode).
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'feed', component: FeedView },
    { path: '/months', name: 'months', component: () => import('@/views/MonthsView.vue') },
    { path: '/day/:dayKey(\\d{4}-\\d{2}-\\d{2})', name: 'day', component: () => import('@/views/DayView.vue'), props: true },
    { path: '/camera', name: 'camera', component: () => import('@/views/CameraView.vue') },
    { path: '/new', name: 'new', component: () => import('@/views/NewEntryView.vue') },
    { path: '/entry/:id', name: 'entry', component: () => import('@/views/EntryView.vue'), props: true },
    { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/trash', name: 'trash', component: () => import('@/views/TrashView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})
