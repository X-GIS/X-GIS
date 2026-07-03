#!/usr/bin/env bun
// Relocation DC=0 differ. Compares two capture dirs produced by
// e2e/_relocation-dc0.spec.ts and reports the per-fixture changed-pixel count (DC).
// A pure source relocation must yield DC=0 for every fixture. On DC>0 it writes a
// diff PNG (red = changed) so the §5 16-split read can localize the regression.
//
//   cd playground && bun _dc0-diff.mjs <baselineDir> <afterDir> [diffOutDir]
//
// Exit 0 iff every fixture DC == 0; exit 1 otherwise.

import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const [baseDir, afterDir, diffOut = 'test-results/relocation-dc0-diff'] = process.argv.slice(2)
if (!baseDir || !afterDir) {
  console.error('usage: bun _dc0-diff.mjs <baselineDir> <afterDir> [diffOutDir]')
  process.exit(2)
}
// Per-pixel match threshold (0..1). 0 = exact. A small value absorbs the curved-globe-rim
// anti-aliasing noise that is non-deterministic even with identical source (≈1200px on the
// orthographic fixture's silhouette) while still catching any real positional/colour shift,
// which on a pure relocation would be gross (a throw or a whole-region move), not sub-AA.
const THRESHOLD = Number(process.env.THRESHOLD ?? 0)
mkdirSync(diffOut, { recursive: true })

const pngs = readdirSync(baseDir)
  .filter((f) => f.endsWith('.png'))
  .sort()
if (pngs.length === 0) {
  console.error(`no PNGs in baseline dir ${baseDir}`)
  process.exit(2)
}

let totalDC = 0
let worst = { name: '', dc: -1 }
const rows = []
for (const f of pngs) {
  const aPath = join(baseDir, f)
  const bPath = join(afterDir, f)
  if (!existsSync(bPath)) {
    rows.push(`MISSING after  ${f}`)
    totalDC += 1
    worst = worst.dc < 1 ? { name: f, dc: Infinity } : worst
    continue
  }
  const a = PNG.sync.read(Buffer.from(await Bun.file(aPath).arrayBuffer()))
  const b = PNG.sync.read(Buffer.from(await Bun.file(bPath).arrayBuffer()))
  if (a.width !== b.width || a.height !== b.height) {
    rows.push(`SIZE-DIFF ${f}: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
    totalDC += 1
    worst = { name: f, dc: Infinity }
    continue
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const dc = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: THRESHOLD })
  totalDC += dc
  if (dc > worst.dc) worst = { name: f, dc }
  rows.push(`${dc === 0 ? 'DC=0  ' : 'DC>0! '} ${basename(f).padEnd(38)} ${dc}`)
  if (dc > 0) writeFileSync(join(diffOut, `diff-${f}`), PNG.sync.write(diff))
}

console.log(rows.join('\n'))
console.log('─'.repeat(52))
console.log(`fixtures=${pngs.length}  totalDC=${totalDC}  worst=${worst.name}:${worst.dc}`)
if (totalDC === 0) {
  console.log('✅ DC=0 — relocation moved zero pixels')
  process.exit(0)
}
console.log(`❌ DC>0 — diffs written to ${diffOut} (read worst tile 16-split per §5)`)
process.exit(1)
