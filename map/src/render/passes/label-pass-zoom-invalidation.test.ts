// ═══ #1434 — a stride-doubling boundary crossed inside the S16 tolerant-zoom window ═══
//
// The #1177 Option B skip replays the prepared label set across small zoom drift
// (|zoom - preparedZoom| <= 0.15) so wheel-zoom doesn't force a re-collation every frame.
// The coverage-sounding producer (coverage-sounding-anchors.ts) picks a POWER-OF-TWO stride
// from `spacingPx / pxPerCell` — a value that changes CONTINUOUSLY with zoom but is rounded
// to a stride that changes DISCONTINUOUSLY at each doubling boundary. A zoom drift that stays
// inside the ±0.15 tolerance can still straddle one of those boundaries, in which case the
// replayed set no longer matches the grid at the new scale (the reported lag). The fix
// (dispatch-coverage-soundings.ts `soundingStrideInvalidates`) predicts the boundary crossing
// closed-form from the ratio recorded at prepare time and forces a miss when it fires — ONLY
// for the coverage-sounding arm; every other producer (`preparedStrideWant` NaN) is untouched.
//
// Three layers, cheapest first:
//   1. `soundingStrideInvalidates` — the pure predicate, driven directly (no camera/host
//      needed). This is the fail-before: the SAME +0.1 zoom drift (inside the #1177 window)
//      both fails to invalidate a non-crossing case and DOES invalidate a crossing one, and a
//      hand-checked "old `_camSame`" (no stride term) would have replayed the crossing case —
//      that is the bug this closes.
//   2. `coverageSoundingAnchors` / `dispatchCoverageSoundings` — the RAW ratio the predicate
//      needs is actually threaded out of the producer, not just asserted in isolation.
//   3. label-pass.ts source-text structure — the predicate is actually wired into the
//      zoomActive tolerant arm and the skip-state read/write sites, in the established
//      structural-wiring style (label-pass-replay-wiring.test.ts): a full LabelPass.execute()
//      drive needs the whole device/collision/atlas surface, which this file doesn't stand up.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { coverageFromGrids, type CoverageHandle } from '@xgis/data'
import type { LabelDef } from '@xgis/compiler'
import {
  coverageSoundingAnchors,
  quantiseStride,
  SOUNDING_LATTICE_CSS_PX,
} from '../../coverage-sounding-anchors'
import { dispatchCoverageSoundings, soundingStrideInvalidates } from './dispatch-coverage-soundings'

// ── Layer 1: soundingStrideInvalidates — pure predicate, fail-before derivation ──────────────

describe('soundingStrideInvalidates — fail-before derivation (#1434)', () => {
  // quantiseStride rounds log2(want) to the nearest integer, so its k/k+1 boundary sits at
  // want = 2^(k+0.5); sqrt(2) is that boundary for k=0 (stride 1 <-> stride 2).
  const BOUNDARY = Math.SQRT2

  it('a +0.1 zoom (inside the #1177 ±0.15 window) that CROSSES a boundary invalidates — the OLD tolerant compare had no stride term and would have replayed it (the reported lag)', () => {
    const preparedWant = BOUNDARY + 0.01 // stride-2 side, just above the boundary
    const dzoom = 0.1
    expect(Math.abs(dzoom)).toBeLessThanOrEqual(0.15) // squarely inside the #1177 window
    expect(quantiseStride(preparedWant)).toBe(2)
    const wantNow = preparedWant * 2 ** -dzoom
    expect(quantiseStride(wantNow)).toBe(1) // crossed down to stride 1 — a different cell set
    expect(soundingStrideInvalidates(preparedWant, dzoom)).toBe(true)
  })

  it('the SAME +0.1 magnitude that does NOT cross a boundary still hits — non-vacuous both ways', () => {
    const preparedWant = 1.6 // well inside the stride-2 bucket, same side as the case above
    const dzoom = 0.1
    expect(quantiseStride(preparedWant)).toBe(2)
    const wantNow = preparedWant * 2 ** -dzoom
    expect(quantiseStride(wantNow)).toBe(2) // still stride 2 — same cell set
    expect(soundingStrideInvalidates(preparedWant, dzoom)).toBe(false)
  })

  it('a zoom-OUT crossing (want growing past the boundary) also invalidates — the predicate has no directional blind spot', () => {
    const preparedWant = BOUNDARY - 0.01 // stride-1 side, just below the boundary
    const dzoom = -0.1
    expect(quantiseStride(preparedWant)).toBe(1)
    const wantNow = preparedWant * 2 ** -dzoom
    expect(quantiseStride(wantNow)).toBe(2)
    expect(soundingStrideInvalidates(preparedWant, dzoom)).toBe(true)
  })

  it('NaN preparedWant (no coverage-sounding show at prepare time) never invalidates — every other #1177 producer keeps the old tolerant behaviour byte-identically', () => {
    expect(soundingStrideInvalidates(NaN, 0.1)).toBe(false)
    expect(soundingStrideInvalidates(NaN, -0.15)).toBe(false)
    expect(soundingStrideInvalidates(NaN, 5)).toBe(false) // even far outside any real drift
  })
})

// ── Layer 2: the raw ratio is actually threaded out of the producer ──────────────────────────

/** A flat, all-valid 40×40 grid (1 unit per cell) — geometry is what these tests exercise, not
 *  values. `unproject` is linear at PX_PER_CELL px/cell, so `pxPerCell` is exactly controlled
 *  (verified against coverage-sounding-anchors.test.ts's own `localPxPerCell` probe geometry). */
const SIZE: [number, number] = [40, 40]
const PX_PER_CELL = 10
function grid(): CoverageHandle {
  return coverageFromGrids({
    product: 's102',
    crs: null,
    origin: [0, 0],
    spacing: [1, 1],
    size: SIZE,
    bands: [
      {
        name: 'depth',
        unit: 'metres',
        kind: 'f32',
        nodata: 1e6,
        values: new Float32Array(1600).fill(3),
      },
    ],
    vertical: { datumCode: 23, sign: 'down' },
  })
}
const unproject = (px: number, py: number): [number, number] => [px / PX_PER_CELL, py / PX_PER_CELL]
const viewport = { width: 400, height: 400, dpr: 1 }

describe('coverageSoundingAnchors — strideWant out param carries the RAW (pre-quantised) ratio (#1434)', () => {
  it('reports spacingPx / pxPerCell, not the quantised stride', () => {
    const strideWant = { value: NaN }
    const anchors = coverageSoundingAnchors(grid(), unproject, {
      width: viewport.width,
      height: viewport.height,
      spacingPx: 22.5, // want = 22.5 / 10 = 2.25 (quantises to stride 2)
      strideWant,
    })
    expect(anchors.length).toBeGreaterThan(0) // non-vacuous: cells were actually selected
    expect(strideWant.value).toBeCloseTo(2.25, 6)
    expect(quantiseStride(strideWant.value)).toBe(2)
  })

  it('is left untouched when nothing is visible', () => {
    const strideWant = { value: NaN }
    coverageSoundingAnchors(grid(), () => null, {
      width: viewport.width,
      height: viewport.height,
      spacingPx: 22.5,
      strideWant,
    })
    expect(strideWant.value).toBeNaN()
  })
})

describe('dispatchCoverageSoundings — returns the strideWant ratio it used (#1434)', () => {
  const noopApplyExprs = () =>
    ({ text: { kind: 'expr', expr: { ast: {} } } }) as unknown as LabelDef
  const copyLonLat = (lon: number, lat: number): Array<[number, number, number]> => [[lon, lat, 1]]

  it('matches coverageSoundingAnchors’ own strideWant for the same inputs', () => {
    const direct = { value: NaN }
    coverageSoundingAnchors(grid(), unproject, {
      width: viewport.width,
      height: viewport.height,
      spacingPx: SOUNDING_LATTICE_CSS_PX * viewport.dpr,
      strideWant: direct,
    })
    const got = dispatchCoverageSoundings(
      grid(),
      unproject,
      viewport,
      noopApplyExprs,
      copyLonLat,
      () => {},
      { layerName: 'soundings', region: 'r0' },
    )
    expect(Number.isFinite(direct.value)).toBe(true)
    expect(got).toBeCloseTo(direct.value, 10)
  })

  it('returns NaN when nothing is visible — the label-pass skip state records "no coverage show"', () => {
    const got = dispatchCoverageSoundings(
      grid(),
      () => null,
      viewport,
      noopApplyExprs,
      copyLonLat,
      () => {},
      { layerName: 'soundings', region: 'r0' },
    )
    expect(got).toBeNaN()
  })
})

// ── Layer 3: label-pass.ts wiring (structural — see label-pass-replay-wiring.test.ts) ────────

describe('label-pass — S16 skip wiring for #1434', () => {
  const SRC = readFileSync(resolve(__dirname, 'label-pass.ts'), 'utf8').replace(/\r\n/g, '\n')
  const camSameIdx = SRC.indexOf('const _camSame =')
  const sigSameIdx = SRC.indexOf('const _sigSame =')
  const camSameBlock = SRC.slice(camSameIdx, sigSameIdx)

  it('slice anchors exist (fail loudly on refactor, not vacuously)', () => {
    expect(camSameIdx).toBeGreaterThan(-1)
    expect(sigSameIdx).toBeGreaterThan(camSameIdx)
  })

  it('the skip state carries preparedStrideWant, reset to NaN on every real prepare', () => {
    expect(SRC).toContain('preparedStrideWant: number')
    expect(SRC).toContain('preparedStrideWant: NaN,') // fresh-record branch
    expect(SRC).toContain('_prevSkip.preparedStrideWant = NaN') // re-used-record branch
  })

  it('the coverage dispatch call site records the return value ONLY on a real prepare, never on a replay', () => {
    expect(SRC).toContain('const _strideWant = dispatchCoverageSoundings(')
    expect(SRC).toMatch(
      /if \(!canSkipLabelPrepare && _postSkip\) _postSkip\.preparedStrideWant = _strideWant/,
    )
  })

  it('the zoomActive tolerant arm ANDs in !soundingStrideInvalidates — can only turn a would-be hit into a miss, never the reverse', () => {
    expect(camSameBlock).toContain(
      '!soundingStrideInvalidates(_prevSkip.preparedStrideWant, _dzoom)',
    )
    // ANDed onto the existing centre-drift check, not ORed and not gating the settled (exact)
    // branch below it — the ±0.15/48px producers are unaffected outside an active zoom.
    expect(camSameBlock).toMatch(/<= 48 &&\s*!soundingStrideInvalidates/)
  })
})
