// ═══ #2094 — the drape budget must read the REAL selection currentZ ═══
//
// The gate that decides whether the globe's fills bake is a PIXEL BUDGET
// (map/src/render/globe-drape-budget.ts): the direct path's chord error priced
// against the bake's own resample cost. It is fed one number from this
// subsystem — the LOD the frame actually DRAWS — and the whole thing rests on
// that mapping being `min(floor(cameraZoom), source.maxLevel)` as the engine
// computes it, not as a test wishes it. Get it wrong and the budget prices
// geometry the frame is not drawing.
//
// `map/src/render/globe-drape-budget.test.ts` owns the PREDICATE half (the closed
// form, the budget's two anchors, the #2435 peak). It cannot own this half: the
// derivation lives in `map/src/render/tile-selection-cache.ts`, and a predicate
// test can only REIMPLEMENT `min(floor(zoom), maxLevel)`, i.e. become a second
// authority that stays green whatever the engine actually computes. This file
// closes that by driving the production `TileSelectionCache.selectForFrame` and
// feeding its own `currentZ` / `targetZ` into the real predicate.
//
// Two things this pins that a level ceiling did not need to:
//   - the SOURCE CLAMP is load-bearing in both directions. Dropping it makes a
//     maxzoom-2 source at z9.7 price as if it had z9 geometry (~1 px, direct)
//     when it is really drawing z2 chords at a z9.7 scale (~20 px, drape).
//   - the hold must cross a level where the TILER's segment angle changes, or
//     both readings are the same number: z5 and z6 both subdivide to 1.40625 deg,
//     so the pair the level ceiling used could not witness anything here.

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import { drapesAtChordBudget, directChordErrorPx } from './globe-drape-budget'
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
 *  feeds to the drape budget. A FRESH cache per call: `_hysteresisZ` starts
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

describe('#2094 — the drape budget reads the production currentZ', () => {
  it('the report cameras resolve to the selection zooms the budget is priced on', () => {
    // The mapping itself, stated before it is used: `min(floor(cameraZoom),
    // source.maxLevel)`, as the engine computes it — not as this test wishes it.
    expect(currentZAt(9.7, 14), 'zoom 9.70 on a maxLevel-14 source → floor 9').toBe(9)
    expect(currentZAt(21.1, 14), 'zoom 21.10 clamps to the source ceiling 14').toBe(14)
    expect(currentZAt(9.7, 2), 'the same camera on a maxzoom-2 source clamps to 2').toBe(2)
    expect(currentZAt(2, 14), 'the globe overview').toBe(2)
  })

  it('every camera a deep source can SERVE routes direct through the real derivation', () => {
    // The #2093 report camera, plus the z0-z5 band that stayed blurry on WebGPU
    // after #2093 shipped a LEVEL ceiling (WebGL2, which never bakes, looked right
    // at the same cameras — which is how the owner spotted it).
    for (const zoom of [0, 1.4, 2, 3.2, 4, 5.4, 6.6, 8, 9.7, 12, 18, 21.1]) {
      expect(
        { zoom, drapes: drapesAtChordBudget(currentZAt(zoom, 14), zoom) },
        `a maxLevel-14 source at z${zoom} draws tiles the camera can be served at, so the ` +
          `bake's unconditional ~1 px resample buys nothing`,
      ).toEqual({ zoom, drapes: false })
    }
  })

  it('a maxzoom-2 source keeps the drape at the SAME camera (#2024 coverage survives)', () => {
    // The clamp is what makes this the OTHER answer at an identical camera: the
    // source cannot supply tiles for z9.7, so the direct arm is drawing z2 chords
    // at a z9.7 scale and the #2024 windowed bake is the only thing that can add
    // the missing detail.
    expect(directChordErrorPx(currentZAt(9.7, 2), 9.7)).toBeGreaterThan(15)
    expect(
      drapesAtChordBudget(currentZAt(9.7, 2), 9.7),
      'a maxzoom-2 source at z9.70: currentZ clamps to 2, so the drape and its #2024 ' +
        'windowed overzoom must still own this route',
    ).toBe(true)
  })

  it('SEVER: dropping the source clamp flips the maxzoom-2 answer to direct', () => {
    // The severing case the floor-vs-round camera used to be. Under the budget a
    // fractional camera moves nothing on a deep source (every native zoom is
    // direct either way), but the CLAMP is load-bearing: read the camera's own
    // floor(9.7) = 9 instead of the clamped 2 and the same frame is priced at
    // ~1 px and renders direct, drawing z2 geometry at a z9.7 scale.
    expect(currentZAt(9.7, 2), 'the engine clamps to the source maxLevel').toBe(2)
    expect(
      drapesAtChordBudget(9, 9.7),
      'the UNCLAMPED reading — what the gate would do if selectForFrame stopped clamping',
    ).toBe(false)
    expect(drapesAtChordBudget(currentZAt(9.7, 2), 9.7), 'the clamped reading').toBe(true)
  })

  it('MapLibre demotiles (maxzoom 6): direct while it can serve, draped once it cannot', () => {
    // The owner's demotiles re-check. maxzoom 6 clamps currentZ to 6 from z6 up, so
    // the error is the camera scale alone, doubling per level of camera zoom.
    //
    // #2435 moved this crossover TWO LEVELS DEEPER. The per-tile-level gate splits a
    // z6 edge to 0.7031 deg where the absolute 2 deg gate left it at 1.4062, so the
    // direct arm's error halves at every camera: z9.6 was 4.76 px (draped) and is now
    // 1.19 px (direct). The bake is not needed until z12. That is the SAME direction
    // #2094 exists for — a better direct arm wins in more places — measured here
    // rather than assumed.
    expect(currentZAt(6.2, 6)).toBe(6)
    expect(drapesAtChordBudget(currentZAt(6.2, 6), 6.2), 'demotiles at z6.2 renders direct').toBe(
      false,
    )
    expect(drapesAtChordBudget(currentZAt(8, 6), 8), 'demotiles at z8 renders direct').toBe(false)
    expect(
      drapesAtChordBudget(currentZAt(9.6, 6), 9.6),
      'demotiles at z9.6 is 1.19 px after #2435 — inside the budget, so DIRECT (it was 4.76 px)',
    ).toBe(false)
    expect(
      drapesAtChordBudget(currentZAt(11, 6), 11),
      'z11 is 3.14 px — still inside the budget',
    ).toBe(false)
    expect(
      drapesAtChordBudget(currentZAt(12, 6), 12),
      'z12 is 6.28 px — past it, so the windowed bake takes over',
    ).toBe(true)
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

describe('#2093 follow-up — the budget holds through the zoom-in readiness hold', () => {
  it('#2435 made a one- or two-level hold safe BY CONSTRUCTION, at every level', () => {
    // This test used to witness the fix at a single camera pair (8.3 → 9.6), where the
    // held and advanced readings priced 4x apart and only the held one draped. #2435
    // flattened that: the per-tile-level gate splits z7/z8/z9, so z8 and z9 now share
    // theta = 0.3516 deg and the pair prices 1x. The old witness cannot fire anywhere.
    //
    // What replaced it is stronger than what it asserted — an EXHAUSTIVE claim over the
    // whole domain instead of one camera pair. Enumerating every hold of one and two
    // levels at every level (held = t - lag, camera = t + 0.6):
    //
    //   lag 1   worst 1.190 px @ held z10, cam 11.6   never drapes
    //   lag 2   worst 2.381 px @ held z10, cam 12.6   never drapes
    //
    // So after #2435 a shallow readiness hold cannot route to the bake no matter where
    // the camera is — it is not the budget happening to land well, it is arithmetic.
    for (const lag of [1, 2]) {
      for (let t = lag; t <= 22; t++) {
        const held = t - lag
        const cam = t + 0.6
        expect({ lag, held, cam, drapes: drapesAtChordBudget(held, cam) }).toEqual({
          lag,
          held,
          cam,
          drapes: false,
        })
      }
    }
    expect(directChordErrorPx(10, 11.6)).toBeCloseTo(1.19, 2)
    expect(directChordErrorPx(10, 12.6)).toBeCloseTo(2.381, 2)
  })

  it('the max(currentZ, targetZ) read still DECIDES at a three-level hold', () => {
    // #2093's fix — the renderer prices `max(currentZ, targetZ)`, not `currentZ` alone —
    // must keep a case where the two readings disagree, or the assertion above would be
    // the only thing left and the mechanism would go unwitnessed (CLAUDE.md section 12:
    // an assertion carries information only if it distinguishes the states it tests).
    //
    // It does, three levels deep: lag 3 reaches 4.762 px at held z10 / cam 13.6, past the
    // 4 px budget. A fast zoom that outruns the readiness gate by three levels is exactly
    // the "baked tiles while zooming in" report, and this is where the fix earns its keep.
    const HELD = 10
    const CAM = 13.6
    expect(
      drapesAtChordBudget(HELD, CAM),
      'read off the HELD LOD alone the budget drapes — 4.76 px, the pre-fix reading',
    ).toBe(true)
    expect(
      drapesAtChordBudget(Math.max(HELD, Math.floor(CAM)), CAM),
      'the renderer reads max(currentZ, targetZ): the camera can be served at its own LOD, ' +
        'so the held coarse tiles draw DIRECT — crisp and over-zoomed — not as magnified bakes',
    ).toBe(false)
    expect(directChordErrorPx(HELD, CAM)).toBeCloseTo(4.762, 2)
  })

  it('the hysteresis hold is real: the gate holds the drawn LOD behind the camera', () => {
    // The selection half of the same story, kept from the original witness: with nothing
    // cached, a zoom-in leaves currentZ behind targetZ. This is what makes the two
    // readings above different inputs rather than a hypothetical.
    const sel = driveZooms([8.3, 9.6], 14)
    expect(sel.currentZ, 'the gate holds the drawn LOD at 8 while no z9 tile is cached').toBe(8)
    expect(sel.targetZ, 'the camera asks for floor(9.6) = 9').toBe(9)
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
    // A shallow source never produces a targetZ deeper than it has — the hold at 6.6
    // on a maxLevel-5 source is not a hold at all (target 5 = cz), so max() has
    // nothing to choose and the budget is left pricing z5 geometry alone. At 6.6
    // that is 0.6 px and renders direct; the SAME clamped level drapes once the
    // camera runs far enough past it, which is the whole shape of the gate.
    const clamped = driveZooms([5.3, 6.6], 5)
    expect(clamped.currentZ).toBe(5)
    expect(clamped.targetZ, 'targetZ is source-clamped like currentZ').toBe(5)
    expect(drapesAtChordBudget(Math.max(clamped.currentZ, clamped.targetZ), 6.6)).toBe(false)
    const far = driveZooms([10.0], 5)
    expect(far.currentZ, 'still clamped to the source maximum').toBe(5)
    expect(
      drapesAtChordBudget(Math.max(far.currentZ, far.targetZ), 10.0),
      'the same z5 tiles at a z10 camera are 6.3 px of chord error — the bake takes over',
    ).toBe(true)
  })

  it("the zoom-out hysteresis window: max() reads the LOD the frame draws, never the camera's", () => {
    // 6.6 → 5.7: zoom-out only releases below cz − 0.4 = 5.6, so the drawn LOD stays 6
    // while the camera's own LOD is already 5. This pins the LEVELS — the quantity the
    // budget is then priced on. Both readings are direct at these cameras (a deep
    // source at native zoom always is); the case where max() CHANGES the answer is the
    // deep hold above, which is where that claim is severed.
    const held = driveZooms([6.6, 5.7], 14)
    expect(held.currentZ, 'the drawn LOD is still 6 inside the hysteresis window').toBe(6)
    expect(held.targetZ, "the camera's own LOD has already dropped to 5").toBe(5)
    expect(Math.max(held.currentZ, held.targetZ), 'max() takes the drawn one').toBe(6)
    expect(drapesAtChordBudget(Math.max(held.currentZ, held.targetZ), 5.7)).toBe(false)
    const released = driveZooms([6.6, 5.7, 5.5], 14)
    expect(released.currentZ, 'past the release threshold the drawn LOD follows').toBe(5)
    expect(released.targetZ).toBe(5)
    expect(drapesAtChordBudget(Math.max(released.currentZ, released.targetZ), 5.5)).toBe(false)
  })
})
