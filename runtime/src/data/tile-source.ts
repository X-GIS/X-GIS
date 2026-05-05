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
// Result delivery is push-based via TileSourceSink (set at attach time)
// rather than promise-return. Reason: the XGVT-binary backend batches
// many tiles into one HTTP range request and decodes them in parallel —
// a per-tile promise interface would force either re-fanning that work
// or giving up the batch optimisation. Push-based sink lets each
// backend dispatch results in whatever shape fits its native fetch
// model.
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
//   attach(sink) — wire the backend to the catalog's result sink. Called
//                 once at attachBackend time. After this, loadTile /
//                 loadTilesBatch / compileSync may dispatch results.
//   loadTile    — fire-and-forget async producer. Backend pushes the
//                 result (or null for missing) to sink.acceptResult
//                 when ready.
//   compileSync — OPTIONAL synchronous producer. Only the in-memory
//                 GeoJSON backend can fulfil this. Backend pushes the
//                 result to the sink during the call. Returns true if
//                 anything was pushed (success OR cached-empty), false
//                 if backend cannot serve this key.
//   loadTilesBatch — OPTIONAL batched fetch. XGVT-binary uses it for
//                 HTTP range-request merging. Default catalog behaviour:
//                 map over loadTile.
//   detach      — OPTIONAL teardown (worker pool refs, archive handles).

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
  /** Pre-built SDF line-segment buffer (LINE_SEGMENT_STRIDE_F32 floats
   *  per segment) ready for GPU upload. Backends that run the heavy
   *  buildLineSegments call off-thread (MVT worker pool) populate this
   *  so doUploadTile skips it on the main thread. Undefined → main
   *  thread builds segments from lineVertices/lineIndices on upload. */
  prebuiltLineSegments?: Float32Array
  /** Same as prebuiltLineSegments but for polygon outline strokes. */
  prebuiltOutlineSegments?: Float32Array
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

/** Catalog-side push surface that backends use to deliver tile results.
 *  All operations are non-throwing; the catalog is responsible for
 *  error handling at the dispatch boundary. */
export interface TileSourceSink {
  /** Mark a tile as in-flight (back-pressure dedup + pending-load count). */
  trackLoading(key: number): void
  /** Tile work finished (success, miss, or error) — release the slot. */
  releaseLoading(key: number): void
  /** True if catalog already has this key cached — backends call this
   *  to short-circuit duplicate fetches. */
  hasTileData(key: number): boolean
  /** Number of tiles currently in-flight across the catalog. Backends
   *  consult this for self-limiting (the catalog's own MAX_CONCURRENT
   *  cap is the authoritative gate, but backends can defer work
   *  internally too). */
  getLoadingCount(): number
  /** Push the produced tile to the cache. Catalog's acceptResult
   *  synthesises an XGVTIndex entry (if absent), routes to
   *  cacheTileData or createFullCoverTileData as appropriate, and
   *  fires onTileLoaded for VTR upload.
   *
   *  `sourceLayer` (optional) — when set, the result is stored
   *  under (key, sourceLayer) so a single source can hold multiple
   *  per-MVT-layer slices for one tile key. PMTiles emits a
   *  separate result per MVT layer; xgis layers with their own
   *  `sourceLayer` filter pull the matching slice. Undefined =
   *  catch-all slice (legacy single-layer sources).
   *
   *  Pass null result when the backend determined this key has no
   *  data — catalog caches an empty placeholder so the renderer
   *  doesn't keep re-requesting. */
  acceptResult(key: number, result: BackendTileResult | null, sourceLayer?: string): void
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

  /** Wire the backend to the catalog's result sink. Called once at
   *  attachBackend time. After this, loadTile / loadTilesBatch /
   *  compileSync may push results via the sink. */
  attach(sink: TileSourceSink): void

  /** Fire-and-forget async producer. Backend pushes the result to
   *  sink.acceptResult when ready. */
  loadTile(key: number): void

  /** OPTIONAL synchronous compile path. Backends without sync data
   *  (PMTiles, XGVT-binary) omit this. Returns true if the backend
   *  pushed something (BackendTileResult or empty placeholder), false
   *  if it cannot serve this key. */
  compileSync?(key: number): boolean

  /** OPTIONAL batched async fetch. Used by XGVT-binary for HTTP
   *  range-request merging. */
  loadTilesBatch?(keys: number[]): void

  /** OPTIONAL teardown. Called by catalog.detachBackend. */
  detach?(): void

  /** OPTIONAL per-frame drain for backends that defer expensive
   *  decode/compile work after fetch (PMTiles). Catalog invokes this
   *  once per frame in resetCompileBudget with a budget hint —
   *  backend should process at most that many queued items, pushing
   *  results via sink.acceptResult. Backends that compile inline
   *  (XGVT-binary, GeoJSON-runtime) leave this unimplemented. */
  tick?(maxOps: number): void
}
