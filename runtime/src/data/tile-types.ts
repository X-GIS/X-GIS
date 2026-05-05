// Shared type definitions used across the tile catalog + per-format
// backend modules. Lives separate from the catalog/source class so that
// backend implementations can import the types without pulling in the
// catalog's runtime state.
//
// History: extracted from xgvt-source.ts as Step 0 of the layer-type
// refactor (see plans/delegated-hopping-cray.md). Pure type move — zero
// behaviour change.

import type { CompiledTile, RingPolygon } from '@xgis/compiler'

// ═══ Tile data (CPU-side) ═══

/** CPU-only tile data (no GPU dependency)
 *
 * DSFUN vertex format (see docs/dsfun-refactor-plan.md):
 * - Polygon/point: [mx_h, my_h, mx_l, my_l, feat_id]                 stride 5
 * - Line:          [mx_h, my_h, mx_l, my_l, feat_id, arc_start_m]    stride 6
 *
 * (mx, my) are tile-local Mercator meters relative to tile origin,
 * split into (high, low) f32 pairs for f64-equivalent precision via
 * the shader's DSFUN subtraction (pos_h - cam_h) + (pos_l - cam_l).
 */
export interface TileData {
  vertices: Float32Array       // polygon fills — DSFUN stride 5
  indices: Uint32Array         // triangle indices
  lineVertices: Float32Array   // lines — DSFUN stride 10 (arc_start at [5], tangent at [6-9])
  lineIndices: Uint32Array     // line segment indices (pairs)
  outlineIndices: Uint32Array  // polygon outline line segments (reuses `vertices`)
  /** Polygon outline vertices in DSFUN stride 10 (matches `lineVertices`).
   *  When non-empty, VTR builds outline SDF segments from these instead
   *  of indexing into the polygon fill buffer — gives outlines the same
   *  global arc_start that line features get, fixing dash-phase resets
   *  at tile boundaries. Empty for binary .xgvt-loaded tiles and
   *  runtime-generated sub-tiles (those still use `outlineIndices`). */
  outlineVertices?: Float32Array
  outlineLineIndices?: Uint32Array
  pointVertices?: Float32Array // points — DSFUN stride 5
  tileWest: number             // tile origin (degrees) — canonical identity
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  polygons?: RingPolygon[]     // original rings (for sub-tiling)
}

// Stride constants (exported for tests + VTR upload paths)
export const DSFUN_POLY_STRIDE = 5
export const DSFUN_LINE_STRIDE = 10

// ═══ Catalog-level constants ═══

/** Soft cap on cached TileData entries before eviction kicks in. */
export const MAX_CACHED_TILES = 512

/** Hard cap on simultaneous in-flight tile fetches across all backends. */
export const MAX_CONCURRENT_LOADS = 32

// ═══ VirtualCatalog (legacy hook — to be replaced by TileSource in Step 3) ═══

/** External tile producer for {@link XGVTSource.setVirtualCatalog}.
 *  Returns a CompiledTile (or null when the source has no data for
 *  this z/x/y) on demand. The fetcher is invoked lazily by
 *  requestTiles when the renderer asks for a tile that isn't
 *  cached and isn't in the catalog index. Used by the PMTiles
 *  adapter; the same hook serves any future on-demand backing
 *  (custom MVT server, Tippecanoe directory, etc.).
 *
 *  @deprecated Step 3 of the layer-type refactor replaces this with
 *  the TileSource interface. Kept as a back-compat shim until then. */
export type VirtualTileFetcher = (
  z: number, x: number, y: number,
) => Promise<CompiledTile | null>

/** @deprecated see {@link VirtualTileFetcher}. */
export interface VirtualCatalog {
  fetcher: VirtualTileFetcher
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
}
