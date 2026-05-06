import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // CI deploys the playground under /X-GIS/play/ so the marketing
  // site (Astro) can occupy /X-GIS/ root. Local dev keeps the bare `/`
  // so the existing https://localhost:3000/demo.html paths in e2e
  // specs and the README still resolve without rewrites.
  base: process.env.GITHUB_ACTIONS ? '/X-GIS/play/' : '/',
  plugins: [basicSsl()],
  server: {
    port: 3000,
    host: true,
    watch: { followSymlinks: true },
    // CORS proxy for third-party PMTiles archives that don't set
    // Access-Control-Allow-Origin (e.g., demo-bucket.protomaps.com).
    // Use https://localhost:3000/pmtiles-proxy/protomaps/v4.pmtiles in
    // .xgis sources during dev. Production deployments must serve
    // archives from a CORS-enabled origin (most CDNs handle this; the
    // protomaps demo bucket is a known exception).
    proxy: {
      '/pmtiles-proxy/protomaps': {
        target: 'https://demo-bucket.protomaps.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pmtiles-proxy\/protomaps/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@xgis/compiler', '@xgis/runtime'],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        demo: 'demo.html',
      },
    },
  },
})
