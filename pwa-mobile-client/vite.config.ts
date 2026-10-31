/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// HTTPS for testing the camera on a phone (HTTPS=1, see the dev:https / preview:https scripts).
// Requires certs/cert.pem + certs/key.pem (e.g. from mkcert, trusted on the device).
const useHttps = process.env.HTTPS === '1'
const certFile = new URL('./certs/cert.pem', import.meta.url)
const keyFile = new URL('./certs/key.pem', import.meta.url)
if (useHttps && !(existsSync(certFile) && existsSync(keyFile))) {
  throw new Error('HTTPS=1 needs certs/cert.pem and certs/key.pem (see README)')
}
const https = useHttps ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined

export default defineConfig({
  server: { https },
  preview: { https },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.png'],
      manifest: {
        name: 'vibe-memory',
        short_name: 'vibe-memory',
        description: 'Офлайн фотодневник',
        lang: 'ru',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#1c1c1e',
        background_color: '#1c1c1e',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
