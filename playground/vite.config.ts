import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath, URL } from 'node:url'
import { openDataBridge } from './dev/opendata-bridge'

/** `XGIS_E2E_CHAIN=1` — arm the unified RHI chain for EVERY page this server
 *  serves (#1046 Inc-F2). The WebGL2 chain is opt-in per URL (`?rhichain=1`)
 *  until the twin frame is deleted, but the deletion's fail-before is running
 *  the whole CI `?forcegl2=1` suite on the chain — 22 specs that today verify
 *  the twin only. Rather than edit 22 specs for a check that dies with the
 *  twin, this injects the flag's documented GLOBAL MIRROR
 *  (`globalThis.__xgisRhiChain`, read before the URL by debug-flags.ts) as a
 *  classic inline script, which runs before demo.html's module entry.
 *  Unset (the default, including every normal dev session and CI run) the
 *  plugin injects nothing at all. Dies with the flag in Inc-F3. */
function e2eChainArm(): Plugin {
  return {
    name: 'xgis-e2e-chain-arm',
    transformIndexHtml(html) {
      if (process.env.XGIS_E2E_CHAIN !== '1') return html
      return html.replace('<head>', '<head>\n    <script>globalThis.__xgisRhiChain = true</script>')
    },
  }
}

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
  // openDataBridge serves the whole `/opendata/*` family — the allowlisted AWS Open Data
  // bucket passthrough plus the synthesised S-111/S-102 catalogues — so the live real-data
  // demos stream in dev past the buckets' missing CORS; the hosted site rewrites the same
  // prefix to a CORS-open Worker (loader.ts).
  plugins: [basicSsl(), openDataBridge(), e2eChainArm()],
  // Dev/test resolve @xgis/map to SOURCE, not the published dist.
  // ship-P0 packaging set the package `main`/`exports` to ./dist/index.js for
  // external npm consumers; without this alias the playground (and every e2e
  // spec) would silently bundle a STALE built dist instead of map/src,
  // defeating the real-GPU verification gates. dist is built only for publishing.
  resolve: {
    alias: {
      '@xgis/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
      '@xgis/rhi': fileURLToPath(new URL('../rhi/src/index.ts', import.meta.url)),
      '@xgis/rhi-webgl2': fileURLToPath(new URL('../rhi-webgl2/src/index.ts', import.meta.url)),
      '@xgis/rhi-webgpu': fileURLToPath(new URL('../rhi-webgpu/src/index.ts', import.meta.url)),
      '@xgis/map': fileURLToPath(new URL('../map/src/index.ts', import.meta.url)),
      // More-specific subpath BEFORE the package root (vite matches in order).
      '@xgis/pipeline/gazetteer/kr': fileURLToPath(
        new URL('../pipeline/src/gazetteer/kr.ts', import.meta.url),
      ),
      '@xgis/pipeline': fileURLToPath(new URL('../pipeline/src/index.ts', import.meta.url)),
    },
  },
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
    exclude: [
      '@xgis/compiler',
      '@xgis/blueprint',
      '@xgis/map',
      '@xgis/shader-dsl',
      '@xgis/engine',
      '@xgis/rhi',
      '@xgis/rhi-webgl2',
      '@xgis/rhi-webgpu',
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        demo: 'demo.html',
        compare: 'compare.html',
        debugLabels: 'debug-labels.html',
        seoulArcHero: 'seoul-arc-hero.html',
        seoulOdbHero: 'seoul-odb-hero.html',
        seoulArcMultiday: 'seoul-arc-multiday.html',
      },
    },
  },
})
