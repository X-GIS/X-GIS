import { describe, expect, it } from 'vitest'
import {
  predictTilePipeline, SUB_TILE_BUDGET_PER_FRAME,
} from '../loader/tile-pipeline-predictor'

// CPU reproduction of the reported FLICKER bug (Bug 2) —
// `dashed_borders#19.80/21.55/108.05/75.0/64.2` over an `ne_110m_ocean`
// source (Natural Earth 110m → source.maxLevel ≈ 7). The browser
// scenario is a completely black map with
//   [FLICKER] ocean: 122 tiles without fallback (z=20 gpuCache=236)
//   [FLICKER] ocean: 61 tiles without fallback (z=20 gpuCache=315)
//   [FLICKER] ocean: 1 tiles without fallback (z=20 gpuCache=375)
//
// This file turns that into a CPU-verifiable assertion: the frustum
// DOES want tiles at z=20, the requested set exceeds every standard
// GPU cache size, and cold convergence takes dozens of frames at the
// 2/frame sub-tile budget. It documents the bug without running the
// browser and provides the shape a fix should change.

describe('tile pipeline predictor', () => {
  it('reproduces the FLICKER scenario — z=20 pitch 64.2° over 110m source', () => {
    const pred = predictTilePipeline(
      {
        lon: 108.05041,
        lat: 21.55202,
        zoom: 19.80,
        bearing: 75.0,
        pitch: 64.2,
      },
      { maxLevel: 7 },
      1200, 800,
    )

    // Print the shape so a diagnostic run surfaces the numbers
    // alongside any FLICKER output from the browser session.
    // eslint-disable-next-line no-console
    console.log('[predictor:dashed_borders-buggy-state]', JSON.stringify({
      requestedZ: pred.requestedZ,
      overzoomLevels: pred.overzoomLevels,
      tilesWanted: pred.cacheCapacityCheck.requestedCount,
      saturated: pred.cacheCapacityCheck.saturated,
      parentCount: pred.parentTiles.length,
      coldConvergenceFrames: pred.coldConvergenceFrames,
      fitsIn: {
        '256': pred.cacheCapacityCheck.fitsIn256,
        '512': pred.cacheCapacityCheck.fitsIn512,
        '1024': pred.cacheCapacityCheck.fitsIn1024,
      },
    }))

    // Sanity: we DID round to z=20 (the hash's 19.80 rounds up).
    expect(pred.requestedZ).toBe(20)
    expect(pred.overzoom).toBe(true)
    expect(pred.overzoomLevels).toBe(13)

    // The frustum at this pitch wants well over a hundred tiles — the
    // FLICKER line's "122 tiles" matches this ballpark.
    expect(pred.cacheCapacityCheck.requestedCount).toBeGreaterThan(100)

    // The frustum hit the internal MAX_FRUSTUM_TILES cap (300 desktop /
    // 120 mobile). Saturation means the reported count understates true
    // demand, and any fitsIn* verdict below should be treated as a
    // lower bound, not a guarantee.
    expect(pred.cacheCapacityCheck.saturated).toBe(true)

    // Standard GPU caches (256/512/1024 entries): the 256 cache is
    // smaller than what the frame alone needs — every other frame
    // churns the cache and re-evicts tiles we just loaded. The
    // user's log shows gpuCache=236/315/375 values, hugging the
    // 256–512 range — consistent with this prediction.
    expect(pred.cacheCapacityCheck.fitsIn256).toBe(false)

    // Cold-start convergence: every visible tile needs a sub-tile
    // generation. At 2/frame that's tens of frames (≥ half a second)
    // before ALL tiles are present. And that's assuming the parent
    // at z=7 is already cached — if not, add parent-load latency on
    // top.
    expect(pred.coldConvergenceFrames).toBeGreaterThanOrEqual(
      Math.ceil(pred.cacheCapacityCheck.requestedCount / SUB_TILE_BUDGET_PER_FRAME),
    )

    // Parent set is tiny — at z=7, the whole world is 128×128 tiles
    // and this viewport's frustum intersects only a handful of them.
    // That's the small upstream workload we could pre-load to avoid
    // the sub-tile budget bottleneck.
    expect(pred.parentTiles.length).toBeGreaterThan(0)
    expect(pred.parentTiles.length).toBeLessThanOrEqual(16)
  })

  it('no overzoom when zoom is within source maxLevel', () => {
    const pred = predictTilePipeline(
      { lon: 0, lat: 0, zoom: 3, bearing: 0, pitch: 0 },
      { maxLevel: 7 },
      1200, 800,
    )
    expect(pred.requestedZ).toBe(3)
    expect(pred.overzoom).toBe(false)
    expect(pred.overzoomLevels).toBe(0)
    expect(pred.coldConvergenceFrames).toBe(0)
    // KNOWN BUG: classifyTile short-circuits at tz <= 3 and pushes
    // every tile without viewport check when tz === maxZ. So z=3
    // world-fit saturates (all 5 world-copies × 64 tiles clipped at
    // 300). See tile-selection-semantic.test.ts for the lock-in.
    // When that bug is fixed, saturated will become false here.
    expect(pred.cacheCapacityCheck.saturated).toBe(true)
    expect(pred.cacheCapacityCheck.fitsIn512).toBe(true)
  })

  it('parentTiles at sourceMaxLevel cover every visible descendant', () => {
    const pred = predictTilePipeline(
      { lon: 0, lat: 0, zoom: 10, bearing: 0, pitch: 0 },
      { maxLevel: 7 },
      1200, 800,
    )
    expect(pred.overzoomLevels).toBe(3) // 10 - 7
    const shift = pred.overzoomLevels
    // Every visible tile's (x >> shift, y >> shift) must appear in
    // parentTiles. Verifies the shift math we use to back-trace
    // sub-tiles to their runtime-loadable ancestors.
    for (const t of pred.visibleTiles) {
      const px = t.x >> shift
      const py = t.y >> shift
      const hit = pred.parentTiles.some(p => p.x === px && p.y === py)
      expect(hit).toBe(true)
    }
  })

  it('reproduces the water_hierarchy FLICKER scenario — pitch 79.9° at z=13.5 over 10m source', () => {
    // Second user-reported FLICKER case, different source. The
    // _water-hierarchy-pitch.spec.ts .fail test documents console output
    // of "[FLICKER] land: 49 tiles without fallback (z=14 gpuCache=237)"
    // at this camera state. The predictor should flag the frame as
    // budget-saturated (requestedCount hit the MAX_FRUSTUM_TILES cap)
    // and report non-trivial overzoom.
    const pred = predictTilePipeline(
      {
        lon: 91.09184,
        lat: 24.22985,
        zoom: 13.5,
        bearing: 330.0,
        pitch: 79.9,
      },
      { maxLevel: 10 }, // ne_10m_* sources
      1200, 800,
    )
    // z=13.5 rounds to 14 at the frustum.
    expect(pred.requestedZ).toBe(14)
    // Overzoom by ~4 levels past the source maxLevel.
    expect(pred.overzoom).toBe(true)
    expect(pred.overzoomLevels).toBe(4)
    // High pitch → budget saturates.
    expect(pred.cacheCapacityCheck.saturated).toBe(true)
  })

  it('pitch 0° at z=20 demands far fewer tiles than pitch 64°', () => {
    // Controls the "pitch multiplies tile count" axiom that drives the
    // bug. Top-down z=20 sees a small rectangular patch; pitched z=20
    // sees to the horizon.
    const flat = predictTilePipeline(
      { lon: 108.05041, lat: 21.55202, zoom: 19.80, bearing: 0, pitch: 0 },
      { maxLevel: 7 }, 1200, 800,
    )
    const pitched = predictTilePipeline(
      { lon: 108.05041, lat: 21.55202, zoom: 19.80, bearing: 75, pitch: 64.2 },
      { maxLevel: 7 }, 1200, 800,
    )
    expect(pitched.cacheCapacityCheck.requestedCount)
      .toBeGreaterThan(flat.cacheCapacityCheck.requestedCount)
    // The pitched frame's request count should be at least 3× the
    // flat one — if this margin shrinks in a future change, the
    // frustum tile-selection logic likely regressed.
    expect(pitched.cacheCapacityCheck.requestedCount)
      .toBeGreaterThanOrEqual(flat.cacheCapacityCheck.requestedCount * 3)
  })
})
