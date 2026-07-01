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
  /** Polygon fill vertices — PR 2f quantized ECEF stride 24 bytes. */
  vertices: Float32Array
  /** PR 2f per-tile quantized-position dequant step (metres). */
  dequantScale: number
  /** PR 2f per-tile symmetric residual half-range (metres). */
  dequantHalf: number
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
  /** featId → 3D extrude height (metres). Set by the MVT decode
   *  path for layers carrying `render_height` / `height` (mostly
   *  buildings); routes the slice to the extruded fill pipeline at
   *  upload time. Undefined / empty → use the layer's uniform default. */
  heights?: ReadonlyMap<number, number>
  /** featId → wall base z (metres) — Mapbox `fill-extrusion-base`.
   *  Companion to `heights`; missing entries fall back to 0. Only
   *  populated for layers whose style declares
   *  `fill-extrusion-base-…`. */
  bases?: ReadonlyMap<number, number>
  /** featId → original feature properties bag (a copy of the MVT
   *  feature's `properties`). Populated by sources whose decode
   *  step still has access to the per-feature property hash —
   *  PMTiles MVT decode is the primary producer. Used by the SDF
   *  text label pipeline to resolve `label-["{.field}"]` per
   *  feature without round-tripping through a global PropertyTable
   *  (PMTiles doesn't build one — features land here directly). */
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
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

/** Tile-scheme discriminator declared by a backend at attach time. Drives
 *  scheme-aware decode dispatch once non-Mercator backends exist.
 *
 *  The union is intentionally single-variant today — every shipping backend
 *  (PMTiles, GeoJSON-tiled, raster XYZ) tiles on Web Mercator XYZ. Variants
 *  reserved for later additions, kept out of the union until their backends
 *  land (YAGNI):
 *    - `'epsg-4326-quadtree'` — 2-root geographic quadtree (Cesium / NASA
 *      Worldwind style); reaches ±90° latitude without polar synthesis.
 *    - `'s2-cube-sphere'`     — 6-root cube-sphere (3D Tiles 1.1
 *      `3DTILES_bounding_volume_S2`); uniform distortion globally. */
export type TileScheme = 'web-mercator-xyz'

/** Tile-buffer layout version. Increment when the per-vertex stride / field
 *  semantics produced by `compiler/src/tiler/vector-tiler.ts` change in a way
 *  that makes previously cached tiles incompatible with the running runtime.
 *
 *  Examples that bump this:
 *   - Phase 2c will switch polygon vertex bytes from
 *     `[mx_h, my_h, mx_l, my_l, feat_id]` Mercator-metre DSFUN pairs to ECEF
 *     Cartesian-metre DSFUN triples → bump the version, existing PMTiles
 *     caches re-decode.
 *
 *  Examples that DO NOT bump:
 *   - Adding a new metadata field that the runtime ignores when absent.
 *   - Changing a non-vertex-layout invariant.
 *
 *  Catalog comparison contract:
 *   - At `attachBackend` time the catalog reads `meta.layoutVersion` (when
 *     present). On mismatch it evicts cached tiles for that source so the
 *     next visible frame re-decodes through the new layout.
 *   - Backends produced before this field shipped read as `undefined` —
 *     catalog treats `undefined` as `TILE_LAYOUT_VERSION_BASE` (the Phase
 *     1 / pre-ECEF layout) for back-compat. */
/** Bumped 2 → 3 in PR 2f: polygon fill + extruded vertex bytes switched from
 *  ECEF-DSFUN stride-9/14 f32 to the QUANTIZED ECEF layout — position is
 *  32-bit fixed point per axis (uint16 hi/lo), flat stride 24 B / extruded
 *  stride 44 B. Cached pre-PR-2f tiles would otherwise feed f32-position
 *  bytes into the uint16x4/x2 VS attribute layout (garbage geometry) and
 *  carry no per-tile dequant uniforms. Catalog evicts on attach when this
 *  doesn't match a backend's advertised `meta.layoutVersion`.
 *  (Prior: 1 → 2 in PR 2c.4 — Mercator-DSFUN stride-5 → ECEF-DSFUN stride-9.)
 *
 *  Bumped 3 → 4: the polygon fill f32 tail slots (bytes 16..23) changed
 *  SEMANTICS from absolute lon/lat DEGREES to TILE-LOCAL Mercator metres
 *  (mx − tileOriginMerc). Same stride/layout, but a cached v3 tile feeds
 *  degree values where the new VS expects local-Mercator metres → fill drawn
 *  at the wrong place. Stride is unchanged so only the value meaning differs;
 *  the eviction-on-mismatch still applies. Fixes the f32-degree fill/outline
 *  displacement at deep over-zoom (z>20).
 *
 *  Bumped 4 → 5: the POINT vertex buffer grew from stride-9 to stride-13 —
 *  appended an absolute Mercator DSFUN tail (slots 9-12 = mx_h, mx_l, my_h,
 *  my_l) so the flat-Mercator point/icon/label VS reads a precise position
 *  instead of reprojecting the lossy f32 abs_lon/abs_lat (~5.7 px @ z20). A
 *  cached v4 tile feeds stride-9 point bytes into the stride-13 decode →
 *  mis-paired points; eviction-on-mismatch handles it.
 *
 *  Bumped 5 → 6 (#398): the polygon FILL vertex grew from stride 24 B (6 f32)
 *  to stride 28 B (7 f32) — an ADDITIVE `true_lat` tail slot (@float6, bytes
 *  24..27) carrying the UNCLAMPED latitude the disc (flat_rel) arm projects
 *  from, so the ±90 polar caps reach the pole on ortho/azimuthal/stereographic
 *  instead of the Merc-clamped 85.05 ring (the ~550 km annular hole). A cached
 *  v5 tile feeds stride-24 fill bytes into the stride-28 VS attribute layout →
 *  mis-strided geometry; eviction-on-mismatch handles it. (Extruded format
 *  unchanged — no poles in buildings.) */
export const TILE_LAYOUT_VERSION = 6 as const
export type TileLayoutVersion = typeof TILE_LAYOUT_VERSION

/** Pre-version-field baseline. Tiles produced by backends that omit
 *  `meta.layoutVersion` are assumed to follow this layout — never bumped,
 *  otherwise the cache-attribution backfill contract (treat undefined as
 *  base) breaks for backends shipped before the field existed. */
export const TILE_LAYOUT_VERSION_BASE = 1 as const

/** Metadata contributed by a backend at attach time. Catalog merges
 *  these across attached backends:
 *   - bounds → bounding union
 *   - {min,max}Zoom → min-of-mins + max-of-maxes
 *   - propertyTable → first non-empty wins (Phase 1; merging schemas
 *     across backends is a Phase 2 concern, see plan §1.4)
 *   - entries → registered with catalog's XGVTIndex; preregistered
 *     entries route deterministically via entryToBackend.
 *   - scheme → declared by backend; catalog exposes via
 *     `TileCatalog.getScheme`.
 *   - layoutVersion → declared by backend; catalog evicts cached tiles
 *     for that source if the running runtime's `TILE_LAYOUT_VERSION`
 *     does not match. Optional for back-compat; `undefined` is treated
 *     as `TILE_LAYOUT_VERSION_BASE`. */
export interface TileSourceMeta {
  bounds: [number, number, number, number]
  minZoom: number
  maxZoom: number
  propertyTable?: PropertyTable
  entries?: { key: number; entry: TileIndexEntry }[]
  readonly scheme: TileScheme
  readonly layoutVersion?: TileLayoutVersion
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

  /** OPTIONAL: cancel in-flight fetches whose keys aren't in
   *  `activeKeys`. Catalog drives this from VTR per-frame so tiles
   *  the camera moved past stop hogging bandwidth + worker capacity.
   *  Implementations should:
   *    - Abort the underlying fetch (AbortController) so the network
   *      transfer terminates rather than completing into a discarded
   *      buffer.
   *    - Drop already-fetched-but-not-yet-compiled bytes for stale
   *      keys (e.g., PMTiles' pendingMvt queue).
   *    - Release the catalog loading slot for cancelled keys so the
   *      catalog re-issues if the tile becomes visible again.
   *    - NOT mark the key as failed — abort isn't a fetch error. */
  cancelStale?(activeKeys: Set<number>): void

  /** OPTIONAL: install a comparator on the backend's fetch priority
   *  queue. Higher-priority items must sort LAST (return positive when
   *  `a` should run before `b`). Reset to FIFO with `null`. Implemented
   *  by backends that route fetches through a PriorityQueue (PMTiles).
   *  Other backends (in-memory GeoJSON, sync compile paths) ignore. */
  setFetchPriorityCallback?(cmp: ((a: number, b: number) => number) | null): void

  /** OPTIONAL: backend-side TTL'd negative cache lookup. Returns true
   *  when a recent fetch attempt for `key` exhausted retries and the
   *  backend is short-circuiting subsequent requests. Used by
   *  `TileCatalog.getTileState` to surface the `'failed'` state.
   *  Backends without retry logic (in-memory GeoJSON, XGVT-binary
   *  range fetches) can omit. Default: never failed. */
  isFailed?(key: number): boolean
}
