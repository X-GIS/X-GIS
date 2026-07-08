// ═══ World-scale constants — backend-NEUTRAL (#832 engine neutrality) ═══
//
// Extracted from gpu-shared.ts so the projection/camera core can consume them
// without importing the WebGPU-typed pipeline-state module (gpu-shared lives
// in the engine's WebGPU zone; this file lives in the neutral core, where the
// compiler forbids WebGPU types outright). gpu-shared re-exports both names,
// so every existing import site is unchanged.

import { EARTH } from '@xgis/shared'

/** Earth circumference in Mercator meters (pinned literal, from the shared Body). */
export const WORLD_MERC = EARTH.worldMerc

/** Tile pixel size used as the anchor of the
 *  `metersPerPixel = WORLD_MERC / TILE_PX / 2^zoom` formula.
 *
 *  Set to 512 to match the Mapbox / MapLibre convention — sharing
 *  the same numeric `zoom` value between the two engines now
 *  produces the same `m/px` ground sampling, so hash URLs and
 *  authored `view zoom: N` values transfer 1:1 between X-GIS and
 *  the reference implementation. Previously this lived as a literal
 *  `256` scattered across 8+ call sites, which made X-GIS render at
 *  one effective zoom level closer than MapLibre for the same hash. */
export const TILE_PX = 512
