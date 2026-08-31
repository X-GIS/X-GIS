// ═══ #2093 — the LOD ceiling must read the REAL selection currentZ ═══
//
// `GLOBE_DIRECT_MIN_SELECTION_Z` is an integer on the TILE zoom axis, and the
// whole fix rests on one mapping: the `currentZ` the renderer hands to
// `drapesAtSelectionZ` (vector-tile-renderer.ts destructures it from the very
// Selection this file drives) is `floor(cameraZoom)` clamped to the source's
// `maxLevel`. Get that mapping wrong and the ceiling lands on the wrong camera —
// which is exactly what happened once on this branch: a ROUND-based reading of
// currentZ put the ceiling at 10, so the #2093 report camera (zoom 9.70 →
// floor → 9) kept draping, the one camera the issue was filed for.
//
// `geo/src/projections-table.test.ts` owns the PREDICATE half (the chord-sagitta
// arithmetic and the constant). It cannot own this half: the derivation lives in
// `map/src/render/tile-selection-cache.ts` and map depends on geo, never the
// reverse — so a geo-side test can only REIMPLEMENT `min(floor(zoom), maxLevel)`,
// i.e. become a second authority that stays green whatever the engine computes.
// This file closes that by driving the production `TileSelectionCache
// .selectForFrame` and feeding its own `currentZ` into `drapesAtSelectionZ`.
//
// The invitation this gates is live, not hypothetical: tile-selection-cache.ts's
// own comment above the derivation still reads "Round-based currentZ with
// anti-oscillation hysteresis" (the `Math.round` semantics it describes were
// reverted to plain `floor` on 2026-05-15 for MapLibre vector-source parity, and
// the prose was never updated). The `floor` case below is the one that severs:
// under `Math.round` a camera at zoom 8.60 resolves to currentZ 9 and goes
// DIRECT, where the chord sagitta still dominates the bake texel.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import { GLOBE_DIRECT_MIN_SELECTION_Z, drapesAtSelectionZ } from '@xgis/geo'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

const W = 1024
const H = 768
/** The report camera's dpr. `currentZ` does not depend on it (the selector's
 *  tile fan-out does), but the arms below are the reported frame's. */
const DPR = 2
const MARGIN = 2
const PROJ_GLOBE = 7

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

/** The #2093 report camera's centre — the hash the issue was filed with
 *  (`#9.70/37.54704/126.81412`). */
const REPORT_CENTER = { lon: 126.81412, lat: 37.54704 }

/** Catalog exposing only what `selectForFrame`'s currentZ derivation + the flat/
 *  sphere selector walk read. `hasEntryInIndex` false so the ancestor walk
 *  injects nothing; `hasTileData` false so no readiness state is seeded. */
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

function globeCam(zoom: number): Camera {
  const c = new Camera(REPORT_CENTER.lon, REPORT_CENTER.lat, zoom)
  c.projType = PROJ_GLOBE
  c.globeMode = true
  c.pitch = 0
  return c
}

/** Drive the REAL per-frame selection and return the `currentZ` the renderer
 *  feeds to `drapesAtSelectionZ`. A FRESH cache per call: `_hysteresisZ` starts
 *  at -1, which is the cold-camera branch — the frame's own `floor(cameraZoom)`,
 *  with no held LOD from a previous frame in it. */
function currentZAt(cameraZoom: number, sourceMaxLevel: number): number {
  const source = catalogWithMaxLevel(sourceMaxLevel)
  const sel = new TileSelectionCache().selectForFrame(
    globeCam(cameraZoom),
    PROJ_GLOBE,
    REPORT_CENTER.lon,
    REPORT_CENTER.lat,
    W,
    H,
    DPR,
    1,
    source,
    '',
    MARGIN,
    sourceMaxLevel,
    NO_STATS,
  )
  if (sel === null) {
    throw new Error(
      `selectForFrame returned null at zoom ${cameraZoom} / maxLevel ${sourceMaxLevel} — ` +
        `the slice was culled, so there is no currentZ to judge the ceiling on`,
    )
  }
  return sel.currentZ
}

describe('#2093 — the drape LOD ceiling reads the production currentZ', () => {
  it('the report cameras resolve to the selection zooms the ceiling was derived for', () => {
    // The mapping itself, stated before it is used: `min(floor(cameraZoom),
    // source.maxLevel)`, as the engine computes it — not as this test wishes it.
    expect(currentZAt(9.7, 14), 'zoom 9.70 on a maxLevel-14 source → floor 9').toBe(9)
    expect(currentZAt(21.1, 14), 'zoom 21.10 clamps to the source ceiling 14').toBe(14)
    expect(currentZAt(9.7, 2), 'the same camera on a maxzoom-2 source clamps to 2').toBe(2)
    expect(currentZAt(2, 14), 'the globe overview').toBe(2)
  })

  it('both #2093 report cameras route DIRECT through the real derivation', () => {
    expect(
      drapesAtSelectionZ(currentZAt(9.7, 14)),
      `#2093 native-zoom camera (${REPORT_CENTER.lon}/${REPORT_CENTER.lat} @ z9.70, source ` +
        `maxLevel 14). This is the camera the issue was filed for: a currentZ derivation that ` +
        `lands below GLOBE_DIRECT_MIN_SELECTION_Z (${GLOBE_DIRECT_MIN_SELECTION_Z}) here puts ` +
        `the 512px bake back on the reported frame.`,
    ).toBe(false)
    expect(
      drapesAtSelectionZ(currentZAt(21.1, 14)),
      '#2093 deep-overzoom camera (z21.10) — currentZ clamps to the source ceiling, which is ' +
        'still far above the LOD ceiling, so the direct arm owns this frame too',
    ).toBe(false)
  })

  it('a maxzoom-2 source keeps the drape at the SAME camera (#2024 coverage survives)', () => {
    // The ceiling is SOURCE-CLAMPED, so a shallow source can never reach it from
    // any camera and keeps the great-circle hug — and with it the #2024 windowed
    // overzoom. This is the derivation working, and it is what makes the dark/globe
    // scenes' synthetic maxLevel-0 sources legitimately keep draping.
    expect(
      drapesAtSelectionZ(currentZAt(9.7, 2)),
      'a maxzoom-2 source at z9.70: currentZ clamps to 2, far below the ceiling, so the drape ' +
        'and its #2024 windowed overzoom must still own this route',
    ).toBe(true)
    expect(
      drapesAtSelectionZ(currentZAt(2, 14)),
      'the globe overview keeps the great-circle drape — below the ceiling the hug is worth ' +
        'its blur',
    ).toBe(true)
  })

  it('currentZ is FLOOR-based: a camera under the integer boundary still drapes', () => {
    // The severing case. Under `Math.round` — which the derivation's own comment
    // still advertises — this camera resolves to currentZ 9 and goes DIRECT, at a
    // tile zoom where the chord sagitta (0.0123 CSS px at Z=8.6) is still WIDER
    // than the bake texel (0.0106). Every other camera in this file is round/floor
    // agnostic (9.70 → 9 or 10, both direct; 21.10 and 9.70@maxLevel-2 both clamp),
    // so without this case the whole file greens under a round restore.
    expect(currentZAt(8.6, 14), 'zoom 8.60 must floor to 8, not round to 9').toBe(8)
    expect(
      drapesAtSelectionZ(currentZAt(8.6, 14)),
      'zoom 8.60 draws tiles at z8, where the chord sagitta still exceeds one bake texel — ' +
        'so it must keep the drape. Seeing DIRECT here means the currentZ derivation in ' +
        'tile-selection-cache.ts stopped being floor-based (its comment still says ' +
        '"Round-based currentZ"), and the LOD ceiling is now applied to a tile zoom the ' +
        'frame does not draw.',
    ).toBe(true)
  })

  it('GLOBE_DIRECT_MIN_SELECTION_Z is the BAKE_PX crossover (drift pin)', () => {
    // The ceiling's derivation compares the drape's bake texel against the direct
    // arm's chord sagitta. Both are the tile's ON-SCREEN SPAN times something, so
    // the span — and with it TILE_PX — cancels: C/B = (BAKE_PX·π/4)·2^−z. The
    // governing constant is therefore the DRAPE BAKE resolution, which lives here
    // in map/ and is mirrored (not imported) by the geo-side predicate test.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'vector-drape-renderer.ts'),
      'utf8',
    )
    const m = /^const BAKE_PX = (\d+)$/m.exec(src)
    expect(m, 'could not read `const BAKE_PX` from vector-drape-renderer.ts').not.toBeNull()
    const bakePx = Number(m![1])
    const halved = Math.ceil(Math.log2((bakePx / 2) * (Math.PI / 4)))
    expect(
      GLOBE_DIRECT_MIN_SELECTION_Z,
      `the drape bakes each tile into a ${bakePx}px texture, so one texel is the tile's ` +
        `on-screen span / ${bakePx} while its chord sagitta is span·(2π·2^−z)/8 — the span ` +
        `cancels and the crossover is ceil(log2(BAKE_PX·π/4)). Halving the bake to ` +
        `${bakePx / 2}px would move the crossover to ${halved}, and the ceiling must move ` +
        `with it or the drape is kept past the point where its own texel is the blurrier error.`,
    ).toBe(Math.ceil(Math.log2(bakePx * (Math.PI / 4))))
  })
})
