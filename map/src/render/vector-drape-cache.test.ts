import { describe, expect, it } from 'vitest'
import {
  planBakeEvictions,
  drapeZoomBucket,
  drapeStrokeWidthScale,
  bakeStrokeAaDpr,
} from './vector-drape-cache'

// #599 I3 — the globe vector-drape baked-fill cache eviction policy. Pure, so it
// runs without the RasterDraper / WebGPU stack. Entries are `{ lastCall }` (the
// LRU clock VectorDrapeRenderer stamps each time a bake is draped); the values
// here are cache KEYS (`${sliceLayer}:${tileKey}`) — the renderer maps each
// returned key to `rhi.destroyTexture` + `this.baked.delete`.
const baked = (entries: Array<[string, number]>): Map<string, { lastCall: number }> =>
  new Map(entries.map(([k, lastCall]) => [k, { lastCall }]))

describe('planBakeEvictions — baked-fill LRU cap (mirrors raster evictTiles)', () => {
  it('evicts nothing at or under the cap', () => {
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
    ])
    expect(planBakeEvictions(cache, new Set(), 3)).toEqual([])
    expect(planBakeEvictions(cache, new Set(), 10)).toEqual([])
  })

  it('drops the least-recently-draped non-visible keys down to the cap', () => {
    // 5 cached, cap 3 → evict 2. lastCall asc = l:1(1), l:2(2) are the oldest.
    const cache = baked([
      ['l:5', 5],
      ['l:1', 1],
      ['l:4', 4],
      ['l:2', 2],
      ['l:3', 3],
    ])
    const evicted = planBakeEvictions(cache, new Set(), 3)
    expect(evicted).toEqual(['l:1', 'l:2'])
  })

  it('never evicts a currently-visible bake (skip-set), even the oldest', () => {
    // Oldest is l:1 but it is visible → the next-oldest non-visible (l:2, l:3) go.
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
      ['l:4', 4],
    ])
    const evicted = planBakeEvictions(cache, new Set(['l:1']), 2)
    expect(evicted).toEqual(['l:2', 'l:3'])
    expect(evicted).not.toContain('l:1')
  })

  it('two consecutive visible-sets: only tiles that left view get evicted', () => {
    // Frame A draped keys 1..4; frame B moved so only 3,4 stay visible. With cap 2
    // and B's visible-set as skip, the departed 1,2 are the eviction targets.
    const cache = baked([
      ['l:1', 10],
      ['l:2', 11],
      ['l:3', 12],
      ['l:4', 13],
    ])
    const visibleB = new Set(['l:3', 'l:4'])
    expect(planBakeEvictions(cache, visibleB, 2)).toEqual(['l:1', 'l:2'])
  })

  it('static globe: all cached tiles visible → zero eviction even over cap', () => {
    // A held-still globe re-drapes the SAME keys every frame; they are all in the
    // skip-set, so nothing is evicted (and renderGlobeFills finds them all cached
    // → 0 rebakes). This is the I2 zero-rebake-on-static guarantee at the cache
    // policy level.
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
    ])
    const allVisible = new Set(['l:1', 'l:2', 'l:3'])
    expect(planBakeEvictions(cache, allVisible, 1)).toEqual([])
  })
})

// #1222 — the zoom-bucketed stroke-rebake math. Pure, so the screen-px width
// contract is provable without a GPU: bucket quantisation bounds the width
// error at 2^(1/8) ≈ ±9 %, and the compensation exactly cancels the texture
// magnification at every bucket centre.
describe('drapeZoomBucket / drapeStrokeWidthScale — #1222 screen-px stroke contract', () => {
  it('bucket 0 (scale 1) at the bake-native anchor camZoom == tileZoom', () => {
    expect(drapeZoomBucket(3, 3)).toBe(0)
    expect(drapeStrokeWidthScale(0)).toBe(1)
  })

  it('quantises to quarter-zoom steps, rounding to the nearest bucket', () => {
    expect(drapeZoomBucket(3.25, 3)).toBe(1)
    expect(drapeZoomBucket(3.3, 3)).toBe(1)
    expect(drapeZoomBucket(3.4, 3)).toBe(2)
    expect(drapeZoomBucket(2.75, 3)).toBe(-1)
  })

  it('clamps to ±8 buckets (±2 zoom) so deep parent-fallback never thrashes', () => {
    expect(drapeZoomBucket(10, 3)).toBe(8)
    expect(drapeZoomBucket(0, 6)).toBe(-8)
  })

  it('compensation cancels the magnification exactly at every bucket centre', () => {
    // On-screen width = bakedWidth × 2^(camZoom − tileZoom). At a bucket centre
    // camZoom − tileZoom = bucket/4, so bakedWidth = widthPx × scale must give
    // widthPx × scale × 2^(bucket/4) = widthPx exactly.
    for (let bucket = -8; bucket <= 8; bucket++) {
      const onScreen = drapeStrokeWidthScale(bucket) * Math.pow(2, bucket / 4)
      expect(onScreen).toBeCloseTo(1, 12)
    }
  })

  it('bounds the worst-case width drift at 2^(1/8) ≈ 9 % over the whole zoom range', () => {
    // Sweep the un-clamped range densely: at any camZoom the residual error is
    // scale × 2^(camZoom − tileZoom) vs 1, maximised half-way between buckets.
    let worst = 1
    for (let dz = -2; dz <= 2; dz += 0.01) {
      const bucket = drapeZoomBucket(3 + dz, 3)
      const onScreen = drapeStrokeWidthScale(bucket) * Math.pow(2, dz)
      worst = Math.max(worst, Math.max(onScreen, 1 / onScreen))
    }
    expect(worst).toBeLessThanOrEqual(Math.pow(2, 1 / 8) + 1e-9)
  })
})

// ═══ #2346 — the baked AA band must land at the direct path's width ═══
//
// #1222 above compensates the stroke's CORE width. The painted edge is wider
// than the core by the fragment's AA half-band (`0.5 / dpr` LAYER px), and in a
// bake one layer pixel is one BAKE TEXEL — which the sphere magnifies by exactly
// the factor #1222 divided out of the core. The bake wrote `dpr = 1`, so the
// band was `0.5 · 2^(camZoom − tileZoom) · dpr` device px against the direct
// path's flat 0.5: measured 7.0 device px of road against the Mercator control's
// 3.0 at z7.5 / dpr 2 on OFM Positron.
describe('bakeStrokeAaDpr — the AA band survives the bake (#2346)', () => {
  /** What the fragment actually paints beyond the core, in DEVICE px, when the
   *  bake is sampled at magnification `m` on a `dpr` display: the half-band is
   *  `0.5 / aaDpr` BAKE TEXELS, and one bake texel is `m` CSS px = `m · dpr`
   *  device px. The direct path's own band is a flat 0.5 device px. */
  const paintedHalfBandDevicePx = (m: number, dpr: number): number =>
    (0.5 / bakeStrokeAaDpr(dpr, drapeStrokeWidthScale(drapeZoomBucket(Math.log2(m), 0)))) * m * dpr

  it('pays back the magnification the bucket measured — at every dpr and depth', () => {
    for (const dpr of [1, 2, 3]) {
      for (const m of [1, 1.19, 1.41, 2, 2.83, 4]) {
        expect(
          paintedHalfBandDevicePx(m, dpr),
          `magnification ${m}× at dpr ${dpr}: the baked AA band must paint the direct path's ` +
            `0.5 device px. Wider means every stroke on the globe is thicker than the same ` +
            `stroke on mercator — the "roads are too thick" report.`,
        ).toBeCloseTo(0.5, 1)
      }
    }
  })

  it('is 1 at the bake-native dpr-1 anchor, so that frame is byte-identical', () => {
    // The value the bake used to hard-code. Anything else here would re-bake
    // every dpr-1 native-zoom tile for no reason.
    expect(bakeStrokeAaDpr(1, 1)).toBe(1)
  })

  it('scales with dpr alone when the bake is already at the camera zoom', () => {
    // No magnification to undo: the band must simply be a device pixel wide, so
    // a 2× display asks the bake for a half-band half as wide in texels.
    expect(bakeStrokeAaDpr(2, 1)).toBe(2)
    expect(bakeStrokeAaDpr(3, 1)).toBe(3)
  })

  it('never returns a non-finite or zero dpr, whatever the caller passes', () => {
    // The uniform divides: a 0 would put NaN in every fragment of the frame.
    expect(bakeStrokeAaDpr(0, 1)).toBeGreaterThan(0)
    expect(Number.isFinite(bakeStrokeAaDpr(2, 0))).toBe(true)
  })
})
