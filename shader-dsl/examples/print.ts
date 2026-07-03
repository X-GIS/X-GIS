// ═══ @xgis/shader-dsl examples — CLI printer ═══
//
// Prints each example's emitted WGSL (+ GLSL ES 3.00 for the WebGL2-renderable ones) and
// its pipeline Reflection. Run all, or one by id:
//
//   npx tsx examples/print.ts            # every example
//   npx tsx examples/print.ts hillshade  # just one
//
// (or `bunx tsx …`). This is the node entry; the runnable example MODULES live in their
// own files (browser-safe), so the site imports the same source this prints.

import { examples } from './index.ts'
import { emitModule, emitGlslModule, reflect } from '../src/index.ts'

const want = process.argv[2]
const selected = want ? examples.filter((e) => e.id === want) : examples
if (want && selected.length === 0) {
  console.error(`unknown example '${want}'. known: ${examples.map((e) => e.id).join(', ')}`)
  process.exit(1)
}

for (const ex of selected) {
  console.log(`\n══════ ${ex.id} — ${ex.title} (${ex.category}) ══════`)
  console.log('\n=== WGSL ===\n' + emitModule(ex.module))
  if (ex.renderable) {
    console.log('\n=== GLSL ES 3.00 — VERTEX (WebGL2) ===\n' + emitGlslModule(ex.module, 'vertex'))
    console.log(
      '\n=== GLSL ES 3.00 — FRAGMENT (WebGL2) ===\n' + emitGlslModule(ex.module, 'fragment'),
    )
  }
  console.log('\n=== Reflection ===\n' + JSON.stringify(reflect(ex.module), null, 2))
}
