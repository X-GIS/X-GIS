import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath, URL } from 'node:url'
import { openDataBridge } from './dev/opendata-bridge'
import { bakeShadersOnEdit } from './dev/bake-shaders-on-edit'

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
  // bakeShadersOnEdit re-derives the six committed shader artifacts when a file they depend
  // on changes (#2535) — with bake-by-default the page draws the COMMITTED bake, so without
  // it a shader edit is invisible until `bun run build && bun run bake:shaders`. Serve only;
  // off under CI and XGIS_BAKE_HMR=0 (the Playwright webServer).
  plugins: [basicSsl(), openDataBridge(), bakeShadersOnEdit()],
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
  // REJECTED, with its numbers, so it is not re-proposed: `experimental.bundledDev`
  // (Vite 8's full-bundle dev server). It is a large, real speedup — one
  // `demo.html?id=minimal` load on the same machine (SwiftShader, warm server,
  // fresh context) goes from 2 229 module requests / 2 210 ms load / 4 675 ms to
  // `__xgisReady`, down to 26 requests / 955 ms / 2 995 ms, and ten of test.yml's
  // render-gate specs ran 1m39s → 1m10s, 20/20 green.
  //
  // It also BREAKS two of them, and that was found only by running the control
  // arm on the same specs:
  //   _compute-gen-compile-gate — `page.evaluate: Execution context was destroyed,
  //     most likely because of a navigation`. Bundle mode reloads the page (its
  //     HMR granularity is the bundle), and here it did so DURING the test.
  //   _webgl2-live-render-gate — the analytic checker tile read 27/49 texels
  //     against a floor of 29.4. A pixel-count divergence, not a timeout.
  // Both pass unbundled on this exact tree; the third failure in that batch
  // (_demotiles-labels-gl2-gate) fails in BOTH arms for want of network egress
  // and is not evidence either way.
  //
  // So: a mid-test reload and a changed frame, in the configuration every render
  // gate runs through, for a flag upstream marks "highly experimental". Revisit
  // when bundle-mode HMR stops reloading mid-run — the speedup is worth it.
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
