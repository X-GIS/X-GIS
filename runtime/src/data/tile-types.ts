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
  /** Pre-built SDF line-segment buffers ready for GPU upload. When
   *  present, doUploadTile skips the on-main-thread buildLineSegments
   *  call entirely. PMTiles MVT worker fills these so heavy line-
   *  geometry math runs off-thread; XGVT-binary leaves them undefined
   *  (its compact-tile worker also returns vertex/index buffers but
   *  not segments — buildLineSegments still runs on main for that
   *  path until the worker is extended). */
  prebuiltLineSegments?: Float32Array
  prebuiltOutlineSegments?: Float32Array
  tileWest: number             // tile origin (degrees) — canonical identity
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  polygons?: RingPolygon[]     // original rings (for sub-tiling)
  /** featId → 3D extrude height in metres. Populated by the MVT
   *  decode path for layers whose features carry `render_height` /
   *  `height` properties (primarily `buildings`). VTR routes upload
   *  through the extruded polygon pipeline when this is set; missing
   *  / empty means the layer's uniform default applies. */
  heights?: ReadonlyMap<number, number>
  /** featId → wall base z in metres (Mapbox `fill-extrusion-base`).
   *  Populated when the style declared `fill-extrusion-base-…` for
   *  the layer. Missing entries fall back to 0. */
  bases?: ReadonlyMap<number, number>
  /** featId → original feature properties bag (a copy of the MVT
   *  feature's `properties` object). Populated by sources whose
   *  decode step still has access to the per-feature property hash —
   *  PMTiles MVT decode + GeoJSON tiler. Used by the SDF text label
   *  pipeline to resolve `label-["{.field}"]` expressions per
   *  feature without round-tripping through a global PropertyTable
   *  (PMTiles doesn't build one — features land here directly). */
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
}

// Stride constants (exported for tests + VTR upload paths)
export const DSFUN_POLY_STRIDE = 5
export const DSFUN_LINE_STRIDE = 10

// ═══ Catalog-level constants ═══

/** Soft cap on UNIQUE tile keys before eviction kicks in. Per-tile
 *  inner-Map holds one TileData per MVT source-layer, so cache
 *  memory scales N×. 1024 keys × ~4 layers × ~5 typed arrays each
 *  Initial sizing was 1024 on the assumption "CPU heap is cheap" —
 *  but on a live PMTiles archive at city zoom (z=14-17), each
 *  cached tile holds ~2-4 MB of typed arrays (DSFUN polygon
 *  vertices, line vertices, indices, polygon ring snapshots for
 *  sub-tile gen). World-scale pan + zoom drives the cache to
 *  fill ≈ 3-4 GB before eviction triggers — far past Chrome's
 *  per-process limit on 8 GB machines, and the user's reported
 *  OOM symptom matches this curve.
 *
 *  256 keeps memory bounded to ~1 GB worst case, lines up with
 *  MAX_GPU_TILES so CPU and GPU caches churn in lockstep, and
 *  still leaves ~5× the visible-tile working set as pan-history
 *  headroom (typical viewports show 20-40 visible tiles). The
 *  flicker the older comment cited was about pan-back to
 *  recently-evicted tiles; with the WebGPU pipeline now able to
 *  re-upload from catalog cache in <1 frame and the parent-walk
 *  filling gaps from ancestors, that regression is no longer
 *  observed at this cap. */
export const MAX_CACHED_TILES = 256

/** Byte budget for the catalog's CPU-side dataCache. The enforced
 *  cap is byte-based (more accurate than count-based since per-tile
 *  size varies 50× between dense city z=15 tiles and sparse ocean
 *  z=3 tiles); MAX_CACHED_TILES stays as a secondary safety net for
 *  edge cases where the byte accounting drifts (e.g. a backend that
 *  swaps a TileData's typed arrays without going through setSlice).
 *
 *  200 MB chosen from stress-test measurement after prebuilt-SDF
 *  dispose (typed-array residual ≈ 260 MB at 256 tiles → 200 MB
 *  cap evicts the oldest ~25 % so working set is bounded). 5×
 *  visible viewport (≈ 30 tiles × ~3 MB each ≈ 100 MB) leaves
 *  ample pan-history headroom while keeping total heap < 1 GB
 *  under continuous world-scale navigation. */
export function maxCachedBytes(): number {
  // Mobile gets a 100 MB ceiling — real-device inspector (iPhone,
  // Seoul z=8.7) showed catalog cache at 296 MB on the 200 MB cap,
  // i.e. eviction couldn't keep up because too many keys were
  // protected by stableKeys + evictShield + prefetchKeys. 100 MB
  // forces tighter LRU churn on mobile while desktop stays at
  // 200 MB for headroom. Evaluated lazily for the same Playwright /
  // mobile-DPR-init reasons as the concurrency caps.
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return (w > 0 && w <= 900 ? 100 : 200) * 1024 * 1024
}
/** @deprecated Use {@link maxCachedBytes}() instead — module-init
 *  evaluation captured the wrong viewport. Kept as a back-compat
 *  desktop-default so external callers don't break, but internal
 *  catalog code now calls the function form. */
export const MAX_CACHED_BYTES = 200 * 1024 * 1024

/** Hard cap on simultaneous in-flight tile fetches across all
 *  backends. 32 keeps initial load at city-scale views under
 *  ~2 seconds on desktop (4-6 visible tiles + parent prefetch fit
 *  in one fetch wave). Mobile gets a tighter 8: sustained pinch +
 *  drag would otherwise cycle hundreds of fetches/sec through
 *  fetch → decode → upload → evict, which on iPhone reproducibly
 *  triggered Chrome's forced page refresh under thermal/memory
 *  pressure (post-fix-A user report). 8 still drains a region jump
 *  inside ~1 s while bounding the worker + GPU pipeline depth.
 *
 *  Lazy function form — a module-init `const` would race the host
 *  page's viewport apply (Playwright in tests + real mobile DPR
 *  setup), capturing the wrong value before innerWidth is laid
 *  out. Each call is one property read + one comparison.  */
export function maxConcurrentLoads(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? 8 : 32
}

/** Viewport-aware default skeleton depth for `TileCatalog.prewarmSkeleton`.
 *  Mobile gets a tighter depth=2 (1+4+16 = 21 tiles, ~1 MB) — same
 *  `innerWidth ≤ 900` threshold as `maxConcurrentLoads()` /
 *  `maxCachedBytes()` so the three caps stay coherent. Desktop gets
 *  depth=3 (85 tiles, ~4 MB), enough that fast-pan to any city on the
 *  globe finds a cached ancestor within ≤ 3 walk hops at typical view
 *  zoom (z≈14). Lazy function form for the same reason as the other
 *  caps — module-init evaluation captures the wrong viewport in
 *  Playwright / mobile DPR setup. */
export function defaultSkeletonDepth(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? 2 : 3
}

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
