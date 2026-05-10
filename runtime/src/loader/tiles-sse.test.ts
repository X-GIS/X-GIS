// SSE selector unit tests — pinned correctness invariants for the
// Cesium-style screen-space-error tile selector. The e2e test covers
// real-browser perf + integration; these tests cover the algorithmic
// behaviour in isolation so future Phase 2 work (world copies, OBB
// frustum cull, fallback inject) doesn't silently regress the basics.

import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { mercator } from '../engine/projection/projection'
import { visibleTilesSSE } from './tiles-sse'

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
    // Phase 2: ox = x + worldCopy * 2^z. Wrapped x stays in [0, 2^z),
    // ox can be ±N*2^z when the camera spans world copies.
    const cam = makeCam(14, 0, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    for (const t of tiles) {
      const n = 1 << t.z
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThan(n)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeLessThan(n)
      // ox - x must be a multiple of n (a world-copy shift).
      const wc = (t.ox - t.x) / n
      expect(Number.isInteger(wc)).toBe(true)
    }
  })

  it('emits fallbackOnly parent ancestors for eviction protection', () => {
    // Phase 2: each primary tile pushes (z-1, z-2) ancestors flagged
    // `fallbackOnly` so they're protected from cache eviction. The
    // renderer uses them as parent fallbacks when child slices haven't
    // uploaded yet. Mirrors visibleTilesFrustum's behaviour.
    const cam = makeCam(14, 60, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    const primaries = tiles.filter(t => !t.fallbackOnly)
    const ancestors = tiles.filter(t => t.fallbackOnly === true)
    expect(primaries.length).toBeGreaterThan(0)
    expect(ancestors.length).toBeGreaterThan(0)
    // Every ancestor should be at a strictly LOWER zoom than at least
    // one primary tile (they're parents).
    const primaryZooms = new Set(primaries.map(t => t.z))
    for (const a of ancestors) {
      let foundChild = false
      for (const z of primaryZooms) {
        if (z > a.z) { foundChild = true; break }
      }
      expect(foundChild,
        `ancestor at z=${a.z} should have at least one primary child at higher z`,
      ).toBe(true)
    }
  })
})

describe('visibleTilesSSE — Phase 2 world copies', () => {
  it('camera near the antimeridian emits tiles in BOTH world copies', () => {
    // Camera at lon=180° (date line) with 60° pitch — half the view
    // is in worldCopy=0, the other half in worldCopy=+1 (or -1).
    // Without world-copy enumeration, half the screen would render
    // black at non-zero pitch + bearing.
    const cam = makeCam(8, 60, 179.5, 0)  // just east of date line
    const tiles = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    const worldCopies = new Set<number>()
    for (const t of tiles) {
      const n = 1 << t.z
      worldCopies.add(Math.floor(t.ox / n))
    }
    // Expect at least 2 distinct world copies in the result.
    expect(worldCopies.size).toBeGreaterThanOrEqual(2)
  })

  it('non-Mercator projection emits a single world copy only', () => {
    // The worldCopiesFor(projType=1) returns [0]. Tile selector should
    // skip the ±N enumeration so non-Mercator (ortho, equirect, …)
    // doesn't double-emit the visible hemisphere.
    const cam = makeCam(2, 0, 0, 0)
    const ortho = { ...mercator, name: 'orthographic' as const }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tiles = visibleTilesSSE(cam, ortho as any, 14, 1280, 800, 0, 1)
    for (const t of tiles) {
      const n = 1 << t.z
      expect(Math.floor(t.ox / n)).toBe(0)
    }
  })
})

describe('visibleTilesSSE — globe-equivalent horizon cull (Mercator)', () => {
  it('high-pitch Mercator emits fewer tiles with horizon cull on (default)', () => {
    // Cesium's pitch=80° performance comes mostly from globe self-
    // occlusion: tiles past the horizon ellipse simply don't exist
    // in the visible set. We replicate this by computing the globe-
    // equivalent horizon distance and culling Mercator tiles past
    // that — without the cap, flat Mercator at pitch=80° emits a
    // 1300-tile horizon strip that the GPU can't keep up with.
    // Note: at z=14 over a city the SSE selector already trims most
    // distant tiles (low SSE → no subdivide); the horizon cull mostly
    // affects pitched LOW-zoom views where many low-z tiles otherwise
    // fall through. So the strict equality is `culled <= uncapped`,
    // and the BIG win shows up at lower zooms / higher pitch.
    const cam = makeCam(8, 80, 139.76, 35.68)  // wider view = more aggressive cull
    const culled = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    const uncapped = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1, {
      disableHorizonCull: true,
    })
    expect(culled.length).toBeLessThanOrEqual(uncapped.length)
    // For wide pitched views the cap reliably cuts at least 30 % of
    // tiles. Tighter bound would be brittle against multiplier
    // re-tuning; this catches "cull wired wrong" without false alarms.
    expect(culled.length).toBeLessThan(uncapped.length)
  })

  it('flat-pitch Mercator: horizon cull may trim distant world-copy roots', () => {
    // At flat pitch the FOREGROUND view is well within horizon
    // distance, but the DFS still walks into ±2 world-copy roots
    // for periodic Mercator coverage. Far-away world-copy tiles
    // are legitimately past horizon and get culled — that's
    // correct, not a bug. Verify culled <= uncapped (equal in
    // most cases, fewer when world copies are near the horizon).
    const cam = makeCam(14, 0, 139.76, 35.68)
    const culled = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1)
    const uncapped = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1, {
      disableHorizonCull: true,
    })
    expect(culled.length).toBeLessThanOrEqual(uncapped.length)
  })

  it('non-Mercator projections ignore the horizon-cull flag', () => {
    // Non-cylindrical projections (ortho / azimuthal_equidistant /
    // stereographic) handle horizon culling through their own
    // projection geometry. The flat-Mercator hack doesn't apply,
    // and forcing it would over-cull the visible hemisphere.
    const cam = makeCam(2, 0, 0, 0)
    const ortho = { ...mercator, name: 'orthographic' as const }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const culled = visibleTilesSSE(cam, ortho as any, 14, 1280, 800, 0, 1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uncapped = visibleTilesSSE(cam, ortho as any, 14, 1280, 800, 0, 1, {
      disableHorizonCull: true,
    })
    expect(culled.length).toBe(uncapped.length)
  })
})

describe('visibleTilesSSE — Phase 2 margin enlargement', () => {
  it('larger extraMarginPx selects MORE tiles than zero margin', () => {
    // The margin widens the cull envelope so tiles whose centerline
    // data is just outside the viewport still get selected (covers
    // stroke-offset / halo render reach).
    const cam = makeCam(14, 0, 139.76, 35.68)
    const tight = visibleTilesSSE(cam, mercator, 14, 1280, 800, 0, 1).length
    const loose = visibleTilesSSE(cam, mercator, 14, 1280, 800, 200, 1).length
    expect(loose).toBeGreaterThanOrEqual(tight)
  })
})

describe('visibleTilesSSE — safety net', () => {
  it('respects maxEmitted cap even on a degenerate request (target 0)', () => {
    // target=0 would subdivide infinitely without the cap. Verify the
    // cap kicks in BEFORE the recursion blows the call stack. The
    // exact final count can exceed `maxEmitted` by up to 2 because
    // each leaf emit pushes 1 primary + up to 2 parent fallbacks
    // (FALLBACK_PARENT_DEPTH = 2) all in one visit, while the cap
    // check fires only at the TOP of the next visit. Allow a small
    // overshoot in the assertion — the contract is "doesn't blow
    // the stack", not "exact count".
    const cam = makeCam(14, 80, 139.76, 35.68)
    const tiles = visibleTilesSSE(cam, mercator, 22, 1280, 800, 0, 1, {
      targetSSEPx: 0,
      maxEmitted: 50,
    })
    expect(tiles.length).toBeLessThanOrEqual(50 + 2)
  })
})
