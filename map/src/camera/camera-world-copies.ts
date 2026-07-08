// ═══ Visible-world-copy enumeration — extracted from camera.ts ═══
//
// Pure function extracted verbatim from `Camera.getVisibleWorldCopies`.
// The cache state (matrixId + result) is owned by the caller via the
// `WorldCopiesCache` object; this module contains ZERO mutable state.
//
// Imports shared geo primitives (globe, projections-table) from @xgis/engine.

import {
  EARTH_R,
  isGlobeProj,
  isMercatorProj,
  worldCopiesFor,
  enumerateWorldCopies,
} from '@xgis/engine'

/** Mutable cache object owned by the caller (Camera). Passed by reference so
 *  the pure function can read + update the hit/miss state without keeping its
 *  own statics. Initialised once on Camera construction. */
export interface WorldCopiesCache {
  matrixId: number
  cached: readonly number[]
}

/** Minimal camera surface the function reads. Structurally satisfied by
 *  `Camera` — no nominal subtype needed. */
export interface WorldCopiesHost {
  readonly globeMode: boolean
  readonly projType: number
  readonly zoom: number
  readonly centerX: number
  /** Trigger an RTC matrix build (if needed) and return the current
   *  `_mvpGeneration` counter. Camera exposes this via its public
   *  `buildMatrixAndGetGeneration` helper so the function can drive the
   *  build without accessing private state. */
  buildMatrixAndGetGeneration(canvasWidth: number, canvasHeight: number, dpr: number): number
  unprojectToZ0(sx: number, sy: number, w: number, h: number, dpr: number): [number, number] | null
}

/** iter-189 — world-copy root fix. Single source of truth for
 *  "which world copies are visible this frame", consumed by every
 *  CPU-projected path (labels, raster tile draw, point markers,
 *  overlays). Replaces the four+ inlined `[0, -1, 1, -2, 2]`
 *  enumerations that diverged whenever a new renderer landed
 *  (iter-188 found two with a hardcoded `break` after the first
 *  copy that fit).
 *
 *  Algorithm: unproject the four NDC corners to the z=0 plane,
 *  add the camera centre to recover absolute Mercator x, convert
 *  to longitude, then enumerate integer 360°-offsets that fall
 *  inside `[minLon, maxLon]`. Clamped to ±2 worlds since the
 *  polygon vertex shader's WORLD_COPIES constant pins that ceiling.
 *
 *  Globe + the azimuthal discs (3/4/5) collapse to `[0]` — there is no
 *  cylindrical world wrap to enumerate. The x-periodic flat non-Mercator
 *  set (equirect 1 / natural_earth 2 / oblique_mercator 6) DOES wrap:
 *  return the SAME zoom-gated periodic copy set the tile selector emits
 *  (worldCopiesFor, gated by enumerateWorldCopies) so the CPU label
 *  projector fans out anchors over the same copies the GPU fills draw.
 *  Above WORLD_COPY_MAX_ZOOM (or globe) it collapses to `[0]`. */
export function computeVisibleWorldCopies(
  cam: WorldCopiesHost,
  cache: WorldCopiesCache,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): readonly number[] {
  if (cam.globeMode) return [0]
  // x-periodic flat non-Mercator (1/2/6): mirror the tile-enumeration gate
  // exactly — worldCopiesFor() at zoom ≤ WORLD_COPY_MAX_ZOOM, else [0]. The
  // off-screen copies are NDC-culled downstream by the label projector, so
  // returning the full ±2 set (not a corner-derived range) keeps label
  // copies byte-identical to the tile/fill copies. Mercator (0) keeps the
  // corner-unprojection path below; azimuthal/globe (3/4/5/7) return [0] via
  // enumerateWorldCopies(periodic=false).
  if (!isMercatorProj(cam.projType)) {
    return enumerateWorldCopies(cam.projType, cam.zoom) ? worldCopiesFor(cam.projType) : [0]
  }
  // Build matrix (also bumps the generation counter when matrix changed). Use
  // the post-build generation as a "matrix identity" hash for the cache — if
  // the generation is stable, the corner unprojections are stable to re-use.
  const matrixId = cam.buildMatrixAndGetGeneration(canvasWidth, canvasHeight, dpr)
  if (matrixId === cache.matrixId) return cache.cached
  // Unproject the four canvas corners to z=0 plane. Mid-edge
  // samples help when extreme pitch makes the canvas corners
  // project behind-camera (returns null) — at least one mid-edge
  // usually still hits the ground plane.
  const w = canvasWidth,
    h = canvasHeight
  const samples: Array<[number, number] | null> = [
    cam.unprojectToZ0(0, 0, w, h, dpr),
    cam.unprojectToZ0(w, 0, w, h, dpr),
    cam.unprojectToZ0(w, h, w, h, dpr),
    cam.unprojectToZ0(0, h, w, h, dpr),
    cam.unprojectToZ0(w / 2, 0, w, h, dpr),
    cam.unprojectToZ0(w / 2, h, w, h, dpr),
    cam.unprojectToZ0(0, h / 2, w, h, dpr),
    cam.unprojectToZ0(w, h / 2, w, h, dpr),
    cam.unprojectToZ0(w / 2, h / 2, w, h, dpr),
  ]
  const R = EARTH_R
  const DEG_PER_M = 180 / Math.PI / R
  let lonMin = Infinity,
    lonMax = -Infinity
  for (const s of samples) {
    if (!s) continue
    const absMercX = s[0] + cam.centerX
    const lon = absMercX * DEG_PER_M
    if (lon < lonMin) lonMin = lon
    if (lon > lonMax) lonMax = lon
  }
  if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) {
    cache.cached = [0]
    cache.matrixId = matrixId
    return cache.cached
  }
  // Convert lon range to world-offset range. Offset N corresponds
  // to lon range [N*360 - 180, N*360 + 180]. So a sample at
  // lon=540° is in world copy +1 (since 540 = 360 + 180). The
  // offset for a given lon is `Math.round(lon / 360)`.
  const woMin = Math.max(-2, Math.floor((lonMin + 180) / 360))
  const woMax = Math.min(2, Math.ceil((lonMax - 180) / 360))
  const out: number[] = []
  for (let wo = woMin; wo <= woMax; wo++) out.push(wo)
  // Always include 0 — non-degenerate visible camera should see
  // the primary copy at minimum. Defensive guard for tiny
  // viewports / extreme zoom where the lon range collapses inside
  // one copy and the floor/ceil arithmetic returns an empty range.
  if (out.length === 0 || (!out.includes(0) && Math.abs(woMin) <= 2 && Math.abs(woMax) <= 2)) {
    if (!out.includes(0)) out.push(0)
  }
  cache.cached = out
  cache.matrixId = matrixId
  return cache.cached
}

/** Check whether `projType` is handled by the globe-mode path (no world
 *  copies). Re-exported from projections-table for callers that import this
 *  module. */
export { isGlobeProj }
