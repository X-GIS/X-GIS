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
// under `Math.round` a camera at zoom 5.60 resolves to currentZ 6 and goes
// DIRECT one level below the ceiling, where the whole-hemisphere arcs still
// curve visibly (projections-table.ts quotes the budget).

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
    // overzoom. This is the derivation working (over-zooming a shallow source
    // multiplies the chord error by 2^Δz), and it is what makes the dark/globe
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

  it('MapLibre demotiles (maxzoom 6) reaches the ceiling exactly — direct at every camera ≥ 6', () => {
    // The owner's demotiles re-check: a maxzoom-6 source clamps currentZ to 6 at
    // z9.6, which IS the ceiling, so it renders direct — the #2024 windowed bake
    // no longer owns that route. One level shallower (maxzoom 5) still drapes.
    expect(currentZAt(9.6, 6)).toBe(6)
    expect(drapesAtSelectionZ(currentZAt(9.6, 6)), 'demotiles at z9.6 renders direct').toBe(false)
    expect(currentZAt(6.2, 6)).toBe(6)
    expect(drapesAtSelectionZ(currentZAt(6.2, 6)), 'demotiles at z6.2 renders direct').toBe(false)
    expect(drapesAtSelectionZ(currentZAt(9.6, 5)), 'a maxzoom-5 source keeps the drape').toBe(true)
  })

  it('currentZ is FLOOR-based: a camera under the integer boundary still drapes', () => {
    // The severing case. Under `Math.round` — which the derivation's own comment
    // still advertises — this camera resolves to currentZ 6 and goes DIRECT one
    // level below the ceiling, where a tile-spanning edge is already 5.7 % off at
    // the frame edge and the hemisphere arcs curve ~10 px (projections-table.ts).
    // Every other camera in this file is round/floor agnostic, so without this
    // case the whole file greens under a round restore.
    expect(currentZAt(5.6, 14), 'zoom 5.60 must floor to 5, not round to 6').toBe(5)
    expect(
      drapesAtSelectionZ(currentZAt(5.6, 14)),
      'zoom 5.60 draws tiles at z5, one level below the ceiling — so it must keep the drape. ' +
        'Seeing DIRECT here means the currentZ derivation in tile-selection-cache.ts stopped ' +
        'being floor-based (its comment still says "Round-based currentZ"), and the LOD ' +
        'ceiling is now applied to a tile zoom the frame does not draw.',
    ).toBe(true)
  })

  it('GLOBE_DIRECT_MIN_SELECTION_Z no longer tracks BAKE_PX (the bake texel is not the budget)', () => {
    // The first derivation compared the chord's RADIAL dip against one bake texel
    // and put the ceiling at ceil(log2(BAKE_PX·π/4)) = 9 — the dip lies along the
    // view ray and is not what the eye sees. The ceiling is now the reference-
    // engine parity point (projections-table.test.ts T4 owns that pin); this
    // guards that nobody re-derives it from the bake resolution: with BAKE_PX
    // still 512 the old formula gives 9, and the constant must NOT equal it.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'vector-drape-renderer.ts'),
      'utf8',
    )
    const m = /^const BAKE_PX = (\d+)$/m.exec(src)
    expect(m, 'could not read `const BAKE_PX` from vector-drape-renderer.ts').not.toBeNull()
    const bakePx = Number(m![1])
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).toBe(6)
    expect(GLOBE_DIRECT_MIN_SELECTION_Z).not.toBe(Math.ceil(Math.log2(bakePx * (Math.PI / 4))))
  })
})

// ═══ #2093 follow-up — the ceiling must hold through the zoom-in READINESS HOLD ═══
//
// `currentZ` is hysteresed: on a zoom-in the readiness gate holds the OLD LOD until
// every visible tile at the next LOD is cached (up to READINESS_TIMEOUT_MS). Read off
// `currentZ` alone, a camera that has crossed the ceiling with the hold still one
// level under it kept DRAPING — 512px bakes of the held tiles magnified 2^Δzoom× — which is
// the "baked tiles while zooming in" report that followed #2086. The Selection now
// also carries `targetZ`, the camera's own `min(floor(zoom), maxLevel)`, and the
// renderer feeds the predicate `max(currentZ, targetZ)`.

/** Drive ONE cache through `zooms` frame by frame on a catalog with NOTHING cached —
 *  so every zoom-in step is a readiness HOLD — and return the last Selection. */
function driveZooms(zooms: number[], sourceMaxLevel: number) {
  const source = catalogWithMaxLevel(sourceMaxLevel)
  const cache = new TileSelectionCache()
  let last: ReturnType<TileSelectionCache['selectForFrame']> = null
  zooms.forEach((zoom, i) => {
    last = cache.selectForFrame(
      globeCam(zoom),
      PROJ_GLOBE,
      REPORT_CENTER.lon,
      REPORT_CENTER.lat,
      W,
      H,
      DPR,
      i + 1,
      source,
      '',
      MARGIN,
      sourceMaxLevel,
      NO_STATS,
    )
    if (last === null) throw new Error(`selectForFrame returned null at zoom ${zoom}`)
  })
  return last!
}

describe('#2093 follow-up — the ceiling holds through the zoom-in readiness hold', () => {
  it('a hold past the ceiling: currentZ stays at 5, targetZ carries the camera LOD 6', () => {
    const sel = driveZooms([5.3, 6.6], 14)
    expect(sel.currentZ, 'the gate holds the drawn LOD at 5 while no z6 tile is cached').toBe(5)
    expect(sel.targetZ, 'the camera asks for floor(6.6) = 6').toBe(6)
    expect(
      drapesAtSelectionZ(sel.currentZ),
      'read off the HELD LOD alone the ceiling still drapes — the pre-fix reading, kept as ' +
        'the statement of what a currentZ-only gate saw during the hold',
    ).toBe(true)
    expect(
      drapesAtSelectionZ(Math.max(sel.currentZ, sel.targetZ)),
      'the renderer reads max(currentZ, targetZ): a camera past the ceiling draws its held z5 ' +
        'tiles DIRECT — crisp and over-zoomed — instead of as 3×-magnified bakes',
    ).toBe(false)
  })

  it('targetZ equals currentZ outside a hold — cold camera, and under the source clamp', () => {
    for (const [zoom, maxLevel, expected] of [
      [9.6, 14, 9],
      [6.6, 14, 6],
      [21.1, 14, 14],
      [9.7, 2, 2],
      [2, 14, 2],
    ] as const) {
      const sel = driveZooms([zoom], maxLevel)
      expect(sel.currentZ, `cold camera z${zoom} / maxLevel ${maxLevel}`).toBe(expected)
      expect(sel.targetZ, `targetZ at z${zoom} / maxLevel ${maxLevel}`).toBe(expected)
    }
    // A source that cannot reach the ceiling never produces a targetZ that does —
    // the hold at 6.6 on a maxLevel-5 source is not a hold at all (target 5 = cz).
    const clamped = driveZooms([5.3, 6.6], 5)
    expect(clamped.currentZ).toBe(5)
    expect(clamped.targetZ, 'targetZ is source-clamped like currentZ').toBe(5)
    expect(drapesAtSelectionZ(Math.max(clamped.currentZ, clamped.targetZ))).toBe(true)
  })

  it('the zoom-out hysteresis window keeps the direct arm — max() never demotes', () => {
    // 6.6 → 5.7: zoom-out only releases below cz − 0.4 = 5.6, so the drawn LOD stays 6
    // while the camera's own LOD is already 5. max() keeps the direct arm on the z6
    // tiles the frame draws (today's behaviour); the flip happens with the LOD.
    const held = driveZooms([6.6, 5.7], 14)
    expect(held.currentZ).toBe(6)
    expect(held.targetZ).toBe(5)
    expect(drapesAtSelectionZ(Math.max(held.currentZ, held.targetZ))).toBe(false)
    const released = driveZooms([6.6, 5.7, 5.5], 14)
    expect(released.currentZ).toBe(5)
    expect(released.targetZ).toBe(5)
    expect(drapesAtSelectionZ(Math.max(released.currentZ, released.targetZ))).toBe(true)
  })
})
