// Regression for #1078 — the zoom-transition readiness gate must probe the
// SAME selector the frame draws with.
//
// The gate holds the OLD cz (so the user keeps seeing the previous LOD over-
// zoomed) until every visible tile at the next LOD is cached, then advances.
// On the globe/sphere route the drawn tile set comes from globeVisibleTiles
// (hemisphere + pole culling); probing the flat visibleTilesSSE there answers
// "is every visible tile ready?" against a Mercator-frustum set that differs
// from what the sphere actually draws near the horizon/poles — so the cz
// hold/advance decision was being made over tiles the sphere route never draws.
//
// Witness camera: globe (projType 7 + globeMode) at lon0/lat0/pitch0, zoom 2→3.
// At step LOD 3 globeVisibleTiles selects 20 front-hemisphere tiles; the flat
// visibleTilesSSE on the same (globe) matrix selects only 3, TWO of which the
// sphere never draws. Seeding EXACTLY the sphere step set as cached:
//   • sphere probe (fixed)  → all 20 step tiles ready → cz ADVANCES to 3.
//   • flat probe (pre-fix)  → 2 of 3 flat step tiles uncached → cz HELD at 2.
// So `currentZ === 3` discriminates the fix (pre-fix returns 2).

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import { globeVisibleTiles, visibleTilesSSE } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/geo'
import { tileKey } from '@xgis/compiler'
import { activeBody } from '@xgis/shared'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

const W = 1024
const H = 768
const DPR = 1
const MARGIN = 2
const MAXLEVEL = 10

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

// Catalog whose only "cached" tiles are the keys in `cached`. The readiness
// gate counts a step tile ready when hasTileData(key) is true; hasEntryInIndex
// stays false so the main-path ancestor walk injects nothing.
function catalogWithCached(maxLevel: number, cached: Set<number>): TileCatalog {
  return {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: (k: number) => cached.has(k),
    prefetchTiles: () => {},
  } as unknown as TileCatalog
}

// Oracle: the z===step keys the SPHERE selector emits for `cam` — mirrors the
// gate's globeVisibleTiles probe inputs exactly (lon from centerX, true centre
// latitude centerLatDeg, camera zoom, css dims, pitch/bearing).
function sphereStepKeys(cam: Camera, step: number): Set<number> {
  const R = activeBody().sphereR
  const lon = (cam.centerX / R) * (180 / Math.PI)
  const tiles = globeVisibleTiles(
    lon,
    cam.centerLatDeg,
    cam.zoom,
    step,
    W / DPR,
    H / DPR,
    cam.pitch ?? 0,
    cam.bearing ?? 0,
  )
  return new Set(tiles.filter((t) => t.z === step).map((t) => tileKey(t.z, t.x, t.y)))
}

// Oracle: the z===step keys the FLAT SSE selector emits (the pre-fix probe).
function flatStepKeys(cam: Camera, step: number): Set<number> {
  const tiles = visibleTilesSSE(cam, mercatorProj, step, W, H, MARGIN, DPR)
  return new Set(tiles.filter((t) => t.z === step).map((t) => tileKey(t.z, t.x, t.y)))
}

function globeCam(zoom: number): Camera {
  const c = new Camera(0, 0, zoom)
  c.projType = 7
  c.globeMode = true
  c.pitch = 0
  return c
}

function drive(
  cache: TileSelectionCache,
  cam: Camera,
  projTypeParam: number,
  frameId: number,
  source: TileCatalog,
): ReturnType<TileSelectionCache['selectForFrame']> {
  return cache.selectForFrame(
    cam,
    projTypeParam,
    0,
    0,
    W,
    H,
    DPR,
    frameId,
    source,
    '',
    MARGIN,
    MAXLEVEL,
    NO_STATS,
  )
}

describe('#1078 — globe readiness gate probes the sphere selector', () => {
  it('divergence witness: sphere and flat step-3 sets differ near the horizon', () => {
    const cam = globeCam(3)
    const sphere = sphereStepKeys(cam, 3)
    const flat = flatStepKeys(cam, 3)
    expect(sphere.size, 'sphere selects a non-trivial step set').toBeGreaterThan(0)
    // The flat probe selects step tiles the sphere route never draws — the
    // exact soft-mismatch #1078 describes (horizon culling divergence).
    const flatOnly = [...flat].filter((k) => !sphere.has(k))
    expect(
      flatOnly.length,
      'flat probe must include >=1 step tile the sphere omits (else no divergence to test)',
    ).toBeGreaterThan(0)
  })

  it('globe: cz advances on the SPHERE set readiness, not the flat set (fail-before)', () => {
    const cache = new TileSelectionCache()
    // Frame 1 (zoom 2): establishes the hysteresis anchor; the gate is not
    // armed on the first frame (_hysteresisZ < 0).
    drive(cache, globeCam(2), 7, 1, catalogWithCached(MAXLEVEL, new Set()))
    // Cache EXACTLY the sphere step-3 set. The flat probe's extra step tiles
    // stay uncached, so a flat-probing gate would hold at cz=2.
    const cam3 = globeCam(3)
    const source = catalogWithCached(MAXLEVEL, sphereStepKeys(cam3, 3))
    // Frame 2 (zoom 3): the gate wants 2→3; readiness of the STEP set decides.
    const sel = drive(cache, cam3, 7, 2, source)
    expect(sel).not.toBeNull()
    // Fixed: sphere probe sees every step tile cached → advance to 3.
    // Pre-fix: flat probe sees uncached step tiles → hold at 2.
    expect(sel!.currentZ, 'gate must advance on the sphere set the frame draws').toBe(3)
  })

  it('flat mercator: unchanged — gate advances on the flat SSE set', () => {
    const cache = new TileSelectionCache()
    // projType 0, globeMode false (Camera defaults) — the flat route.
    drive(cache, new Camera(0, 0, 2), 0, 1, catalogWithCached(MAXLEVEL, new Set()))
    const flatCam3 = new Camera(0, 0, 3)
    const source = catalogWithCached(MAXLEVEL, flatStepKeys(flatCam3, 3))
    const sel = drive(cache, flatCam3, 0, 2, source)
    expect(sel).not.toBeNull()
    // Flat route still probes visibleTilesSSE — seeding that set advances cz.
    // (Guards against the fix accidentally sphere-routing the flat probe: a
    // globe set would not match this seed and the gate would hold at 2.)
    expect(sel!.currentZ, 'flat route unchanged → advances on the SSE set').toBe(3)
  })
})
