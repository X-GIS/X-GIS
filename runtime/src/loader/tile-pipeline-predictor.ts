// ═══ Tile pipeline predictor — CPU-only dry-run of tile selection ═══
//
// Given a camera state + a source's `maxLevel` + a canvas size, this
// module predicts what the tile-fetch pipeline will do WITHOUT touching
// WebGPU, tile loaders, or the actual cache. It answers the specific
// questions that come up when debugging "empty screen at high pitch":
//
//   - How many tiles does `visibleTilesFrustum` want this frame?
//   - At which zoom level do they live?
//   - How deeply are we over-zoomed past the source's maxLevel?
//   - How many sub-tile generations would a cold cache need to produce
//     every visible tile? (Crossed against `XGVTSource.SUB_TILE_BUDGET`
//     — 2/frame — this tells you how many frames until convergence.)
//   - Which tiles belong to which parent at `source.maxLevel`?
//
// The predictor is pure: same inputs → same output. It's the
// CPU-testable counterpart of `inspectPipeline()` (which reports live
// runtime state). Pair them: use `predictTilePipeline` in vitest to
// reproduce a reported state; use `inspectPipeline` in DevTools to
// confirm the live instance matches.

import { Camera } from '../engine/camera'
import { mercator as mercatorProj } from '../engine/projection'
import { visibleTilesFrustum } from './tiles'

/** Hard-coded per-frame sub-tile generation cap from XGVTSource.
 *  Re-exported so the predictor's convergence math stays in sync with
 *  the runtime's actual behaviour. If XGVTSource.generateSubTile
 *  changes its cap, update this constant — a CPU test asserts the
 *  two agree (see tile-pipeline-predictor.test.ts). */
export const SUB_TILE_BUDGET_PER_FRAME = 2

export interface CameraStateInput {
  /** Longitude (degrees). */
  lon: number
  /** Latitude (degrees). Clamped to ±85.051129 (Mercator limit). */
  lat: number
  zoom: number
  /** Map bearing in degrees (0 = north-up). */
  bearing: number
  /** Pitch in degrees (0 = top-down; 85 = near-horizon). */
  pitch: number
}

export interface SourceMetaInput {
  /** Deepest zoom the source can serve as genuine data (e.g., Natural
   *  Earth 110m ≈ 7). Over-zoom past this is picked up by the runtime
   *  sub-tile generator. */
  maxLevel: number
  /** Max over-zoom allowed (default 13 — matches runtime
   *  rawMaxZoom + DSFUN precision headroom). Tiles requested at
   *  `zoom > maxLevel + overzoomBudget` still render via parent
   *  fallback if available, but sub-tile generation stops producing
   *  new levels. */
  overzoomBudget?: number
}

export interface PredictedFrame {
  /** Zoom level that `visibleTilesFrustum` rounds to for this frame
   *  (`Math.round(camera.zoom)` clamped to the source). */
  requestedZ: number
  /** Every (z, x, y) the frustum wants. Matches what the runtime's
   *  `visibleTilesFrustum` returns — reuses the same function. */
  visibleTiles: Array<{ z: number; x: number; y: number }>
  /** True when requestedZ > sourceMaxLevel — every visible tile needs
   *  sub-tile generation (no data in the source at this depth). */
  overzoom: boolean
  /** How many levels past `sourceMaxLevel` we're fetching. 0 when
   *  within source range. */
  overzoomLevels: number
  /** Parent tiles at `sourceMaxLevel` that cover the visible region.
   *  At over-zoom, each visible tile is a descendant of one of these;
   *  the runtime sub-tile path generates children of these parents. */
  parentTiles: Array<{ z: number; x: number; y: number }>
  /** Estimated frames to fully populate the visible set from a cold
   *  cache, given the per-frame sub-tile budget. A proxy for "how long
   *  will the black screen persist if we pan here". */
  coldConvergenceFrames: number
  /** Frustum diagnostics: how many tiles the frustum wants vs how
   *  many would fit in a typical GPU cache (256/512/1024). Convergence
   *  is futile when count > cache.
   *
   *  IMPORTANT: `requestedCount` comes from `visibleTilesFrustum` which
   *  applies an internal cap of MAX_FRUSTUM_TILES (300 desktop / 120
   *  mobile). When `saturated` is true the TRUE demand exceeds the cap
   *  and the fitsIn* booleans are lower bounds only — a frame that
   *  reports fitsIn512=true when saturated may still not fit.
   *  Check `saturated` before trusting the fitsIn verdict. */
  cacheCapacityCheck: {
    requestedCount: number
    /** True when requestedCount exceeds ALL the candidate cache sizes
     *  — indicates a tile-budget regime change (pitch-aware LOD or
     *  cache cap increase) is needed. */
    exceedsLargestCache: boolean
    /** True when the frustum hit the internal MAX_FRUSTUM_TILES cap.
     *  Values ≥ 120 are treated as potentially saturated (mobile cap)
     *  for safety; ≥ 300 is definitely saturated on desktop. When
     *  saturated, the fitsIn* verdicts below understate true demand. */
    saturated: boolean
    /** Quick per-cap verdicts — which caches fit the frame. Trust
     *  these ONLY when `saturated` is false. */
    fitsIn256: boolean
    fitsIn512: boolean
    fitsIn1024: boolean
  }
}

/** Predict one frame's tile-selection behaviour for a given camera +
 *  source + viewport. Pure function — no I/O, no GPU, deterministic. */
export function predictTilePipeline(
  camera: CameraStateInput,
  source: SourceMetaInput,
  canvasW: number,
  canvasH: number,
): PredictedFrame {
  // Build the same Camera instance the runtime uses so
  // visibleTilesFrustum observes identical RTC / frustum math.
  const cam = new Camera(camera.lon, camera.lat, camera.zoom)
  cam.bearing = camera.bearing
  cam.pitch = camera.pitch

  const overzoomBudget = source.overzoomBudget ?? 13
  const maxRequestable = source.maxLevel + overzoomBudget
  const requestedZ = Math.max(0, Math.min(maxRequestable, Math.round(camera.zoom)))

  const visibleTiles = visibleTilesFrustum(
    cam, mercatorProj,
    requestedZ, canvasW, canvasH,
    0, // no extra margin — the raw frustum
  )

  const overzoomLevels = Math.max(0, requestedZ - source.maxLevel)
  const overzoom = overzoomLevels > 0

  // Parent tiles at sourceMaxLevel that cover the visible set. When
  // not over-zoomed, the parents ARE the visible tiles (degenerate).
  const parentSet = new Map<string, { z: number; x: number; y: number }>()
  const shift = overzoomLevels
  for (const t of visibleTiles) {
    const px = t.x >> shift
    const py = t.y >> shift
    const pz = source.maxLevel
    const k = `${pz}/${px}/${py}`
    if (!parentSet.has(k)) parentSet.set(k, { z: pz, x: px, y: py })
  }

  // Cold convergence estimate: every visible tile needs a sub-tile
  // generation pass. Budget is 2/frame, so frames ≈ ceil(count / 2).
  // This is a lower bound — real life also needs parent tile LOAD +
  // compile time, which adds a few frames for a fresh source.
  const coldConvergenceFrames = overzoom
    ? Math.ceil(visibleTiles.length / SUB_TILE_BUDGET_PER_FRAME)
    : 0

  return {
    requestedZ,
    visibleTiles: visibleTiles.map(t => ({ z: t.z, x: t.x, y: t.y })),
    overzoom,
    overzoomLevels,
    parentTiles: [...parentSet.values()],
    coldConvergenceFrames,
    cacheCapacityCheck: {
      requestedCount: visibleTiles.length,
      exceedsLargestCache: visibleTiles.length > 1024,
      // 120 is the mobile MAX_FRUSTUM_TILES; 300 the desktop. We
      // flag ≥ 120 pessimistically — false positives are better than
      // trusting an understated count on a mobile client.
      saturated: visibleTiles.length >= 120,
      fitsIn256: visibleTiles.length <= 256,
      fitsIn512: visibleTiles.length <= 512,
      fitsIn1024: visibleTiles.length <= 1024,
    },
  }
}
