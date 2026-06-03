// Declaration-bundle pass for @xgis/runtime.
//
// Run after `vite build` (see the package `build` script). Emits a single
// dist/index.d.ts in which the bundled-in @xgis/shared and @xgis/compiler
// types are INLINED. Plain `tsc` would instead leave them as
// `import('@xgis/compiler').Foo` references, which do not resolve for a
// consumer (the published tarball does not ship @xgis/compiler). The runtime
// tsconfig's `paths` mapping points those specifiers at the compiler/shared
// built .d.ts, so rollup-plugin-dts follows and folds them in.
//
// Invoked via the rollup JS API from `bun` (which executes this TS file
// directly), avoiding a `rollup` CLI / `@rollup/plugin-typescript` config
// dependency.

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'

// The genuine third-party deps stay as bare external imports so the
// consumer's own @types / shipped types resolve them.
const EXTERNAL = ['earcut', 'proj4', 'pmtiles', 'pbf', '@mapbox/vector-tile']

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

const bundle = await rollup({
  input: here('../src/index.ts'),
  external: (id) =>
    EXTERNAL.includes(id) || EXTERNAL.some((d) => id.startsWith(d + '/')),
  plugins: [
    dts({
      tsconfig: here('../tsconfig.json'),
      respectExternal: false,
    }),
  ],
})

const { output } = await bundle.generate({ format: 'es' })

await bundle.close()

// The shipped declarations reference ambient WebGPU globals (GPUDevice,
// GPUBuffer, …). Prepend a triple-slash reference so a strict consumer
// (skipLibCheck:false, no @webgpu/types of their own) pulls the ambient
// globals transitively from our `@webgpu/types` dependency.
const BANNER = '/// <reference types="@webgpu/types" />\n'
const code = output[0].code

await writeFile(here('../dist/index.d.ts'), BANNER + code)
console.log('[build-dts] wrote dist/index.d.ts')
