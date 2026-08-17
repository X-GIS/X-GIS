// #1791 — the azimuthal disc-detail boost (ortho/azimuthal_eq/stereographic,
// projType 3/4/5) computes `selMaxZ` from screen size alone
// (tile-selection-cache.ts:736-742) and, pre-fix, never re-clamped it to the
// source's `maxLevel` after the general `cz` clamp at line ~589. A source
// whose maxLevel sits below the boosted ceiling then received tile requests
// EXCLUSIVELY at the over-boosted z — every candidate has tz > maxLevel, so
// none is a servable in-archive request. Measured witness: canvas 580x800
// (boost -> 3) = 0 tiles from all 3 sources (mirror maxzoom 2); canvas
// 480x500 (boost -> 2) unaffected = 52 tiles.
//
// The derivation below is EXACT, not probabilistic. globeVisibleTiles'
// `forceDescend = tz < maxZ && (tz <= 2 || containsTarget)`
// (data/src/globe-visible-tiles.ts:422) unconditionally subdivides every
// z<=2 node whenever maxZ > tz, so for any maxZ in {2, 3} the ONLY tiles
// that can reach the emit gate are leaves at EXACTLY tz === maxZ — the
// selected set's z is deterministic by construction, independent of the
// disc's exact on-screen footprint (which branch of globeVisibleTiles
// fires — the deterministic overzoom-bbox shortcut or the recursive
// descent — does not change this: both can only emit at tz === maxZ here).
// The lone-target tile (`containsTarget`) is always emitted regardless of
// front/on-screen culling, so the selection is also guaranteed non-empty.

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

const W = 580
const H = 800
const DPR = 1
const MARGIN = 2
const PROJ_TYPE_ORTHO = 3

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

function catalogWithMaxLevel(maxLevel: number): TileCatalog {
  return {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
    indexGeneration: () => 0,
  } as unknown as TileCatalog
}

function orthoCam(): Camera {
  // lon0/lat0, zoom 0 — well below the disc-detail floor for this canvas,
  // so the boost is guaranteed to fire (camera.zoom < discDetailFloor).
  const c = new Camera(0, 0, 0)
  c.projType = PROJ_TYPE_ORTHO
  c.pitch = 0
  return c
}

function select(source: TileCatalog): ReturnType<TileSelectionCache['selectForFrame']> {
  const cache = new TileSelectionCache()
  return cache.selectForFrame(
    orthoCam(),
    PROJ_TYPE_ORTHO,
    0,
    0,
    W,
    H,
    DPR,
    1,
    source,
    '',
    MARGIN,
    source.maxLevel,
    NO_STATS,
  )
}

describe('#1791 — azimuthal disc-detail boost re-clamps to source maxLevel', () => {
  it('fail-before witness: the unclamped boost target exceeds a shallow source maxLevel', () => {
    // Same formula as tile-selection-cache.ts:737/740 — the exact ceiling
    // the pre-fix code fed to globeVisibleTiles as `maxZ` with no re-clamp
    // to source.maxLevel.
    const discDetailFloor = Math.log2(Math.max(W, H) / 128)
    const unclampedBoost = Math.max(0, Math.ceil(discDetailFloor))
    expect(unclampedBoost, 'boost target for a 580x800 canvas is 3').toBe(3)
    expect(
      unclampedBoost,
      'a maxLevel=2 source cannot serve z=3 — the unservable ceiling #1791 reports',
    ).toBeGreaterThan(2)
  })

  it('maxLevel=2: selection lands exactly on the source ceiling, non-empty', () => {
    const sel = select(catalogWithMaxLevel(2))
    expect(sel).not.toBeNull()
    expect(sel!.tiles.length, 'selection must not be empty').toBeGreaterThan(0)
    for (const t of sel!.tiles) {
      // Pre-fix every tile here would be z===3 (the derivation above) —
      // 3 > maxLevel(2), i.e. every candidate classifies over-zoom and none
      // is a directly servable in-archive request (the #1791 symptom).
      expect(t.z, 'boost must never exceed source.maxLevel').toBeLessThanOrEqual(2)
    }
    expect(
      Math.max(...sel!.tiles.map((t) => t.z)),
      'boost still raises detail up to the source ceiling',
    ).toBe(2)
  })

  it('maxLevel=6 (control): boost applies unchanged, unaffected by the new clamp', () => {
    const sel = select(catalogWithMaxLevel(6))
    expect(sel).not.toBeNull()
    expect(sel!.tiles.length).toBeGreaterThan(0)
    // sourceMaxLevel(6) >= boost target(3), so Math.min(sourceMaxLevel, ...)
    // is a no-op — the #1791 clamp must not touch this case (non-vacuous
    // control: the boost still RAISES detail, same as pre-fix).
    expect(
      Math.max(...sel!.tiles.map((t) => t.z)),
      'boost is untouched when the source ceiling exceeds the target',
    ).toBe(3)
  })
})
