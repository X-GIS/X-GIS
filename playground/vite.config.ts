import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // Pages-deploy serves the playground under /X-GIS/play/ so the
  // marketing site (Astro) can occupy /X-GIS/ root. Local dev keeps
  // the bare `/` so existing https://localhost:3000/demo.html paths
  // in e2e specs and the README still resolve without rewrites.
  // `XGIS_DEPLOY_BASE=1` is set ONLY by deploy-pages.yml's build step;
  // other CI workflows (playground-audit.yml) leave it unset so they
  // serve at `/` and the e2e specs' hard-coded URLs work as-is. Using
  // the generic `GITHUB_ACTIONS` flag here previously broke every CI
  // playwright run because GitHub auto-sets it for ALL CI jobs.
  base: process.env.XGIS_DEPLOY_BASE === '1' ? '/X-GIS/play/' : '/',
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
    exclude: ['@xgis/compiler', '@xgis/blueprint', '@xgis/runtime'],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        demo: 'demo.html',
        compare: 'compare.html',
      },
    },
  },
})
