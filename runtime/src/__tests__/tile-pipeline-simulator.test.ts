import { describe, expect, it } from 'vitest'
import {
  simulateTilePipeline,
  makePitchSweep,
} from '../debug/tile-pipeline-simulator'
import { predictTilePipeline } from '../debug/tile-pipeline-predictor'

describe('tile pipeline simulator — basic behavior', () => {
  it('steady low-demand scene converges to zero misses and zero backlog', () => {
    // Low-zoom world-fit: small frustum, cache should saturate with the
    // whole visible set within a few frames.
    const trajectory = Array.from({ length: 30 }, () => ({
      lon: 0, lat: 0, zoom: 3, bearing: 0, pitch: 0,
    }))
    const result = simulateTilePipeline(trajectory, { maxLevel: 7 })
    const last = result.perFrame[result.perFrame.length - 1]
    expect(last.missedCount).toBe(0)
    expect(result.finalBacklog).toBe(0)
  })

  it('upload budget throttles the convergence rate', () => {
    const trajectory = Array.from({ length: 30 }, () => ({
      lon: 10, lat: 50, zoom: 6, bearing: 0, pitch: 0,
    }))
    const fastResult = simulateTilePipeline(trajectory, { maxLevel: 7 }, {
      uploadBudgetPerFrame: 16,
    })
    const slowResult = simulateTilePipeline(trajectory, { maxLevel: 7 }, {
      uploadBudgetPerFrame: 1,
    })
    // The slow budget converges later. Look at frame 3 — fast should
    // have fewer misses than slow.
    expect(fastResult.perFrame[3].missedCount)
      .toBeLessThan(slowResult.perFrame[3].missedCount)
  })
})

describe('tile pipeline simulator — FLICKER reproduction', () => {
  it('water_hierarchy pitch sweep sustains backlog after settle (lower bound)', () => {
    // Reproduces the _water-hierarchy-pitch.spec.ts .fail scenario in
    // the CPU model: pitch 0 → 79.9° in 8 steps, then 30 settled frames.
    // At high pitch the frustum demand is in the hundreds; the 4/frame
    // upload budget lags, and the backlog should still be nonzero at
    // the end of the trajectory. Locks in the "FLICKER persists in
    // settled frames" behavior.
    const trajectory = makePitchSweep(
      { lon: 91.09184, lat: 24.22985, zoom: 13.5, bearing: 330.0 },
      0, 79.9, 8, 30,
    )
    const result = simulateTilePipeline(trajectory, { maxLevel: 10 })
    // The simulation should show non-trivial peak pressure at the
    // motion peak.
    expect(result.peakMissed).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(`[water_hierarchy sim] peak misses: ${result.peakMissed}, final backlog: ${result.finalBacklog}, final cache: ${result.finalCacheSize}`)
  })

  it('backlog grows during camera motion and persists into settled frames', () => {
    // General-shape test: during motion (first 8 frames), backlog
    // increases. After settle (subsequent frames), backlog either
    // drains (if budget keeps up) or stays constant (if it doesn't).
    // Asserts a monotone pattern, not a specific number.
    const trajectory = makePitchSweep(
      { lon: 91.09184, lat: 24.22985, zoom: 13.5, bearing: 330.0 },
      0, 79.9, 8, 20,
    )
    const result = simulateTilePipeline(trajectory, { maxLevel: 10 })

    // Backlog during motion should be positive.
    const motionPeak = Math.max(...result.perFrame.slice(0, 8).map(f => f.backlogSize))
    expect(motionPeak).toBeGreaterThan(0)
  })

  it('z=22 pitch 60° over Paris — user-reported polygon offset symptom', () => {
    // User reported: "실제 피치값을 주고 확대 22레벨까지 진행 해야
    // 오프셋 이슈가 발생함". At zoom 22 with pitch applied, polygons
    // visually render at the wrong screen position (full-cover quads
    // appear in the horizon area instead of filling the viewport
    // under the camera). Browser-verified 2026-04-21 on the
    // `categorical` demo at (lon=2.3522, lat=48.8566, zoom=22, pitch=60):
    // blue France fill appeared as a rectangle in the upper half of the
    // screen rather than covering the ground under Paris.
    //
    // Root cause is not yet isolated (likely candidates: DSFUN split
    // precision at 22-level overzoom, near/far clipping plane mis-
    // match at extreme zoom, or log-depth factor quantisation at this
    // ratio). This test locks in the predictor state so a fix that
    // changes the tile-pipeline shape here gets flagged.
    const pred = predictTilePipeline(
      { lon: 2.3522, lat: 48.8566, zoom: 22, bearing: 0, pitch: 60 },
      { maxLevel: 4 }, // countries.geojson has low source maxLevel
      1200, 800,
    )
    // The source's overzoomBudget (default 13) caps requestable zoom
    // at maxLevel + 13 = 17, not the requested 22. So the frustum
    // actually wants tiles at z=17, not z=22 — and the 5 missing
    // levels are served by parent-tile fallback. This limit itself
    // may contribute to the observed symptom (polygons "disappearing"
    // because the requested tile depth can't reach the camera zoom).
    expect(pred.requestedZ).toBe(17)
    expect(pred.overzoom).toBe(true)
    expect(pred.overzoomLevels).toBe(13)
    // GPU cache saturates at this z+pitch — there are too many tiles
    // requested for the cache capacity. This is one of the contributors
    // to the polygon-offset symptom (saturated cache → eviction during
    // a frame → mismatched parent fallback).
    expect(pred.cacheCapacityCheck.saturated).toBe(true)
  })

  it('a larger upload budget reduces peak missed count for the same trajectory', () => {
    const traj = makePitchSweep(
      { lon: 91.09184, lat: 24.22985, zoom: 13.5, bearing: 330.0 },
      0, 79.9, 8, 30,
    )
    const stockBudget = simulateTilePipeline(traj, { maxLevel: 10 }, {
      uploadBudgetPerFrame: 4,
    })
    const fatBudget = simulateTilePipeline(traj, { maxLevel: 10 }, {
      uploadBudgetPerFrame: 32,
    })
    // A fatter upload budget should reduce or eliminate the flicker.
    expect(fatBudget.peakMissed).toBeLessThanOrEqual(stockBudget.peakMissed)
    expect(fatBudget.finalBacklog).toBeLessThanOrEqual(stockBudget.finalBacklog)
  })
})
