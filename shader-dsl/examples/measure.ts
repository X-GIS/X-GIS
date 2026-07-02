// ═══ @xgis/shader-dsl examples — optimizer measurement report ═══
//
// "Measure, don't guess." Prints, per example, what the optimizer (O2) removes versus
// the naive emit (O0) on both axes — OP COUNT (the GPU-work proxy the optimizer
// minimises) and SOURCE SIZE (the compile-time proxy, which CSE can legitimately GROW).
//
//   npx tsx examples/measure.ts            # every example
//   npx tsx examples/measure.ts hillshade  # just one
//
// (or `bunx tsx …`). Reads the same example MODULES the site/printer use.

import { examples } from './index.ts'
import { optimizerReport } from '../src/dev.ts'

const want = process.argv[2]
const selected = want ? examples.filter((e) => e.id === want) : examples
if (want && selected.length === 0) {
  console.error(`unknown example '${want}'. known: ${examples.map((e) => e.id).join(', ')}`)
  process.exit(1)
}

const pad = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)

console.log('optimizer effect — O0 (naive) → O2 (shipped). ops = GPU work (always minimised); chars/lines = source size (CSE can GROW it).\n')
console.log(
  pad('example', 18) + padL('calls O0→O2', 14) + padL('arith O0→O2', 14) + padL('ops saved', 11) + padL('chars O0→O2', 16) + padL('lines O0→O2', 14),
)
console.log('─'.repeat(87))

for (const ex of selected) {
  const r = optimizerReport(ex.module)
  const opsSaved = r.ops.savedCalls + r.ops.savedArith
  console.log(
    pad(ex.id, 18) +
      padL(`${r.ops.o0.calls}→${r.ops.o2.calls}`, 14) +
      padL(`${r.ops.o0.arith}→${r.ops.o2.arith}`, 14) +
      padL(String(opsSaved), 11) +
      padL(`${r.size.o0.chars}→${r.size.o2.chars}`, 16) +
      padL(`${r.size.o0.lines}→${r.size.o2.lines}`, 14),
  )
}
