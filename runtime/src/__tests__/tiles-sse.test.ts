// SSE selector unit tests — pinned correctness invariants for the
// Cesium-style screen-space-error tile selector. The e2e test covers
// real-browser perf + integration; these tests cover the algorithmic
// behaviour in isolation so future Phase 2 work (world copies, OBB
// frustum cull, fallback inject) doesn't silently regress the basics.

import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/camera'
import { mercator } from '../engine/projection'
import { visibleTilesSSE } from '../loader/tiles-sse'

const DEG2RAD = Math.PI / 180

function makeCam(zoom: number, pitch: number, lon: number, lat: number, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

describe('visibleTilesSSE — basic emission', () => {
  it('emits a non-empty selection at z=14 over Tokyo, flat view', () => {
    const cam = makeCam(14, 0, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('emits a non-empty selection at z=14 over Tokyo, pitch=80°', () => {
    // High-pitch is the case the Phase-2 frustum-mul kludge couldn't
    // bound — SSE handles it naturally because foreshortened horizon
    // tiles get small SSE and stop subdividing.
    const cam = makeCam(14, 80, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('emits at least one tile at z >= currentZ - 2 around the camera centre', () => {
    // Closest-point distance + SSE means the tile under the camera
    // gets the highest SSE → subdivides deepest. With the default
    // target=4 px, the deepest emitted zoom under the camera is
    // approximately currentZ - 2 (each zoom level halves SSE; 1 →
    // 2 → 4 stops at the third level above currentZ). This tradeoff
    // is documented on DEFAULT_TARGET_SSE_PX in tiles-sse.ts —
    // tightening the target eliminates the gap but blows up tile
    // count at high pitch. The "currentZ - 2" floor is the agreed
    // compromise for v1; revisit if visual quality complaints land.
    const cam = makeCam(14, 0, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    const maxZ = Math.max(...tiles.map(t => t.z))
    expect(maxZ).toBeGreaterThanOrEqual(12)
  })

  it('high pitch selects far FEWER tiles than the old frustum selector did at its budget cap', () => {
    // The old visibleTilesFrustum capped at 1200 (300 × pitch-mul 4)
    // and routinely hit the cap at pitch 80° with cumulative
    // foreshortening over-detail. SSE for the same camera should
    // emit < 600 tiles (well under the safety net) because it stops
    // subdividing on its own.
    const cam = makeCam(14, 80, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    expect(tiles.length).toBeLessThan(600)
  })
})

describe('visibleTilesSSE — perspective adaptation', () => {
  it('higher pitch emits MORE tiles than flat (horizon strip detail)', () => {
    // SSE doesn't blow up like the old metric, but does need MORE
    // total tiles at high pitch to cover the horizon strip vs flat
    // view. Sanity check the metric is responsive to pitch at all.
    const flat = visibleTilesSSE(makeCam(14, 0, 139.76, 35.68), mercator, 14, 1280, 800, 0, 1)
    const tilted = visibleTilesSSE(makeCam(14, 80, 139.76, 35.68), mercator, 14, 1280, 800, 0, 1)
    expect(tilted.length).toBeGreaterThan(flat.length)
  })

  it('lower target SSE produces MORE (sharper) tiles than higher target', () => {
    // Cesium target-SSE knob: smaller target → more subdivision →
    // more tiles. Verify the algorithm honours it.
    const cam = makeCam(14, 40, 139.76, 35.68)
    const sharp = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1, { targetSSEPx: 4 })
    const soft = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1, { targetSSEPx: 32 })
    expect(sharp.length).toBeGreaterThan(soft.length)
  })

  it('lower zoom (z=4) over Tokyo emits coarser tiles than z=14', () => {
    // The metric naturally selects coarser tiles when the camera is
    // pulled back. No mid-z giant fallback needed — z=14 should
    // produce mostly z=14 tiles, z=4 should produce mostly low-z
    // tiles.
    const close = visibleTilesSSE(makeCam(14, 0, 139.76, 35.68), mercator, 14, 1280, 800, 0, 1)
    const far = visibleTilesSSE(makeCam(4, 0, 139.76, 35.68), mercator, 14, 1280, 800, 0, 1)
    const closeAvgZ = close.reduce((a, t) => a + t.z, 0) / close.length
    const farAvgZ = far.reduce((a, t) => a + t.z, 0) / far.length
    expect(closeAvgZ).toBeGreaterThan(farAvgZ)
  })
})

describe('visibleTilesSSE — TileCoord contract', () => {
  it('every emitted tile satisfies the (x, ox) absolute-x contract', () => {
    // Phase 1: world-copy enumeration deferred, so ox === x always.
    // When Phase 2 lands world copies this test should be updated;
    // until then it pins the simpler invariant.
    const cam = makeCam(14, 0, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    for (const t of tiles) {
      expect(t.ox).toBe(t.x)
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThan(1 << t.z)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeLessThan(1 << t.z)
    }
  })

  it('does not emit fallbackOnly tiles in Phase 1', () => {
    // The fallback-ancestor inject is on the Phase 2 list. Until then,
    // emit only primary tiles.
    const cam = makeCam(14, 60, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    for (const t of tiles) expect(t.fallbackOnly).toBeFalsy()
  })
})

describe('visibleTilesSSE — safety net', () => {
  it('respects maxEmitted cap even on a degenerate request (target 0)', () => {
    // target=0 would subdivide infinitely without the cap. Verify the
    // cap kicks in BEFORE the recursion blows the call stack.
    const cam = makeCam(14, 80, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 22, 1280, 800, 0, 1, {
      targetSSEPx: 0,
      maxEmitted: 50,
    })
    expect(tiles.length).toBeLessThanOrEqual(50)
  })
})
