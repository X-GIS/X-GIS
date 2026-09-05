// ═══ Flat tile selection — ONE authority for "cull space == draw space" ═══
//
// #2302. RasterRenderer, HillshadeRenderer and the zoom-direction prefetch each
// built their flat-branch selector projection inline, and all three built the
// same inert shim for the non-Mercator case:
//
//   { name: 'non-mercator', forward: mercatorProj.forward, inverse: … }
//
// `visibleTilesFrustum` never calls `projection.forward` — it culls tile corners
// in MERCATOR metres and reads `projection.name` only to look up the world-copy
// set, where 'non-mercator' is not a table name and falls back to projType 0.
// So under equirectangular / natural_earth the tiles were CULLED in Mercator
// space while `vs_tile` DREW them through the display projection on the same
// MVP. At 60°N the Mercator cull frame is 2× taller than the equirect draw
// frame, so the poleward tiles inside the viewport fell outside the cull window
// and were never selected, requested or drawn: a tile-row-quantised blank band
// at the poleward viewport edge, growing with latitude. The vector path never
// had this bug — tile-selection-cache builds the REAL projection and selects
// with the projection-aware `visibleTilesSSE` (tiles-sse.ts `projection.forward`).
//
// This module is that derivation, once. Both raster twins select through
// `selectFlatTiles`; the prefetch walk (whose `visibleTilesFrustumSampled` IS
// projection-aware and only needed the real projection object) builds its
// projection through `flatSelectorProjection`. Three copies cannot drift again.
//
// Mercator stays byte-identical: projType 0 still goes through
// `visibleTilesFrustum(camera, mercatorProj, …)` — the hot path
// raster-world-copy.test.ts pins — so this changes nothing a Mercator map draws.

import { visibleTilesFrustum, visibleTilesSSE, type TileCoord } from '@xgis/data'
import type { TileSelectionCamera } from '@xgis/data'
import {
  mercator as mercatorProj,
  getProjection,
  SELECTOR_PROJ_NAMES,
  type Projection,
} from '@xgis/geo'

/** The projection the flat-branch selector culls with, built from the SAME
 *  centre the GPU receives as `proj_params.y/z` — so a tile's cull position is
 *  its draw position. projType 0 → mercator; 1..6 → the table's projection at
 *  that centre (3..6 sphere-route before reaching a flat selector, so in
 *  practice this serves 1 equirectangular and 2 natural_earth). */
export function flatSelectorProjection(
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
): Projection {
  return projType >= 1 && projType <= 6
    ? getProjection(SELECTOR_PROJ_NAMES[projType]!, projCenterLon, projCenterLat)
    : mercatorProj
}

/** Flat-branch tile selection for the raster twins. Mercator keeps the
 *  Mercator-metre frustum cull it always had; every other flat projection
 *  selects with the projection-aware SSE walk the vector path uses, through the
 *  projection `vs_tile` draws with. */
export function selectFlatTiles(
  camera: TileSelectionCamera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  currentZ: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): TileCoord[] {
  const proj = flatSelectorProjection(projType, projCenterLon, projCenterLat)
  // Branch on the projection the table handed back, not on projType (#996): the
  // Mercator singleton keeps the frustum selector — byte-identical hot path.
  if (proj === mercatorProj)
    return visibleTilesFrustum(camera, mercatorProj, currentZ, canvasWidth, canvasHeight, 0, dpr)
  return visibleTilesSSE(camera, proj, currentZ, canvasWidth, canvasHeight, 0, dpr)
}
