#!/usr/bin/env bun
// Directional capture diff for the #1427 far-plane cull verification.
//
// Reads two capture directories written by
// `playground/e2e/_debug-liberty-farplane-cull.spec.ts` and, for every PNG
// they share, reports the differing-pixel ratio and mean absolute channel
// delta, plus a per-16th (4x4) breakdown so a localised change cannot hide
// inside a whole-frame average. Also writes an amplified diff image per pair
// so the difference can be READ at full resolution rather than inferred from
// a scalar.
//
// Invocation:
//   bun scripts/diff-captures.ts <dirA> <dirB> [outDir]

import { readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const [dirA, dirB, outDir] = process.argv.slice(2)
if (!dirA || !dirB) {
  console.error('usage: bun scripts/diff-captures.ts <dirA> <dirB> [outDir]')
  process.exit(2)
}
const out = outDir ?? join(dirA, '..', `diff-${dirA.split('/').pop()}-vs-${dirB.split('/').pop()}`)
mkdirSync(out, { recursive: true })

/** Per-channel delta above which a pixel counts as "different" — above
 *  8-bit rounding and the software rasteriser's dithering, below any real
 *  content change. */
const CHANNEL_EPS = 8

const names = readdirSync(dirA).filter((f) => f.endsWith('.png'))
let worst = 0

for (const name of names) {
  let a: PNG, b: PNG
  try {
    a = PNG.sync.read(readFileSync(join(dirA, name)))
    b = PNG.sync.read(readFileSync(join(dirB, name)))
  } catch {
    console.log(`${name}: MISSING in one side — skipped`)
    continue
  }
  // The compare harness's two panes can differ by a pixel of layout rounding
  // (639 vs 640 wide); diff the shared top-left region rather than refusing,
  // and say so, since a 1-column shortfall is not what the gate is about.
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`  (size ${a.width}x${a.height} vs ${b.width}x${b.height} — diffing the overlap)`)
  }
  const W = Math.min(a.width, b.width)
  const H = Math.min(a.height, b.height)
  const diff = new PNG({ width: W, height: H })
  // 4x4 tile grid — index = (row * 4 + col).
  const cellDiff = new Array<number>(16).fill(0)
  const cellTotal = new Array<number>(16).fill(0)
  let differing = 0
  let sumAbs = 0

  for (let y = 0; y < H; y++) {
    const row = Math.min(3, Math.floor((y * 4) / H))
    for (let x = 0; x < W; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      const i = (y * W + x) * 4
      const dr = Math.abs(a.data[ia]! - b.data[ib]!)
      const dg = Math.abs(a.data[ia + 1]! - b.data[ib + 1]!)
      const db = Math.abs(a.data[ia + 2]! - b.data[ib + 2]!)
      const m = Math.max(dr, dg, db)
      sumAbs += (dr + dg + db) / 3
      const cell = row * 4 + Math.min(3, Math.floor((x * 4) / W))
      cellTotal[cell]!++
      if (m > CHANNEL_EPS) {
        differing++
        cellDiff[cell]!++
      }
      // Amplified so a small-but-real delta is legible at full resolution.
      const amp = Math.min(255, m * 8)
      diff.data[i] = amp
      diff.data[i + 1] = amp > CHANNEL_EPS * 8 ? 0 : amp
      diff.data[i + 2] = amp > CHANNEL_EPS * 8 ? 0 : amp
      diff.data[i + 3] = 255
    }
  }

  const px = W * H
  const ratio = (differing / px) * 100
  worst = Math.max(worst, ratio)
  writeFileSync(join(out, name), PNG.sync.write(diff))

  const cells = cellDiff
    .map((d, i) => ({ i, pct: (d / cellTotal[i]!) * 100 }))
    .sort((p, q) => q.pct - p.pct)
    .slice(0, 4)
    .map((c) => `#${c.i}:${c.pct.toFixed(2)}%`)
    .join(' ')
  console.log(
    `${name.padEnd(12)} differing=${ratio.toFixed(3)}%  meanAbs=${(sumAbs / px).toFixed(3)}` +
      `  worst16ths ${cells}`,
  )
}

console.log(`\nworst differing ratio: ${worst.toFixed(3)}%   diff images -> ${out}`)
