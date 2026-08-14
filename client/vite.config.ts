import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  plugins: [
    vue(),
    // `router: false` because the SPA has no routes: panels are top-level
    // state, and an iframe has no address bar to deep-link into. This also
    // removes the need for an SPA history fallback on the static route.
    ui({ router: false }),
  ],
  // Relative, NOT '/'. The bundle is served from /_concierge/ as Nitro public
  // assets; absolute asset paths would resolve against the host app's root and
  // 404, which presents as a blank panel with no server-side error.
  base: './',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // So `pnpm dev:client` talks to a running `pnpm dev` playground instead
      // of needing a rebuild per CSS change.
      '/_concierge/api': 'http://localhost:3000',
    },
  },
})
