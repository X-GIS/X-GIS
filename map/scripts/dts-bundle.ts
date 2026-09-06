// The single authority for @xgis/map's published declaration bundle.
//
// Two callers need these exact bytes: `build-dts.ts`, which writes them to
// dist/index.d.ts, and `scripts/map-public-surface.test.ts`, which reads the
// published surface out of them. A second rollup config would be a second
// authority over what "published" means, and the two would drift (§12) — so the
// bundling lives here and both import it.

import { fileURLToPath } from 'node:url'
import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'

// The genuine third-party deps stay as bare external imports so the
// consumer's own @types / shipped types resolve them.
const EXTERNAL = ['earcut', 'proj4', 'pmtiles', 'pbf', '@mapbox/vector-tile']

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// The shipped declarations reference ambient WebGPU globals (GPUDevice,
// GPUBuffer, …). Prepend a triple-slash reference so a strict consumer
// (skipLibCheck:false, no @webgpu/types of their own) pulls the ambient
// globals transitively from our `@webgpu/types` dependency.
const BANNER = '/// <reference types="@webgpu/types" />\n'

/** The `.d.ts` inputs the bundle folds in. map's tsconfig `paths` points the
 *  `@xgis/*` specifiers at these, so a missing one fails inside rollup with a
 *  resolution error that names a specifier rather than a build step. Callers
 *  check this list first so the message can name `bun run build` instead. */
export const SIBLING_DTS = [
  '../../rhi/dist/index.d.ts',
  '../../rhi-webgpu/dist/index.d.ts',
  '../../rhi-webgl2/dist/index.d.ts',
  '../../engine/dist/index.d.ts',
  '../../geo/dist/index.d.ts',
  '../../compiler/dist/index.d.ts',
  '../../shared/dist/index.d.ts',
  '../../shader-dsl/dist/index.d.ts',
].map(here)

/** Bundle `src/public.ts` into one declaration file with the `@xgis/*` types
 *  (data, geo, engine, rhi*, compiler, shader-dsl, shared) INLINED. Plain `tsc`
 *  would leave them as `import('@xgis/compiler').Foo` references, which do not
 *  resolve for a consumer — the published tarball ships none of those private
 *  packages.
 *
 *  Invoked through the rollup JS API from `bun` (which executes this TS file
 *  directly), avoiding a `rollup` CLI / `@rollup/plugin-typescript` dependency. */
export async function bundlePublicDts(tsconfig = here('../tsconfig.json')): Promise<string> {
  const bundle = await rollup({
    input: here('../src/public.ts'),
    external: (id) => EXTERNAL.includes(id) || EXTERNAL.some((d) => id.startsWith(d + '/')),
    plugins: [dts({ tsconfig, respectExternal: false })],
  })
  const { output } = await bundle.generate({ format: 'es' })
  await bundle.close()
  return BANNER + output[0].code
}
