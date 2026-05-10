// ═══ TileCatalog — 타일 라우터 + 캐시 + 서브타일 클리핑 ═══
//
// Step 6 of the layer-type refactor (plans/delegated-hopping-cray.md):
// XGVTSource was renamed to TileCatalog because what this class
// actually does is route (z, x, y) requests to attached TileSource
// backends (XGVT-binary, PMTiles, GeoJSON-runtime) and manage the
// cross-cutting concerns (cache, eviction, budget, sub-tile
// generation, onTileLoaded fan-out). The original "XGVTSource" name
// suggested "the .xgvt format source" but the class plays
// catalog/router — see plan §1.2.
//
// Public API surface (the contract VTR depends on) is unchanged.
// xgvt-source.ts remains as a back-compat re-export so external
// callers (loadPMTilesSource, tests) keep compiling without changes.
//
// GPU 독립: CPU 배열만 관리, GPU 업로드는 VectorTileRenderer가 담당.

import {
  TILE_FLAG_FULL_COVER,
  tileKey, tileKeyUnpack,
  lonLatToMercF64,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { visibleTiles } from './tile-select'
import { XGVTBinaryBackend } from './sources/xgvt-binary-backend'
import { VirtualCatalogAdapter } from './sources/virtual-catalog-adapter'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
import { SubTileGenerator } from './sub-tile-generator'
import type {
  TileSource, TileSourceSink, BackendTileResult,
} from './tile-source'
// Step 0 of the layer-type refactor: shared types live in tile-types.ts so
// per-format backend modules can import them without pulling in catalog
// runtime state. Re-exported below for back-compat with external callers
// (loadPMTilesSource etc. import these from xgvt-source.ts today).
import {
  type TileData,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  MAX_CACHED_TILES, maxCachedBytes, maxConcurrentLoads, defaultSkeletonDepth,
  type VirtualCatalog, type VirtualTileFetcher,
} from './tile-types'

export {
  type TileData,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  type VirtualCatalog, type VirtualTileFetcher,
}

// ═══ Catalog ═══

export class TileCatalog {
  private index: XGVTIndex | null = null
  /** Cache of compiled tile data per (tile key, source-layer name).
   *  The inner map is keyed by MVT layer name; '' (empty string) is
   *  the "default" slice used by single-layer sources (XGVT-binary,
   *  GeoJSON-runtime) and as the legacy back-compat lookup for code
   *  that doesn't pass a sourceLayer. PMTiles emits one slice per
   *  MVT layer present in the tile, each landing under that layer's
   *  name — so a single source can serve multiple xgis layers each
   *  with its own `sourceLayer` filter. */
  private dataCache = new Map<number, Map<string, TileData>>()
  private loadingTiles = new Set<number>()

  /** Ordered list of attached backends. Multi-backend dispatch is
   *  first-attached-wins for ambiguous (z, x, y) — users wanting
   *  different precedence detach + reattach in desired order.
   *  See plans/delegated-hopping-cray.md §1.2 for rationale. */
  private backends: TileSource[] = []
  /** Per-key dispatch shortcut: which backend produced a given
   *  preregistered XGVTIndex entry. Populated by attachBackend
   *  whenever a backend's meta.entries is non-empty (XGVT-binary).
   *  Lazy-discovery backends (PMTiles, GeoJSON-runtime) don't
   *  preregister — their tiles are routed via the iterate-and-ask
   *  fallback in requestTiles. */
  private entryToBackend = new Map<number, TileSource>()

  /** Lazy reference to the binary backend instance that this catalog
   *  manages, if any. Used by loadFromBuffer/URL to call the
   *  XGVT-binary-specific loader methods (parseXGVTIndex, preload).
   *  Other catalog code paths use the generic backends list. */
  private binaryBackend: XGVTBinaryBackend | null = null
  /** Lazy reference to the in-memory GeoJSON backend, used by
   *  setRawParts to feed raw parts in. */
  private geojsonBackend: GeoJSONRuntimeBackend | null = null
  /** Per-frame CPU-side parent → child clipper, invoked from
   *  generateSubTile. Stateless — same instance reused across calls. */
  private readonly subTileGen = new SubTileGenerator()

  /** Called when a tile finishes loading (for GPU upload). The
   *  third argument is the source-layer slot — '' for default
   *  slice (single-layer sources, sub-tiles), MVT layer name for
   *  per-layer slices (PMTiles). VTR uploads a per-(key, layer)
   *  GPU entry so different xgis layers can draw distinct slices. */
  onTileLoaded: ((key: number, data: TileData, sourceLayer: string) => void) | null = null

  /** Cumulative byte cost of every TileData in `dataCache`, kept
   *  in sync by setSlice / dataCache.delete paths. Used by
   *  evictTiles to enforce `MAX_CACHED_BYTES` independent of
   *  tile count — a single dense city-zoom tile can hold 4-8 MB
   *  while a sparse ocean tile is < 100 KB, so count-based caps
   *  either over-shoot heap on dense scenes or churn on sparse
   *  ones. */
  private _cachedBytes = 0

  /** Permanently-pinned keys: the global low-zoom skeleton that
   *  guarantees `classifyFallback`'s ancestor walk always succeeds
   *  during fast-pan. Mirrors Cesium `QuadtreePrimitive`'s
   *  `_doNotDestroySubtree` (root-tile permanent retention) and
   *  NASA-AMMOS 3D Tiles Renderer's protected `lruCache` anchors —
   *  fast-pan to a brand-new region on the globe used to drop into
   *  the `pending` decision (no fallback geometry pushed) and the
   *  canvas cleared white through the gap. With a pinned z=0..N
   *  skeleton the walk hits a cached ancestor in ≤ N hops every
   *  time. Populated lazily by {@link markSkeleton} (called by the
   *  PMTiles / TileJSON attach path); honoured by `evictTiles` and
   *  `cancelStale` so it survives both LRU pressure AND backend-fetch
   *  cancellation between prewarm pump retries. */
  private _skeletonKeys = new Set<number>()

  /** Best-effort byte size of a TileData. Sums every typed-array
   *  field we hold; skips `polygons` because RingPolygon is plain
   *  JS arrays (V8-internal, no byteLength) and stress-test
   *  measurement put it at ~20 % of typed-array total — not zero,
   *  but the budget cap has 25 % slack so this approximation is
   *  fine for the eviction trigger. */
  private static sizeOfTileData(td: TileData): number {
    let n = 0
    n += td.vertices.byteLength + td.indices.byteLength
    n += td.lineVertices.byteLength + td.lineIndices.byteLength
    n += td.outlineIndices.byteLength
    if (td.outlineVertices) n += td.outlineVertices.byteLength
    if (td.outlineLineIndices) n += td.outlineLineIndices.byteLength
    if (td.pointVertices) n += td.pointVertices.byteLength
    // prebuiltLineSegments / prebuiltOutlineSegments INTENTIONALLY
    // omitted: VTR.doUploadTile nulls them out after GPU upload (a
    // 180 MB / 256-tile heap-saving optimisation). Including them
    // here would drift `_cachedBytes` upward — setSlice adds them
    // when the tile arrives, but the matching subtract in
    // deleteCacheEntry sees them already null. Real-device
    // inspector showed 2 catalog tiles reporting 263 MB cached
    // because of this; the byte cap then false-positive evicted
    // visible tiles, leaving currentZ stripes covered by parent-
    // walk fallback (regression: _mobile-detail-uniformity).
    return n
  }

  /** Internal: set a slice in the per-key nested map, creating the
   *  outer slot lazily. Used by cacheTileData + sub-tile gen.
   *  Maintains `_cachedBytes` so evictTiles can enforce a byte
   *  budget — same slot replacement subtracts the old data's size
   *  before adding the new one. */
  private setSlice(key: number, layer: string, data: TileData): void {
    let slot = this.dataCache.get(key)
    if (!slot) { slot = new Map(); this.dataCache.set(key, slot) }
    const prev = slot.get(layer)
    if (prev) this._cachedBytes -= TileCatalog.sizeOfTileData(prev)
    slot.set(layer, data)
    this._cachedBytes += TileCatalog.sizeOfTileData(data)
  }

  /** Internal: drop a key (all slices) from dataCache. Use this
   *  instead of dataCache.delete directly so `_cachedBytes` stays
   *  in sync. */
  private deleteCacheEntry(key: number): void {
    const slot = this.dataCache.get(key)
    if (!slot) return
    for (const td of slot.values()) {
      this._cachedBytes -= TileCatalog.sizeOfTileData(td)
    }
    this.dataCache.delete(key)
  }

  // ── Data access ──

  hasData(): boolean {
    // Consider the catalog ready as soon as any backend is attached —
    // not just when preregistered entries exist. Lazy-discovery
    // backends (PMTiles, GeoJSON-runtime) start with an empty
    // entries list and only populate it after tiles are fetched on
    // demand. The previous "entries.length > 0" check created a
    // chicken-and-egg deadlock: VTR's render path early-outs on
    // !hasData → never calls requestTiles → no fetch ever fires →
    // entries stay at 0 → hasData stays false. Fix: any attached
    // backend (or any preregistered entry) counts as "has data".
    if (this.index && this.index.entries.length > 0) return true
    return this.backends.length > 0
  }

  getBounds(): [number, number, number, number] | null {
    return this.index?.header.bounds ?? null
  }

  getPropertyTable(): PropertyTable | undefined {
    return this.index?.propertyTable
  }

  getIndex(): XGVTIndex | null {
    return this.index
  }

  get maxLevel(): number {
    return this.index?.header.maxLevel ?? 0
  }

  /** Look up the per-MVT-layer zoom range advertised by the source's
   *  metadata (PMTiles `vector_layers`). Returns null when no backend
   *  knows about this layer, or no metadata was published. Renderer
   *  uses it to skip render() entirely for layers whose data range
   *  doesn't overlap the current camera zoom — eliminates spurious
   *  FLICKER warnings + sub-tile gen attempts for empty slices
   *  (protomaps v4 `roads` z≥6, `buildings` z≥14). */
  getLayerZoomRange(sourceLayer: string): { minzoom: number; maxzoom: number } | null {
    for (const b of this.backends) {
      const fn = (b as TileSource & { getLayerZoomRange?: (s: string) => { minzoom: number; maxzoom: number } | null }).getLayerZoomRange
      if (typeof fn === 'function') {
        const r = fn.call(b, sourceLayer)
        if (r) return r
      }
    }
    return null
  }

  /** Lazily-built sink shared by all attached backends. */
  private _sink: TileSourceSink | null = null
  private getSink(): TileSourceSink {
    if (!this._sink) {
      this._sink = {
        hasTileData: (key) => this.dataCache.has(key),
        trackLoading: (key) => { this.loadingTiles.add(key) },
        releaseLoading: (key) => { this.loadingTiles.delete(key) },
        getLoadingCount: () => this.loadingTiles.size,
        acceptResult: (key, result, sourceLayer) => this.acceptResult(key, result, sourceLayer),
      }
    }
    return this._sink
  }

  /** Attach a TileSource backend to this catalog. After this call:
   *  - hasEntryInIndex(key) returns true for any key the backend has.
   *  - requestTiles(keys) routes through the backend.
   *  - getBounds() reflects the bounding union of all attached
   *    backends; maxLevel is the max-of-maxes; getPropertyTable()
   *    returns the first attached backend's table (first-attached-wins).
   *  - Backends with meta.entries (XGVT-binary) preregister into
   *    entryToBackend so dispatch is O(1) for those keys.
   *  Soft cap: catalog accepts any number of backends. Dispatch
   *  precedence is attach order — see plans/delegated-hopping-cray.md
   *  §1.2 for rationale. */
  attachBackend(backend: TileSource): void {
    backend.attach(this.getSink())
    this.backends.push(backend)
    this.mergeBackendMeta(backend)
  }

  /** Detach a previously-attached backend. Removes preregistered
   *  entries from entryToBackend (catalog cache is NOT evicted —
   *  cached tiles outlive their backend). */
  detachBackend(backend: TileSource): void {
    const i = this.backends.indexOf(backend)
    if (i < 0) return
    this.backends.splice(i, 1)
    for (const [key, owner] of this.entryToBackend) {
      if (owner === backend) this.entryToBackend.delete(key)
    }
    backend.detach?.()
  }

  /** Re-merge a backend's meta into the catalog's XGVTIndex shell
   *  (bounds union, maxLevel max, propertyTable first-wins,
   *  preregistered entries). Called by attachBackend; also invoked
   *  again by setRawParts when the GeoJSON backend's bounds/maxZoom
   *  change after parts are loaded. */
  private mergeBackendMeta(backend: TileSource): void {
    const meta = backend.meta
    if (!this.index) {
      this.index = {
        header: {
          levelCount: 0,
          maxLevel: meta.maxZoom,
          bounds: meta.bounds,
          indexOffset: 0, indexLength: 0,
          propTableOffset: 0, propTableLength: 0,
        },
        entries: [],
        entryByHash: new Map(),
        propertyTable: meta.propertyTable ?? { fieldNames: [], fieldTypes: [], values: [] },
      }
    } else {
      const idx = this.index
      idx.header.maxLevel = Math.max(idx.header.maxLevel, meta.maxZoom)
      idx.header.bounds = unionBounds(idx.header.bounds, meta.bounds)
      // First-attached-wins: only adopt this backend's table if catalog has none.
      if (meta.propertyTable && (!idx.propertyTable || idx.propertyTable.fieldNames.length === 0)) {
        idx.propertyTable = meta.propertyTable
      }
    }
    // Preregister entries (XGVT-binary path).
    if (meta.entries) {
      for (const { key, entry } of meta.entries) {
        if (!this.index!.entryByHash.has(key)) {
          this.index!.entries.push(entry)
          this.index!.entryByHash.set(key, entry)
        }
        this.entryToBackend.set(key, backend)
      }
    }
  }

  /** Catalog-side result handler — unifies cacheTileData /
   *  createFullCoverTileData / synthetic-entry creation that
   *  backends used to do via bespoke sinks. Called by the shared
   *  sink whenever a backend pushes a result. Pass null for
   *  empty placeholder (backend determined no data for this key). */
  private acceptResult(key: number, result: BackendTileResult | null, sourceLayer = ''): void {
    if (!result) {
      const empty = new Float32Array(0)
      const emptyI = new Uint32Array(0)
      this.cacheTileData(key, undefined, empty, emptyI, empty, emptyI, undefined, undefined, undefined, undefined, undefined, undefined, sourceLayer)
      return
    }
    // Synthesise an XGVTIndex entry (idempotent — skip if already
    // present). Required so subsequent hasEntryInIndex / parent-walk
    // calls find the cached tile.
    const tileFullCover = result.fullCover ?? false
    const tileFullCoverFid = result.fullCoverFeatureId ?? 0
    if (this.index && !this.index.entryByHash.has(key)) {
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: result.vertices.length / DSFUN_POLY_STRIDE,
        indexCount: result.indices.length,
        lineVertexCount: result.lineVertices.length / DSFUN_LINE_STRIDE,
        lineIndexCount: result.lineIndices.length,
        flags: tileFullCover ? (TILE_FLAG_FULL_COVER | (tileFullCoverFid << 1)) : 0,
        fullCoverFeatureId: tileFullCoverFid,
      }
      this.index.entries.push(entry)
      this.index.entryByHash.set(key, entry)
    }
    if (tileFullCover && result.vertices.length === 0) {
      const entry = this.index?.entryByHash.get(key)
      if (entry) {
        this.createFullCoverTileData(key, entry, result.lineVertices, result.lineIndices, sourceLayer)
        return
      }
    }
    this.cacheTileData(
      key, result.polygons,
      result.vertices, result.indices,
      result.lineVertices, result.lineIndices,
      result.pointVertices,
      result.outlineIndices,
      result.outlineVertices,
      result.outlineLineIndices,
      result.prebuiltLineSegments,
      result.prebuiltOutlineSegments,
      sourceLayer,
      result.heights,
      result.bases,
      result.featureProps,
    )
  }

  /** Store raw geometry parts for on-demand compilation (GeoJSON sources).
   *  Constructs + attaches a GeoJSONRuntimeBackend on first call;
   *  subsequent calls update its parts (and re-merge meta in case
   *  bounds / maxZoom changed). */
  setRawParts(parts: GeometryPart[], maxZoom: number): void {
    let firstAttach = false
    if (!this.geojsonBackend) {
      this.geojsonBackend = new GeoJSONRuntimeBackend()
      firstAttach = true
    }
    this.geojsonBackend.setParts(parts, maxZoom)
    if (firstAttach) {
      this.attachBackend(this.geojsonBackend)
    } else {
      // Bounds / maxZoom may have changed — re-merge.
      this.mergeBackendMeta(this.geojsonBackend)
    }
    // No auto-prewarm: GeoJSON-runtime's prefetch path goes through
    // compileSync, and prewarmSkeleton would burn the per-frame
    // compile budget synchronously inside setRawParts — starving
    // compileTileOnDemand for the same frame (xgvt-source-subtile-
    // fullcover.test.ts repro). Lazy compile via the renderer's
    // per-tile classifier is fine for in-memory sources; the cold-
    // start UX issue only matters for async fetches.
  }

  /** Get parts that potentially overlap a tile (via grid index).
   *  Public for tests + potential future direct callers; backend
   *  owns the actual lookup. */
  getRelevantParts(z: number, x: number, y: number): GeometryPart[] | null {
    return this.geojsonBackend?.getRelevantParts(z, x, y) ?? null
  }

  // ── Per-frame budget (hybrid count-floor + time-ceiling) ──
  //
  // Industry-standard approach adapted for our two cost regimes:
  //
  //   (1) Heavy raw-parts compiles (z=3, countries) — 5–100 ms each.
  //       A pure time budget would allow only 1 per frame (the first
  //       call always blows the deadline), regressing convergence
  //       from 4/frame to 1/frame. A pure count cap was the old
  //       design.
  //   (2) Light sub-tile clips (z=15 at high pitch) — microseconds
  //       each. A pure count cap of 8 throttles 270-tile bursts to
  //       60 frames when the same work fits easily in 6 ms total.
  //
  // Hybrid policy (both regimes get the best of each):
  //   • GUARANTEED FLOOR: always process up to `countFloor` calls
  //     per frame regardless of time — preserves the old count-based
  //     behaviour under heavy compiles and never starves progress.
  //   • TIME-BUDGETED HEADROOM: beyond the floor, keep going until
  //     the per-frame wall-clock deadline (6 ms) is hit. Light bursts
  //     (sub-tile) can land 50+ per frame; heavy bursts stop at the
  //     floor.
  //   • HARD SAFETY CAP: `_MAX_PER_FRAME` blocks runaway timer bugs.
  //
  // Matches Mapbox GL's `MAX_PARALLEL_IMAGERY_REQUESTS` + frame-time
  // scheduling in spirit; MapLibre and Deck.gl use analogous tile-
  // budget patterns.
  private _budgetDeadlineMs = 0
  private _compileCountThisFrame = 0
  private _subTileCountThisFrame = 0
  // Per-CALL budgets restored to original tuning. The earlier "tiles
  // disappear at over-zoom" symptom had two compounded root causes
  // BOTH inside generateSubTile (not in the budgets):
  //   1. _subTileCountThisFrame was incremented TWICE per call
  //      (once at line ~814 + once at line ~1061). Per-call cap
  //      effectively halved → late layers starved.
  //   2. Budget knobs were over-tightened in chase mitigations.
  // Fix 1 is in generateSubTile; restoring 1's worth of headroom
  // here returns single-source convergence speed to baseline
  // (matches the throughput-test targets).
  private static readonly _BUDGET_MS = 6
  private static readonly _COMPILE_FLOOR = 4
  private static readonly _SUBTILE_FLOOR = 8
  private static readonly _MAX_PER_FRAME = 128

  /** Reset per-frame budget. The frameId arg is reserved for future
   *  frame-shared budget work (currently unused — each layer gets
   *  its own sliced budget per the constants above). */
  resetCompileBudget(_frameId: number = -1): void {
    this._budgetDeadlineMs = this._now() + TileCatalog._BUDGET_MS
    this._compileCountThisFrame = 0
    this._subTileCountThisFrame = 0
    // Drain backend deferred-compile queues (PMTiles raw bytes →
    // compileSingleTile). Backends that compile inline don't
    // implement tick. _PMTILES_TICK_BUDGET picks how many tiles are
    // compiled per frame — 4 keeps the worst case under ~16 ms on a
    // dense world basemap tile, fitting one 60 fps frame.
    for (const b of this.backends) {
      b.tick?.(TileCatalog._TICK_BUDGET)
    }
  }
  // 2 paces compileSingleTile (5-50 ms each on dense MVT tiles) at
  // most ~100 ms/frame so VTR's MAX_UPLOADS_PER_FRAME (also 2) can
  // drain them without the queue growing. The pair (compile budget +
  // upload budget) bounds total per-frame work at ~300 ms worst case,
  // matching the visible-tile pipeline as a single producer→consumer
  // chain. Real fix for sub-frame work is a compile worker pool.
  private static readonly _TICK_BUDGET = 2

  /** Wall-clock reader. Uses performance.now when available (browser +
   *  modern Node) and falls back to Date.now otherwise. */
  private _now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  /** Hybrid budget gate. `countFloor` calls are always permitted per
   *  frame (no-starvation guarantee); beyond that, calls proceed only
   *  while the wall-clock deadline has not been reached. Upper safety
   *  cap at `_MAX_PER_FRAME` blocks degenerate timer states. */
  private _budgetExceeded(callsThisFrame: number, countFloor: number): boolean {
    if (callsThisFrame >= TileCatalog._MAX_PER_FRAME) return true
    if (callsThisFrame < countFloor) return false // always allow under floor
    return this._now() > this._budgetDeadlineMs
  }

  /** Synchronous on-demand compile path. Walks attached backends and
   *  uses the first one that supports compileSync (GeoJSON-runtime
   *  today). Catalog gates the call with the per-frame compile budget;
   *  backend handles parts lookup, compileSingleTile, and result push
   *  via the shared sink. */
  compileTileOnDemand(key: number): boolean {
    if (this.dataCache.has(key)) return false
    for (const backend of this.backends) {
      if (!backend.compileSync || !backend.has(key)) continue
      return this.tryCompileSync(key, backend)
    }
    return false
  }

  // ── Tile data cache ──

  /** Get the compiled TileData for (key, sourceLayer). When
   *  sourceLayer is undefined or '', returns the default slice
   *  (single-layer sources) — falling through to the FIRST per-MVT-
   *  layer slice if the catalog only has per-layer slices for this
   *  key (e.g. PMTiles). When sourceLayer is set, returns that
   *  specific MVT layer's slice or null when absent. */
  getTileData(key: number, sourceLayer?: string): TileData | null {
    const slot = this.dataCache.get(key)
    if (!slot) return null
    if (sourceLayer) return slot.get(sourceLayer) ?? null
    // Back-compat: '' = default slice, OR first slice if only per-layer present.
    const def = slot.get('')
    if (def) return def
    const it = slot.values().next()
    return it.done ? null : it.value
  }

  hasTileData(key: number, sourceLayer?: string): boolean {
    const slot = this.dataCache.get(key)
    if (!slot) return false
    if (sourceLayer) return slot.has(sourceLayer)
    return slot.size > 0
  }

  isLoading(key: number): boolean {
    return this.loadingTiles.has(key)
  }

  /** True when any tile is still being fetched. Read each frame by the
   *  render-loop idle-skip so late arrivals trigger a redraw. */
  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  getCacheSize(): number {
    return this.dataCache.size
  }

  /** Diagnostic accessors — let inspectPipeline() + CPU debug tests
   *  read the budget/queue state without reaching into private fields.
   *  Not part of the public API.  */
  getSubTileBudgetUsed(): number { return this._subTileCountThisFrame }
  getCompileBudgetUsed(): number { return this._compileCountThisFrame }
  getPendingLoadCount(): number { return this.loadingTiles.size }

  hasEntryInIndex(key: number): boolean {
    if (this.index?.entryByHash.has(key)) return true
    // Iterate-and-ask each attached backend (lazy-discovery path —
    // PMTiles, GeoJSON-runtime, future TopoJSON / FlatGeobuf).
    for (const backend of this.backends) {
      if (backend.has(key)) return true
    }
    return false
  }

  /** Legacy hook for on-demand tile producers. Now a thin shim around
   *  attachBackend(new PMTilesBackend(catalog)). Preserved so existing
   *  callers (loadPMTilesSource, virtual-catalog-fetch tests) keep
   *  compiling. New code should use attachBackend directly with a
   *  PMTilesBackend instance. */
  setVirtualCatalog(catalog: VirtualCatalog): void {
    const backend = new VirtualCatalogAdapter(catalog)
    this.attachBackend(backend)
  }

  // ── Loading ──

  /** Lazy-build the binary backend instance + attach it. The binary
   *  backend's loadFromBuffer/URL methods are exposed here as
   *  delegates because they have parsing-specific signatures that
   *  don't fit the generic TileSource interface (they're load-time,
   *  not request-time). */
  private getBinaryBackend(): XGVTBinaryBackend {
    if (!this.binaryBackend) {
      this.binaryBackend = new XGVTBinaryBackend()
      this.attachBackend(this.binaryBackend)
    }
    return this.binaryBackend
  }

  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    const backend = this.getBinaryBackend()
    await backend.loadFromBuffer(buf)
    // Index entries arrive via meta after parse — re-merge them.
    this.mergeBackendMeta(backend)
    this.prewarmSkeleton({ minzoom: backend.meta.minZoom, maxzoom: backend.meta.maxZoom })
  }

  async loadFromURL(url: string): Promise<void> {
    const backend = this.getBinaryBackend()
    await backend.loadFromURL(url)
    this.mergeBackendMeta(backend)
    this.prewarmSkeleton({ minzoom: backend.meta.minZoom, maxzoom: backend.meta.maxZoom })
  }

  /**
   * Load from an in-memory CompiledTileSet (from compileGeoJSONToTiles).
   * Populates cache directly — no file I/O, no decompression.
   */
  loadFromTileSet(tileSet: CompiledTileSet): void {
    // Build a synthetic XGVTIndex
    const entries: TileIndexEntry[] = []
    const entryByHash = new Map<number, TileIndexEntry>()

    let tileCount = 0
    for (const level of tileSet.levels) {
      for (const [, tile] of level.tiles) {
        const key = tileKey(tile.z, tile.x, tile.y)
        const isFullCover = !!tile.fullCover
        const fid = tile.fullCoverFeatureId ?? 0
        const entry: TileIndexEntry = {
          tileHash: key,
          dataOffset: 0,
          compactSize: 0,
          gpuReadySize: 0,
          vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE,
          indexCount: tile.indices.length,
          lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE,
          lineIndexCount: tile.lineIndices.length,
          flags: isFullCover ? (TILE_FLAG_FULL_COVER | (fid << 1)) : 0,
          fullCoverFeatureId: fid,
        }
        entries.push(entry)
        entryByHash.set(key, entry)

        // Full-cover tiles: generate quad (same as createFullCoverTileData)
        if (isFullCover && tile.vertices.length === 0) {
          this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        } else {
          const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({
            rings: p.rings, featId: p.featId,
          }))
          this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, tile.pointVertices, tile.outlineIndices)
        }
        tileCount++
      }
    }

    const [minLon, minLat, maxLon, maxLat] = tileSet.bounds
    this.index = {
      header: {
        levelCount: tileSet.levels.length,
        maxLevel: tileSet.levels.length > 0 ? tileSet.levels[tileSet.levels.length - 1].zoom : 0,
        bounds: [minLon, minLat, maxLon, maxLat],
        indexOffset: 0,
        indexLength: 0,
        propTableOffset: 0,
        propTableLength: 0,
      },
      entries,
      entryByHash,
      propertyTable: tileSet.propertyTable,
    }

    console.log(`[X-GIS] In-memory tiles loaded: ${tileCount} tiles from ${tileSet.featureCount} features`)
    // No auto-prewarm: every tile in the compiled set is already in
    // dataCache by the loop above, so a prefetchTiles pump would only
    // produce duplicate cache hits — and on backends that route
    // prefetch through compileSync (GeoJSON-runtime via setRawParts
    // followed by loadFromTileSet) it would burn the per-frame compile
    // budget synchronously, starving compileTileOnDemand on the same
    // frame. Skeleton-style eviction protection isn't needed either:
    // every level is already in the index + cache, so the catalog's
    // ancestor walk finds them without `markSkeleton` pinning.
  }

  /**
   * Progressively add a single zoom level (from onLevel callback).
   * Creates/extends the index and caches tiles immediately.
   */
  addTileLevel(level: TileLevel, bounds: [number, number, number, number], propertyTable: PropertyTable): void {
    if (!this.index) {
      this.index = {
        header: {
          levelCount: 1,
          maxLevel: level.zoom,
          bounds, indexOffset: 0, indexLength: 0,
          propTableOffset: 0, propTableLength: 0,
        },
        entries: [], entryByHash: new Map(), propertyTable,
      }
    }
    const idx = this.index!

    idx.header.maxLevel = Math.max(idx.header.maxLevel, level.zoom)

    for (const [, tile] of level.tiles) {
      const key = tileKey(tile.z, tile.x, tile.y)
      if (idx.entryByHash.has(key)) continue

      const isFullCover = !!tile.fullCover
      const fid = tile.fullCoverFeatureId ?? 0
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE, indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE, lineIndexCount: tile.lineIndices.length,
        flags: isFullCover ? (TILE_FLAG_FULL_COVER | (fid << 1)) : 0,
        fullCoverFeatureId: fid,
      }
      idx.entries.push(entry)
      idx.entryByHash.set(key, entry)

      if (isFullCover && tile.vertices.length === 0) {
        this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
      } else {
        const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
        this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, tile.pointVertices, tile.outlineIndices)
      }
    }
  }

  // ── Tile request (multi-backend dispatch) ──

  /** Recent prefetch intent — keys that VTR (Tier 2 zoom-direction
   *  prefetch) and catalog-internal prefetchAdjacent fired off in the
   *  last few frames. These must be unioned into `cancelStale`'s
   *  active set so a prefetch fetch isn't aborted by the very next
   *  frame's cancellation pass. Without this, prefetch fires every
   *  6 / 10 frames and the next frame kills it — defeating the
   *  whole purpose of prefetch (regression repro:
   *  _prefetch-cancelled.spec.ts saw 23 901 aborts over 5 s of a
   *  stationary camera at zoom 3.6). */
  private _prefetchKeys: Set<number> = new Set()
  /** Frames since last prefetchTiles call. Used to age out the
   *  shield so genuinely abandoned background fetches can still be
   *  cancelled — e.g., camera direction reverses and the previously-
   *  intended next-LOD is no longer interesting. */
  private _prefetchAge: number = 0
  /** Eviction shield for just-prefetched keys: key → expiresAt ms.
   *  Distinct from `_prefetchKeys` (cancel-shield, frame-counted
   *  age-out) — eviction happens against the catalog's MAX_CACHED_
   *  TILES cap, which on world-scale pan can fire many times per
   *  second. Without an evict shield the readiness gate's just-
   *  fetched target-LOD bytes get evicted next frame because the
   *  held cz's stableKeys don't include them yet, and the gate
   *  re-fetches forever (regression:
   *  _zoom-transition-blank-tiles.spec.ts zoom-in 13 → 16). 5 s is
   *  long enough to bridge gate hold → cz advance → tile becomes
   *  part of the new neededKeys (and thus protectedKeys). */
  private _evictShield: Map<number, number> = new Map()
  // Reduced 5 s → 2 s after real-device inspector (iPhone) showed
  // 62 keys still protected by the shield while catalog cache sat
  // at 296 MB. With 5 s TTL + a steady stream of prefetch the shield
  // population grew faster than the natural eviction churn could
  // drain it. 2 s still bridges the prefetch → cz-advance gap on
  // mobile (typical step LOD fetch settles in 0.5-1 s).
  private static readonly EVICT_SHIELD_TTL_MS = 2_000

  /** Prefetch variant of requestTiles: forwards to the same dispatch
   *  path but also adds the keys to `_prefetchKeys` so this frame's
   *  cancelStale won't abort them. Use this from background-fetch
   *  call sites (Tier 2, adjacent prefetch); `requestTiles` remains
   *  the path for visible / parent-fallback tiles. */
  prefetchTiles(keys: number[]): void {
    if (keys.length === 0) return
    this.requestTiles(keys)
    const expiresAt = Date.now() + TileCatalog.EVICT_SHIELD_TTL_MS
    for (const k of keys) {
      this._prefetchKeys.add(k)
      this._evictShield.set(k, expiresAt)
    }
    this._prefetchAge = 0
  }

  /** Pin `keys` as permanent skeleton — they survive `evictTiles`
   *  unconditionally and `cancelStale` never aborts their in-flight
   *  fetch. Idempotent; safe to call before or after `prefetchTiles`
   *  for the same keys. The intended caller is `prewarmSkeleton` (this
   *  same class), invoked after every source attach — PMTiles,
   *  TileJSON, XGVT-binary, GeoJSON-runtime — to mark the global
   *  low-zoom quadtree (z=0..N, default N=3 desktop / 2 mobile) so
   *  the parent-fallback walk in `classifyFallback` always finds a
   *  cached ancestor regardless of pan distance. The skeleton-prewarm
   *  pump terminates by polling `hasTileData(key)` — no separate
   *  predicate needed. */
  markSkeleton(keys: Iterable<number>): void {
    for (const k of keys) this._skeletonKeys.add(k)
  }

  /** Pre-fetch and pin the global low-zoom quadtree skeleton. Mirrors
   *  Cesium `QuadtreePrimitive`'s permanent root retention so the
   *  per-frame parent-fallback walk in `classifyFallback` always finds
   *  a cached ancestor — bridges Rule 1's top-down request order
   *  (replace refinement) by pre-loading the chain head.
   *
   *  Common entry point for ALL source types — PMTiles, TileJSON,
   *  XGVT-binary, GeoJSON-runtime. Each source's attach path calls
   *  this after its index is ready; the prefetchTiles dispatch routes
   *  through whatever fetch / decode / synthesise path the backend
   *  uses, so a TileJSON sees HTTP fetches while an XGVT-binary sees
   *  worker decodes — same skeleton key set, same eviction protection.
   *
   *  Pump rationale: `requestTiles` breaks at `maxConcurrentLoads()`
   *  and silently drops the rest. The 250 ms retry tick covers
   *  waves; distance-from-camera ordering inside the backend's queue
   *  handles top-down sorting for free. Fire-and-forget — caller
   *  doesn't await. */
  prewarmSkeleton(opts: {
    depth?: number
    minzoom?: number
    maxzoom?: number
  } = {}): void {
    const depth = opts.depth ?? defaultSkeletonDepth()
    const sourceMinzoom = opts.minzoom ?? 0
    const sourceMaxzoom = opts.maxzoom ?? this.index?.header.maxLevel ?? 0
    if (depth < 0) return
    const cap = Math.min(depth, sourceMaxzoom)
    const start = Math.max(0, sourceMinzoom)
    if (cap < start) return
    const keys: number[] = []
    for (let z = start; z <= cap; z++) {
      const n = 1 << z
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          keys.push(tileKey(z, x, y))
        }
      }
    }
    if (keys.length === 0) return
    // Mark BEFORE the first prefetch — guarantees protection even if
    // an evictTiles / cancelStale fires between enqueue and the first
    // bytes arriving.
    this.markSkeleton(keys)
    const tick = (): void => {
      const remaining = keys.filter(k => !this.hasTileData(k))
      if (remaining.length === 0) return
      this.prefetchTiles(remaining)
      setTimeout(tick, 250)
    }
    tick()
  }

  /** Update the fetch-queue priority comparator on every backend that
   *  has a priority queue (PMTiles). Comparator returns positive when
   *  `a` should run before `b` — i.e. closer to camera is "higher
   *  priority", sorts last, and pops first. VTR calls this once per
   *  frame before `requestTiles` so the queue's next sort uses the
   *  current camera centre. */
  setFetchPriority(distanceFromCamera: (key: number) => number): void {
    for (const b of this.backends) {
      b.setFetchPriorityCallback?.(
        (a, c) => distanceFromCamera(c) - distanceFromCamera(a),
      )
    }
  }

  /** Delegate cancellation to every backend that supports it. VTR
   *  calls this each frame with the union of currently-needed keys
   *  (visible tiles + parent fallbacks); we union in `_prefetchKeys`
   *  so background prefetch fetches survive the per-frame
   *  cancellation pass. Backends abort in-flight fetches whose keys
   *  aren't in the merged set so the network + worker pool stop
   *  wasting capacity on tiles the camera moved past. Backends
   *  without a cancellation hook (XGVT-binary, GeoJSON-runtime) are
   *  no-ops here. */
  cancelStale(activeKeys: Set<number>): void {
    const needsCopy = this._prefetchKeys.size > 0 || this._skeletonKeys.size > 0
    const merged: Set<number> = needsCopy ? new Set(activeKeys) : activeKeys
    if (this._prefetchKeys.size > 0) {
      for (const k of this._prefetchKeys) merged.add(k)
    }
    // Skeleton keys are never abortable — they're the permanent base
    // layer that the parent-fallback walk relies on. Without this
    // union, the prewarm pump's 250 ms gap between retries collides
    // with the `_prefetchAge > 12` clear below: prefetch shield drops,
    // next cancelStale wipes in-flight skeleton fetches, and the pump
    // has to re-issue them on the next tick. Pinning here closes the
    // window completely.
    if (this._skeletonKeys.size > 0) {
      for (const k of this._skeletonKeys) merged.add(k)
    }
    for (const b of this.backends) {
      b.cancelStale?.(merged)
    }
    // Age out the prefetch shield: after ~12 frames without a new
    // prefetch call (i.e. camera lost interest in this LOD), drop
    // the set so genuinely abandoned fetches become cancellable.
    // 12 frames ≈ 200 ms at 60 fps — comfortably longer than a
    // single prefetch round (Tier 2 every 6, adjacent every 10).
    this._prefetchAge++
    if (this._prefetchAge > 12 && this._prefetchKeys.size > 0) {
      this._prefetchKeys.clear()
    }
  }

  requestTiles(keys: number[]): void {
    if (!this.index || this.backends.length === 0) return

    // Per-backend batches for backends that support batched fetch
    // (XGVT-binary's range-merge). Single keys go through loadTile.
    const batches = new Map<TileSource, number[]>()

    const _maxConcurrent = maxConcurrentLoads()
    for (const key of keys) {
      if (this.dataCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= _maxConcurrent) break

      // Preregistered entries (XGVT-binary) route through entryToBackend.
      const owner = this.entryToBackend.get(key)
      if (owner) {
        const entry = this.index.entryByHash.get(key)!
        // Full-cover tiles with no data: synthesise quad immediately
        // from the cached entry — no fetch needed.
        if ((entry.flags & TILE_FLAG_FULL_COVER) && entry.compactSize === 0) {
          this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
          continue
        }
        if (owner.loadTilesBatch) {
          let batch = batches.get(owner)
          if (!batch) { batch = []; batches.set(owner, batch) }
          batch.push(key)
        } else {
          owner.loadTile(key)
        }
        continue
      }

      // Lazy-discovery path: walk backends, first one that claims the
      // key wins. compileSync (GeoJSON-runtime) is preferred over
      // async loadTile when both are available.
      for (const backend of this.backends) {
        if (!backend.has(key)) continue
        if (backend.compileSync) {
          if (this.tryCompileSync(key, backend)) break
        } else {
          backend.loadTile(key)
          break
        }
      }
    }

    for (const [backend, batch] of batches) {
      backend.loadTilesBatch!(batch)
    }
  }

  /** Per-frame budget gate around backend.compileSync. Returns true if
   *  the backend produced (and budget was charged). */
  private tryCompileSync(key: number, backend: TileSource): boolean {
    if (!backend.compileSync) return false
    if (this._budgetExceeded(this._compileCountThisFrame, TileCatalog._COMPILE_FLOOR)) return false
    const ok = backend.compileSync(key)
    if (ok) this._compileCountThisFrame++
    return ok
  }

  private createFullCoverTileData(
    key: number, entry: TileIndexEntry,
    lineVertices: Float32Array, lineIndices: Uint32Array,
    /** Per-MVT-layer slot. '' for single-layer sources; layer name
     *  for sliced sources (PMTiles water/landuse/etc.). The synthesised
     *  full-cover quad must land in the same slot the requesting xgis
     *  layer queries — otherwise water tiles tagged fullCover render as
     *  black holes (the quad sits in the '' slot, but the layer asks
     *  for the 'water' slot). */
    sourceLayer = '',
  ): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const fid = entry.fullCoverFeatureId

    // DSFUN stride-5 quad in tile-local Mercator meters. Corner 0 is
    // (0,0), corner 2 is (merc_width, merc_height).
    const [tileMx, tileMy] = lonLatToMercF64(tileWest, tileSouth)
    const [neMx, neMy] = lonLatToMercF64(tileEast, tileNorth)
    const mercWidth = neMx - tileMx
    const mercHeight = neMy - tileMy

    const splitLocal = (v: number): [number, number] => {
      const h = Math.fround(v)
      return [h, Math.fround(v - h)]
    }
    const [wH, wL] = splitLocal(mercWidth)
    const [hH, hL] = splitLocal(mercHeight)

    const vertices = new Float32Array([
      // (0, 0)
      0, 0, 0, 0, fid,
      // (width, 0)
      wH, 0, wL, 0, fid,
      // (width, height)
      wH, hH, wL, hL, fid,
      // (0, height)
      0, hH, 0, hL, fid,
    ])
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3])

    this.cacheTileData(
      key, undefined, vertices, indices, lineVertices, lineIndices,
      undefined, undefined, undefined, undefined, undefined, undefined,
      sourceLayer,
    )
  }

  private cacheTileData(
    key: number,
    polygons: RingPolygon[] | undefined,
    vertices: Float32Array, indices: Uint32Array,
    lineVertices: Float32Array, lineIndices: Uint32Array,
    pointVertices?: Float32Array,
    outlineIndices?: Uint32Array,
    outlineVertices?: Float32Array,
    outlineLineIndices?: Uint32Array,
    prebuiltLineSegments?: Float32Array,
    prebuiltOutlineSegments?: Float32Array,
    /** MVT layer slot. '' (default) for single-layer sources;
     *  layer name for per-MVT-layer slices. */
    sourceLayer = '',
    heights?: ReadonlyMap<number, number>,
    bases?: ReadonlyMap<number, number>,
    featureProps?: ReadonlyMap<number, Record<string, unknown>>,
  ): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI

    const data: TileData = {
      vertices, indices, lineVertices, lineIndices,
      outlineIndices: outlineIndices ?? new Uint32Array(0),
      outlineVertices: outlineVertices && outlineVertices.length > 0 ? outlineVertices : undefined,
      outlineLineIndices: outlineLineIndices && outlineLineIndices.length > 0 ? outlineLineIndices : undefined,
      pointVertices,
      prebuiltLineSegments: prebuiltLineSegments && prebuiltLineSegments.length > 0 ? prebuiltLineSegments : undefined,
      prebuiltOutlineSegments: prebuiltOutlineSegments && prebuiltOutlineSegments.length > 0 ? prebuiltOutlineSegments : undefined,
      tileWest, tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
      tileZoom: tz,
      polygons,
      heights,
      bases,
      featureProps,
    }

    this.setSlice(key, sourceLayer, data)
    try { this.onTileLoaded?.(key, data, sourceLayer) }
    catch (e) { console.error('[onTileLoaded]', (e as Error)?.stack ?? e) }
  }

  // ── Sub-tile generation (overzoom CPU clipping) ──

  generateSubTile(subKey: number, parentKey: number, sourceLayer = ''): boolean {
    // Per-slice short-circuit: a different layer may already have
    // generated its slice for this subKey; we still need to do the
    // work for THIS layer if its slot is empty. Return cached without
    // charging budget — not new work.
    if (this.hasTileData(subKey, sourceLayer)) return true

    // Hybrid per-frame budget — see resetCompileBudget() comment.
    // Historically two count-based gates (>=16 / >=8); the 8-cap caused
    // 60-frame (~1 s) convergence stalls at pitch ≥ 60° with ~280
    // frustum tiles of microsecond-scale sub-tile clips. Hybrid keeps
    // the 8-call floor so low-zoom heavy parent geometry still self-
    // throttles, while letting µs-scale high-zoom bursts fill the 6 ms
    // wall-clock budget (typically 50+ sub-tiles per frame at z ≥ 10).
    if (this._budgetExceeded(this._subTileCountThisFrame, TileCatalog._SUBTILE_FLOOR)) return false

    // Per-slice clip: parent stores one TileData per MVT source-layer
    // (PMTiles 'water', 'roads', …) plus the '' slot for single-layer
    // sources. Clip the SAME layer's parent slice into the requested
    // subKey/sourceLayer slot — at over-zoom past archive maxZoom
    // every active xgis layer needs its own sub-tile slice or the
    // layer renders as a black hole.
    const parent = this.getTileData(parentKey, sourceLayer)
    if (!this.subTileGen.hasClippableGeometry(parent)) return false

    const subData = this.subTileGen.generate(parent!, subKey)
    if (!subData) return false

    this.setSlice(subKey, sourceLayer, subData)
    this._subTileCountThisFrame++
    try { this.onTileLoaded?.(subKey, subData, sourceLayer) }
    catch (e) { console.error('[onTileLoaded sub]', (e as Error)?.stack ?? e) }
    return true
  }


  // ── Prefetch ──

  prefetchAdjacent(visTiles: { z: number; x: number; y: number }[], zoom: number): void {
    if (!this.index || visTiles.length === 0) return

    // visTiles is the mixed-zoom output of visibleTilesFrustum (the quadtree
    // returns leaves at whatever LOD hit the screen-space threshold — near
    // tiles at currentZ, far/low-pitch tiles at lower z). The previous
    // implementation took an AABB over the raw `t.x / t.y` values, which is
    // nonsense across zoom levels: a z=3 tile with x=3 and a z=18 tile with
    // x=200000 produced a 200000×Y loop, ~500M iterations, and a 16-second
    // main-thread stall (measured in the perf-scenarios hybrid suite).
    //
    // Fix: only consider visTiles at `zoom` when computing the AABB. Tiles
    // at other zoom levels are already covered by their own prefetch pass.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    let matched = 0
    for (const t of visTiles) {
      if (t.z !== zoom) continue
      matched++
      if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x
      if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y
    }
    if (matched === 0) return

    const n = Math.pow(2, zoom)
    const prefetchKeys: number[] = []
    // Hard safety cap so a future misuse (e.g. passing an unexpectedly
    // wide AABB) can never repeat the 500 M-iteration stall. Realistic
    // visible tile spans at any camera are < ~30 on either axis; 128 is
    // generous and still small enough to complete in under 1 ms.
    const MAX_SPAN = 128
    if (maxX - minX > MAX_SPAN || maxY - minY > MAX_SPAN) return

    for (let rawX = minX - 1; rawX <= maxX + 1; rawX++) {
      const x = ((rawX % n) + n) % n  // wrap X for world wrapping
      for (let y = Math.max(0, minY - 1); y <= Math.min(n - 1, maxY + 1); y++) {
        if (rawX >= minX && rawX <= maxX && y >= minY && y <= maxY) continue
        const key = tileKey(zoom, x, y)
        // Keep already-loading keys in the intent set so prefetchTiles
        // re-marks them in `_prefetchKeys` and they survive the per-
        // frame cancelStale shield rotation. `prefetchTiles` →
        // `requestTiles` dedupes loadingTiles internally so this is
        // free.
        if (!this.dataCache.has(key) && this.index.entryByHash.has(key)) {
          prefetchKeys.push(key)
        }
      }
    }

    const _cap = maxConcurrentLoads()
    if (prefetchKeys.length > 0 && this.loadingTiles.size < _cap) {
      this.prefetchTiles(prefetchKeys.slice(0, _cap - this.loadingTiles.size))
    }
  }

  prefetchNextZoom(
    centerLon: number, centerLat: number,
    currentZ: number, canvasWidth: number, canvasHeight: number,
    cameraZoom: number,
  ): void {
    const _capNext = maxConcurrentLoads()
    if (!this.index || this.loadingTiles.size >= _capNext) return

    const nextZ = currentZ + 1
    const maxSubZ = this.index.header.maxLevel + 6
    if (nextZ > maxSubZ) return

    const nextTiles = visibleTiles(centerLon, centerLat, nextZ, canvasWidth, canvasHeight, cameraZoom)
    const prefetchKeys: number[] = []

    for (const t of nextTiles) {
      const key = tileKey(t.z, t.x, t.y)
      if (this.dataCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.index.entryByHash.has(key)) {
        prefetchKeys.push(key)
      }
    }

    if (prefetchKeys.length > 0) {
      const slots = _capNext - this.loadingTiles.size
      if (slots > 0) this.requestTiles(prefetchKeys.slice(0, slots))
    }
  }

  // ── Cache eviction ──

  /** Recompute the actual byte size of every cached TileData and
   *  compare against the running `_cachedBytes` accumulator. Drift
   *  triggered the user-reported "263 MB for 2 tiles" inspector
   *  bug (commit 497a2c1: prebuiltLineSegments were included in
   *  setSlice's add but excluded from delete after GPU upload
   *  nulled them). Activated by `globalThis.__XGIS_INVARIANTS`;
   *  production builds skip the recomputation entirely. */
  private assertByteAccountingInvariant(label: string): void {
    if (!(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS) return
    let actual = 0
    for (const slot of this.dataCache.values()) {
      for (const td of slot.values()) {
        actual += TileCatalog.sizeOfTileData(td)
      }
    }
    const drift = Math.abs(actual - this._cachedBytes)
    // 1 KB tolerance — Math.fround / typed-array byteLength rounding
    // shouldn't introduce more than a handful of bytes per tile;
    // a tile-count multiplier of <1 KB across hundreds of tiles
    // means the accounting is consistent.
    if (drift > 1024) {
      throw new Error(
        `[XGIS INVARIANT] _cachedBytes drift at ${label}: actual=${actual} `
        + `accumulator=${this._cachedBytes} drift=${drift} bytes across `
        + `${this.dataCache.size} tile slots. The setSlice / deleteCacheEntry `
        + `byte-add/subtract path is out of sync with sizeOfTileData. See `
        + `commit 497a2c1 for the prebuilt-SDF drift class.`,
      )
    }
  }

  evictTiles(protectedKeys: Set<number>): void {
    this.assertByteAccountingInvariant('evictTiles-entry')
    // Snapshot the protected keys that ARE in catalog pre-eviction —
    // these must survive the eviction call (Cesium replacement
    // invariant). Only takes effect when invariants are enabled.
    const _inv = (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS
    // Both protectedKeys (frame-scoped: stableKeys + ancestors) and
    // _skeletonKeys (permanent low-zoom base) must survive eviction.
    // Union them into the invariant snapshot so a regression that
    // accidentally drops a skeleton key fires the same audit error
    // as a frame-protected drop — single failure mode, single
    // diagnostic.
    const _protectedPresent = _inv
      ? new Set(
          [...protectedKeys, ...this._skeletonKeys]
            .filter(k => this.dataCache.has(k)),
        )
      : null
    // Two caps: byte-based (tight, accurate) and count-based
    // (loose safety net). Either tripping is enough to trigger
    // eviction; the loop runs until BOTH are under their limits.
    const _byteCap = maxCachedBytes()
    if (this.dataCache.size <= MAX_CACHED_TILES
        && this._cachedBytes <= _byteCap) {
      // Nothing to do — but still verify the protected set wasn't
      // accidentally dropped by some prior code path.
      if (_inv && _protectedPresent) {
        for (const k of _protectedPresent) {
          if (!this.dataCache.has(k)) {
            throw new Error(`[XGIS INVARIANT] protected key ${k} missing from catalog at evictTiles entry — replacement invariant violated by a prior code path`)
          }
        }
      }
      return
    }

    // Eviction: anything not in `protectedKeys` (visible + fallback
    // ancestors for the current frame) is fair game. The previous
    // policy ALSO blanket-protected every z ≤ maxLevel ancestor
    // archive-wide so over-zoom sub-tile gen could re-clip from a
    // surviving ancestor — but that protection scaled with the
    // number of regions the user pans through, and on world-scale
    // navigation it grew without bound (multi-GB heap → OOM the
    // user reported on the live PMTiles archive, repro:
    // _pmtiles-stress-leak.spec.ts).
    //
    // The visible-frame protection (caller passes stableKeys =
    // neededKeys ∪ fallbackKeys) covers every ancestor sub-tile
    // gen actually needs THIS frame; ancestors for non-visible
    // regions are recoverable by re-fetching when the camera
    // returns to them — at the cost of a brief load shimmer, which
    // is far preferable to OOM.
    // Cleanup expired evict-shield entries first so they don't
    // permanently freeze the cap once a key's TTL passes.
    const now = Date.now()
    for (const [k, exp] of this._evictShield) {
      if (exp <= now) this._evictShield.delete(k)
    }
    // Also protect keys the catalog prefetched within the last
    // EVICT_SHIELD_TTL_MS (5 s). The held-cz step prefetch lives
    // here for long enough to bridge the gap between fetch
    // completing and the cz advance that puts the key into
    // stableKeys — without that bridge the gate stalls forever
    // (regression: _zoom-transition-blank-tiles.spec.ts).
    // Skeleton keys (Cesium-style permanent base layer) are
    // unconditionally protected — see `_skeletonKeys` doc.
    const entries = [...this.dataCache.entries()]
      .filter(([key]) => !protectedKeys.has(key)
                      && !this._evictShield.has(key)
                      && !this._skeletonKeys.has(key))

    // Insertion order ≈ LRU (Map iteration order is insertion order;
    // re-inserts on access would yield true LRU but cacheTileData
    // / setSlice doesn't re-insert).
    let i = 0
    while (i < entries.length
           && (this.dataCache.size > MAX_CACHED_TILES
               || this._cachedBytes > _byteCap)) {
      this.deleteCacheEntry(entries[i][0])
      i++
    }
    this.assertByteAccountingInvariant('evictTiles-exit')

    // Cesium replacement-invariant audit: every protected key that
    // was present pre-eviction must still be present post-eviction.
    // The filter at line 1333 skipped these so the loop above
    // shouldn't have touched them — this catches future regressions
    // where the filter is altered.
    if (_inv && _protectedPresent) {
      for (const k of _protectedPresent) {
        if (!this.dataCache.has(k)) {
          throw new Error(
            `[XGIS INVARIANT] protected key ${k} was evicted despite being in `
            + `protectedKeys — replacement invariant violated. The eviction `
            + `filter at evictTiles must skip every key in protectedKeys.`,
          )
        }
      }
    }
  }
}

// ═══ Helpers ═══

/** Bounding union of two lon/lat rectangles. Used by mergeBackendMeta
 *  when multiple backends contribute coverage. */
function unionBounds(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ]
}

