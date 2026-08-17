#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Tile-selection DPR / viewport sweep — the deterministic repro that
// identified #1379's mechanism.
// ═══════════════════════════════════════════════════════════════════
//
// #1379 was filed as "tile selection is unstable to sub-degree PITCH changes at
// high pitch", with tables showing the selected count swinging 27 → 9 → 18
// across three 1° steps. It named three candidate mechanisms: sample density,
// the `targetSSE` ramp, or the emitted-tile cap.
//
// It is none of them, and pitch is not the variable. This probe is what settled
// that, and it is kept so the conclusion can be re-derived rather than trusted:
//
//   1. At fixed DPR the selector is essentially MONOTONE in pitch — sweeping
//      41→84° gives 1 decrease in 43 transitions, of magnitude 1.
//   2. `farTargetBoost` is inert below 63° by construction (the `pitchDeg > 60`
//      guard), so it cannot move the reported window at all.
//   3. DPR moves selection by up to 4× (pitch 70: dpr 1 → 26 tiles, dpr 3 →
//      104), and ONE rung of the adaptive ladder does 41 % of it. The repro
//      settled ~1.1 s per pitch step, which is long enough for the
//      adaptive-quality controller to take a notch and change DPR — so the
//      sweep compared scenes at different DPRs and attributed the difference to
//      the 1° step. Same root cause as #1479.
//   4. Selection IS mildly non-monotone in CSS viewport height above 60°
//      (0 decreases at pitch 45, 3-4 at 62-70) — the sample-grid aliasing the
//      issue hypothesised, real but 1-2 tiles, not the reported 3×.
//
// Pure CPU — `visibleTilesSSE` is geometry only, so this needs no archive, no
// GPU and no browser. That is also why #1379 is NOT blocked on the #1349
// fixture work.
//
// THE MEASUREMENT TRAP, recorded because it cost a wrong conclusion here:
// holding the DEVICE canvas fixed while varying `dpr` does not model a DPR
// change. `tiles-sse.ts` derives `cssHeight = canvasHeight / dpr`, so that
// sweep silently varies the CSS VIEWPORT instead (715 px → 1430 px at dpr 0.5).
// A real DPR change scales the device canvas and holds CSS size fixed, which is
// what `select()` below does. The first run of this probe did it the other way
// and produced a plausible, wrong answer.
//
// Invocation:
//   bun scripts/probe-tile-selection-dpr.ts

import { visibleTilesSSE } from '../data/src/tiles-sse'
import { mercator } from '@xgis/geo'
import { Camera } from '../map/src/camera/camera'

/** #1379's reported camera: `physical_map` at #10.35/30.94337/118.42256/356.5. */
const LAT = 30.94337
const LON = 118.42256
const ZOOM = 10.35
const BEARING = 356.5
const CSS_W = 430
const CSS_H = 715
const MAX_Z = 12

type SelectOpts = Parameters<typeof visibleTilesSSE>[7]

/** Primary (non-fallback) selected tiles — what `frameTileCache().tiles`
 *  reports and what the issue's tables counted. Device canvas = CSS × dpr, as
 *  the renderer sizes it. */
function select(pitch: number, dpr = 1, cssH = CSS_H, opts: SelectOpts = {}): number {
  const camera = new Camera(LON, LAT, ZOOM)
  camera.bearing = BEARING
  camera.pitch = pitch
  camera.syncCenterLat()
  const cam = camera as unknown as Parameters<typeof visibleTilesSSE>[0]
  const tiles = visibleTilesSSE(cam, mercator, MAX_Z, CSS_W * dpr, cssH * dpr, 0, dpr, opts)
  return tiles.filter((t) => !t.fallbackOnly).length
}

function countDecreases(counts: number[]): number {
  let n = 0
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[i - 1]) n++
  return n
}

console.log('═══ 1. Pitch sweep at fixed dpr — the axis #1379 blamed ═══')
{
  const counts: number[] = []
  for (let p = 41; p <= 84; p++) counts.push(select(p))
  console.log(`  41→84°: ${countDecreases(counts)} decreases in ${counts.length - 1} transitions`)
  console.log(`  ${counts.join(' ')}`)
}

console.log('\n═══ 2. farTargetBoost at fixed pitch — inert below the 60° guard ═══')
for (const pitch of [45, 60, 62, 63, 70]) {
  const row = [1, 1.5, 2, 3, 4].map((b) =>
    String(select(pitch, 1, CSS_H, { farTargetBoost: b })).padStart(4),
  )
  console.log(`  pitch=${String(pitch).padStart(4)}  boost 1 / 1.5 / 2 / 3 / 4 →${row.join('')}`)
}

console.log('\n═══ 3. TRUE dpr change (CSS size fixed, device canvas scales) ═══')
{
  const dprs = [0.6, 0.7, 0.85, 1, 1.5, 2, 3]
  console.log('  pitch  ' + dprs.map((d) => String(d).padStart(5)).join(''))
  for (const pitch of [45, 62, 70, 82.5]) {
    const counts = dprs.map((d) => select(pitch, d))
    console.log(
      `  ${String(pitch).padStart(5)}  ` +
        counts.map((c) => String(c).padStart(5)).join('') +
        `   span ${(Math.max(...counts) / Math.min(...counts)).toFixed(1)}×`,
    )
  }
}

console.log('\n═══ 4. CSS viewport height at dpr=1 — real, but 1-2 tiles ═══')
for (const pitch of [45, 62, 70]) {
  const hs: number[] = []
  for (let h = 360; h <= 1440; h += 36) hs.push(h)
  const counts = hs.map((h) => select(pitch, 1, h))
  console.log(
    `  pitch=${String(pitch).padStart(3)}  ${countDecreases(counts)} decreases while the viewport GROWS` +
      ` (expected 0):  ${counts.join(' ')}`,
  )
}
