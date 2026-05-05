// TileSource — per-format backend protocol consumed by TileCatalog.
//
// Background: the layer-type refactor (plans/delegated-hopping-cray.md)
// splits the old XGVTSource god class into a TileCatalog (router/cache,
// the surface VTR talks to) and N TileSource backends (per data format).
// Each backend implements *only* the format-specific bits — fetch,
// decode, and a cheap "do I have this key?" predicate. Cache, eviction,
// budget, sub-tile generation, and the synthesised XGVTIndex stay on the
// catalog because they are format-agnostic.
//
// Protocol shape (intentionally small):
//
//   meta        — bounds + zoom range + property table contributed at
//                 attach time. Pre-known entries listed for backends
//                 with an upfront index (XGVT-binary); empty for
//                 lazy-discovery backends (PMTiles, GeoJSON-runtime).
//   has(key)    — cheap synchronous predicate. Catalog uses this to
//                 (a) answer hasEntryInIndex when no entry was
//                 preregistered, and (b) decide which backend owns a
//                 tile under multi-backend dispatch.
//   loadTile    — async producer. Backend resolves (or rejects) one
//                 tile; catalog's acceptResult wraps the BackendTileResult
//                 into TileData and fires onTileLoaded for VTR upload.
//   compileSync — OPTIONAL synchronous producer. Only the in-memory
//                 GeoJSON backend can fulfil this (raw parts +
//                 compileSingleTile run on the main thread). PMTiles
//                 and XGVT-binary cannot — would require pre-fetching
//                 archive contents, defeating their streaming model.
//                 Catalog's compileTileOnDemand walks attached backends
//                 and uses compileSync if available, else returns false
//                 (VTR's existing parent-fallback chain handles it).
//   loadTilesBatch — OPTIONAL batched fetch. Only XGVT-binary today
//                 implements this for HTTP range-request merging
//                 (8 KB gap → single request). Default-implemented in
//                 catalog as a parallel map over loadTile.
//   dispose     — OPTIONAL teardown (worker pool refs, archive handles).

import type { TileIndexEntry, PropertyTable, RingPolygon } from '@xgis/compiler'

/** Producer result delivered by a backend for one tile. Shape matches
 *  the union of fields catalog needs to call cacheTileData (or
 *  createFullCoverTileData when fullCover is set with empty vertices). */
export interface BackendTileResult {
  /** Polygon fill vertices — DSFUN stride 5. */
  vertices: Float32Array
  /** Triangle indices into `vertices`. */
  indices: Uint32Array
  /** Line vertices — DSFUN stride 10 (arc_start at [5], tangent at [6-9]). */
  lineVertices: Float32Array
  /** Line segment indices (pairs) into `lineVertices`. */
  lineIndices: Uint32Array
  /** Optional point vertices — DSFUN stride 5. */
  pointVertices?: Float32Array
  /** Optional polygon outline indices into `vertices` (legacy path). */
  outlineIndices?: Uint32Array
  /** Optional standalone outline vertices in DSFUN stride 10 (modern
   *  path with global arc_start — eliminates dash-phase resets at
   *  tile boundaries). When present, VTR prefers these over
   *  outlineIndices. */
  outlineVertices?: Float32Array
  outlineLineIndices?: Uint32Array
  /** Original rings carried along for sub-tile clipping. */
  polygons?: RingPolygon[]
  /** Set when this tile's polygon entirely covers its area. With
   *  empty vertices, catalog synthesises a quad via
   *  createFullCoverTileData. */
  fullCover?: boolean
  fullCoverFeatureId?: number
}

/** Metadata contributed by a backend at attach time. Catalog merges
 *  these across attached backends:
 *   - bounds → bounding union
 *   - {min,max}Zoom → min-of-mins + max-of-maxes
 *   - propertyTable → first non-empty wins (Phase 1; merging schemas
 *     across backends is a Phase 2 concern, see plan §1.4)
 *   - entries → registered with catalog's XGVTIndex; preregistered
 *     entries route deterministically via entryToBackend. */
export interface TileSourceMeta {
  bounds: [number, number, number, number]
  minZoom: number
  maxZoom: number
  propertyTable?: PropertyTable
  entries?: { key: number; entry: TileIndexEntry }[]
}

/** Per-format backend interface. Catalog never exposes these to VTR;
 *  they live behind TileCatalog. */
export interface TileSource {
  readonly meta: TileSourceMeta

  /** Cheap synchronous "do I have this key?" predicate. Used by
   *  catalog.hasEntryInIndex for non-preregistered keys and by
   *  multi-backend dispatch to pick the owner. Must be O(1) or
   *  near-O(1) — called per visible tile per frame. */
  has(key: number): boolean

  /** Asynchronous tile producer. Resolves with a BackendTileResult or
   *  null when this backend has no data for the key (catalog caches
   *  an empty placeholder so the renderer doesn't keep re-requesting). */
  loadTile(key: number): Promise<BackendTileResult | null>

  /** Optional: synchronous compile path. Only the in-memory GeoJSON
   *  backend implements this. Catalog's compileTileOnDemand walks
   *  attached backends and uses this if available (returns
   *  BackendTileResult to cache, or null when out of data). */
  compileSync?(key: number): BackendTileResult | null

  /** Optional: batched async fetch. Used by XGVT-binary for HTTP
   *  range-request merging. Default catalog behaviour: map over
   *  loadTile in parallel. */
  loadTilesBatch?(keys: number[]): Promise<void>

  /** Optional teardown. Called by catalog.detachBackend. */
  dispose?(): void
}
