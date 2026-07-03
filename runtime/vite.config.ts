import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Library build for @xgis/runtime.
//
// What this produces (dist/):
//   - index.js          ESM entry (the public barrel, src/index.ts)
//   - *.js worker chunks emitted by Vite's worker graph (the data/workers
//     pools use `?worker` + `new Worker(new URL(...), import.meta.url)`)
//   - .d.ts             bundled separately by the rollup-plugin-dts pass
//     (see vite.dts.config.ts), run after this from the `build` script.
//
// Bundled IN (not external): @xgis/shared + @xgis/compiler. They are
// private/unpublished workspace packages, so their *source* is pulled into
// the runtime bundle. Vite resolves the bare `@xgis/*` specifiers through the
// workspace symlinks (their package.json `main`/`exports` point at src), so
// no alias is needed — they simply are not marked external below.
//
// Kept EXTERNAL (declared in package.json "dependencies"): the genuine
// third-party libraries. earcut/proj4/pmtiles are imported directly by the
// runtime; pbf + @mapbox/vector-tile are imported by the bundled-in compiler.
const EXTERNAL = ['earcut', 'proj4', 'pmtiles', 'pbf', '@mapbox/vector-tile']

export default defineConfig({
  // Emit asset/worker URLs as relative-to-the-module (resolved against
  // import.meta.url) rather than root-absolute "/assets/...". Without this a
  // consumer who installs the package under node_modules would have the
  // worker chunks 404 (they'd be looked up at the site root, not next to the
  // installed dist). With base:'./', Vite rewrites them to
  // `new URL("./assets/...", import.meta.url)` which resolves correctly
  // wherever the package lives.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // Externalise the real npm deps (and any of their subpaths) so the
      // consumer resolves them from their own node_modules. Everything else
      // — including the @xgis/* workspace source and the worker chunks — is
      // bundled into dist.
      external: (id) => EXTERNAL.includes(id) || EXTERNAL.some((d) => id.startsWith(d + '/')),
      output: {
        // Keep worker chunks as stable sibling files in dist so they resolve
        // for ESM consumers and re-bundlers alike.
        entryFileNames: 'index.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  // Vite's worker build inherits the same externals + es format so the
  // worker chunks don't re-inline a second copy of the external deps.
  worker: {
    format: 'es',
    rollupOptions: {
      external: (id) => EXTERNAL.includes(id) || EXTERNAL.some((d) => id.startsWith(d + '/')),
    },
  },
})
