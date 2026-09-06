// Declaration-bundle WRITE pass for @xgis/map.
//
// Run after `vite build` (see the package `build` script). The bundling itself
// lives in ./dts-bundle.ts, shared with the published-surface gate so the file
// that ships and the file that is gated are the same bytes.

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundlePublicDts } from './dts-bundle'

const out = fileURLToPath(new URL('../dist/index.d.ts', import.meta.url))
await writeFile(out, await bundlePublicDts())
console.log('[build-dts] wrote dist/index.d.ts')
