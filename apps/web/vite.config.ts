import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // The manifest lives as a static file in public/ and index.html links
      // it and registers the worker itself, so the plugin only builds sw.js.
      manifest: false,
      injectRegister: null,
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // The SPA fallback must never swallow backend routes.
        navigateFallbackDenylist: [/^\/api\//],
        // Web-push + notificationclick handlers for the notification engine.
        importScripts: ['/push-sw.js'],
      },
    }),
  ],
  resolve: {
    alias: {
      // Consume the shared contracts straight from source (same as the
      // tsconfig path alias) so no prebuild step is needed.
      '@plaudern/contracts': fileURLToPath(
        new URL('../../libs/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
