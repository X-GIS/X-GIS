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
  packECEFPolygonVertices, tileEcefCenterFromMerc,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { xlog } from '@xgis/shared'
import { visibleTiles } from './tile-select'
import { VirtualCatalogAdapter } from './sources/virtual-catalog-adapter'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
import { SubTileGenerator } from './sub-tile-generator'
import {
  TILE_LAYOUT_VERSION, TILE_LAYOUT_VERSION_BASE,
  type TileSource, type TileSourceSink, type BackendTileResult, type TileScheme,
} from './tile-source'
// Step 0 of the layer-type refactor: shared types live in tile-types.ts so
// per-format backend modules can import them without pulling in catalog
// runtime state. Re-exported below for back-compat with external callers
// (loadPMTilesSource etc. import these from xgvt-source.ts today).
import {
  type TileData, type TileState, type CacheTileDataDescriptor,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  maxConcurrentLoads, defaultSkeletonDepth,
  type VirtualCatalog, type VirtualTileFetcher,
} from './tile-types'
import { unionBounds } from './tile-catalog-helpers'
import { TileDataCache } from './tile-data-cache'
import { CompileBudget } from './tile-compile-budget'
import { TileEvictionPolicy } from './tile-eviction-policy'

export {
  type TileData, type TileState,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  type VirtualCatalog, type VirtualTileFetcher,
}

// ═══ Catalog ═══

export class TileCatalog {
  private index: XGVTIndex | null = null
  /** In-memory compiled-tile store + byte accounting. Extracted to
   *  TileDataCache (redesign §3.5): owns the per-(tile key, source-
   *  layer) TileData map, the cumulative byte total, and the
   *  setSlice / deleteCacheEntry bookkeeping that keeps the two in
   *  sync. The catalog owns only the eviction POLICY; the cache owns
   *  the accounting MECHANISM. */
  private cache = new TileDataCache()
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

  /** Backends already warned about a layoutVersion mismatch — keeps the
   *  attach-time warn one-shot per backend instance so noisy re-attaches
   *  (test harnesses, hot reload) don't spam the log. */
  private _layoutMismatchWarned = new WeakSet<TileSource>()

  /** Cache-retention policy: owns the permanently-pinned low-zoom
   *  skeleton key set, the transient just-prefetched evict-shield, and
   *  the LRU + byte-cap eviction sweep. Extracted to TileEvictionPolicy
   *  (C5 split); the catalog delegates markSkeleton / evictTiles /
   *  prefetch-shield + reads the skeleton set for cancelStale. */
  private eviction = new TileEvictionPolicy()

  /** Per-frame compile + sub-tile scheduling budget (hybrid count-floor
   *  + time-ceiling). Extracted to CompileBudget (C5 split); the catalog
   *  decides WHEN to reset (resetCompileBudget, which also ticks
   *  backends) and the budget owns the counting + gate. */
  private budget = new CompileBudget()

  /** Pending timer handle for the prewarmSkeleton retry pump + a
   *  hard-stop latch. The pump self-reschedules every 250 ms until
   *  every skeleton key reports hasTileData; a 'failed' (5xx/network)
   *  skeleton tile never populates dataCache, so without an explicit
   *  cancel the pump reschedules for the page lifetime — GC-pinning
   *  the catalog and firing prefetch against a dead source. destroy()
   *  clears the handle + sets the latch so tick() bails. */
  private _skeletonTimer: ReturnType<typeof setTimeout> | null = null
  private _stopped = false

  /** Internal: set a slice via the TileDataCache (byte accounting +
   *  nested-map insert). Thin delegate — kept as a method so the
   *  test escape-hatch (`(catalog as …).setSlice.bind(catalog)` in
   *  tile-catalog-skeleton / -lifecycle / multi-layer-overzoom tests)
   *  keeps reaching the same injection path. */
  private setSlice(key: number, layer: string, data: TileData): void {
    this.cache.setSlice(key, layer, data)
  }

  /** Internal: drop a key (all slices) from the cache, keeping byte
   *  accounting in sync. Thin delegate to TileDataCache. */
  private deleteCacheEntry(key: number): void {
    this.cache.deleteCacheEntry(key)
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

  /** Build a per-backend sink that captures `backend` in closure so
   *  acceptResult can stamp `originBackend` on every TileData it stores.
   *  Each call produces a fresh object — one sink per backend instance,
   *  not a shared singleton — which is the prerequisite for per-backend
   *  cache invalidation (PR 2c.5 evictTilesForBackend). */
  private makeSink(backend: TileSource): TileSourceSink {
    return {
      hasTileData: (key) => this.cache.has(key),
      trackLoading: (key) => { this.loadingTiles.add(key) },
      releaseLoading: (key) => { this.loadingTiles.delete(key) },
      getLoadingCount: () => this.loadingTiles.size,
      acceptResult: (key, result, sourceLayer) => this.acceptResult(key, result, sourceLayer, backend),
    }
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
    backend.attach(this.makeSink(backend))
    this.backends.push(backend)
    this.mergeBackendMeta(backend)
    this.checkLayoutVersion(backend)
  }

  /** Compare the attaching backend's `meta.layoutVersion` against the
   *  running runtime's `TILE_LAYOUT_VERSION`. On mismatch, evict any
   *  cached tiles attributable to this backend (and the legacy
   *  unattributed entries — see {@link evictTilesForBackend}) so the next
   *  visible frame re-decodes through the new layout. Backends shipped
   *  before the field existed surface as `undefined`; that's treated as
   *  `TILE_LAYOUT_VERSION_BASE`. The warn fires once per (catalog,
   *  backend) pair via `_layoutMismatchWarned`. */
  private checkLayoutVersion(backend: TileSource): void {
    const v = backend.meta.layoutVersion
    const mismatch = v === undefined
      ? TILE_LAYOUT_VERSION > TILE_LAYOUT_VERSION_BASE
      : v !== TILE_LAYOUT_VERSION
    if (!mismatch) return
    this.evictTilesForBackend(backend)
    if (!this._layoutMismatchWarned.has(backend)) {
      this._layoutMismatchWarned.add(backend)
      xlog.warn(`[X-GIS] tile-layout-version mismatch for source: cached=${v ?? TILE_LAYOUT_VERSION_BASE}, running=${TILE_LAYOUT_VERSION} — evicting cache + re-decoding`)
    }
  }

  /** Drop every cached tile key whose slice list either matches this
   *  backend or carries the pre-attribution `undefined` marker (entries
   *  cached before TileData.originBackend shipped in PR 2c.1 — the
   *  cache-attribution backfill contract treats them as "any backend"
   *  for eviction). Routed through {@link deleteCacheEntry} so
   *  `_cachedBytes` stays in sync. */
  private evictTilesForBackend(backend: TileSource): void {
    const toDelete: number[] = []
    for (const [key, slot] of this.cache.entries()) {
      for (const td of slot.values()) {
        if (td.originBackend === backend || td.originBackend === undefined) {
          toDelete.push(key)
          break
        }
      }
    }
    for (const k of toDelete) this.deleteCacheEntry(k)
  }

  /** Catalog's primary tile scheme — the first-attached backend's scheme.
   *  Returns undefined before any backend is attached. Mixed-scheme dispatch
   *  is deferred until multi-scheme backends exist; today every attach is
   *  Mercator XYZ. Per-source name lookup belongs at SourceManager, which
   *  owns the source-name → catalog map. */
  getScheme(): TileScheme | undefined {
    return this.backends[0]?.meta.scheme
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
   *  backends used to do via bespoke sinks. Called by the per-backend
   *  sink (see makeSink) so `backend` is always the exact TileSource
   *  that produced this result. Pass null for empty placeholder
   *  (backend determined no data for this key). */
  private acceptResult(key: number, result: BackendTileResult | null, sourceLayer = '', backend?: TileSource): void {
    if (!result) {
      const empty = new Float32Array(0)
      const emptyI = new Uint32Array(0)
      this.cacheTileData({
        key, vertices: empty, indices: emptyI, lineVertices: empty, lineIndices: emptyI,
        sourceLayer, originBackend: backend,
      })
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
        this.createFullCoverTileData(key, entry, result.lineVertices, result.lineIndices, sourceLayer, backend)
        return
      }
    }
    this.cacheTileData({
      key,
      polygons: result.polygons,
      vertices: result.vertices, indices: result.indices,
      lineVertices: result.lineVertices, lineIndices: result.lineIndices,
      pointVertices: result.pointVertices,
      outlineIndices: result.outlineIndices,
      outlineVertices: result.outlineVertices,
      outlineLineIndices: result.outlineLineIndices,
      prebuiltLineSegments: result.prebuiltLineSegments,
      prebuiltOutlineSegments: result.prebuiltOutlineSegments,
      sourceLayer,
      heights: result.heights,
      bases: result.bases,
      featureProps: result.featureProps,
      originBackend: backend,
      dequant: { scale: result.dequantScale, half: result.dequantHalf },
    })
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
  // The budget state machine (deadline, counters, floor/ceiling gate)
  // lives in CompileBudget (this.budget). The catalog owns WHEN to
  // reset it (per frame, also ticking backends) and gates compile /
  // sub-tile calls through it.

  /** Reset per-frame budget. The frameId arg is reserved for future
   *  frame-shared budget work (currently unused — each layer gets
   *  its own sliced budget per the constants above). */
  resetCompileBudget(_frameId: number = -1): void {
    this.budget.reset()
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

  /** Synchronous on-demand compile path. Walks attached backends and
   *  uses the first one that supports compileSync (GeoJSON-runtime
   *  today). Catalog gates the call with the per-frame compile budget;
   *  backend handles parts lookup, compileSingleTile, and result push
   *  via the shared sink. */
  compileTileOnDemand(key: number): boolean {
    if (this.cache.has(key)) return false
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
    const slot = this.cache.getSlot(key)
    if (!slot) return null
    if (sourceLayer) return slot.get(sourceLayer) ?? null
    // Back-compat: '' = default slice, OR first slice if only per-layer present.
    const def = slot.get('')
    if (def) return def
    const it = slot.values().next()
    return it.done ? null : it.value
  }

  hasTileData(key: number, sourceLayer?: string): boolean {
    const slot = this.cache.getSlot(key)
    if (!slot) return false
    if (sourceLayer) return slot.has(sourceLayer)
    return slot.size > 0
  }

  isLoading(key: number): boolean {
    return this.loadingTiles.has(key)
  }

  /** Per-tile lifecycle state, derived from the catalog's tracking
   *  structures + each backend's failure cache. Returns one of
   *  `'unloaded' | 'loading' | 'cached' | 'failed'`. Cached wins over
   *  loading wins over failed wins over unloaded — a tile in `dataCache`
   *  is observably loaded even if a stale failedKeys entry hasn't been
   *  swept yet, and a tile in `loadingTiles` may still race a previous
   *  failure that's about to expire. See `TileState` in tile-types.ts
   *  for the transition diagram. */
  getTileState(key: number): TileState {
    if (this.cache.has(key)) return 'cached'
    if (this.loadingTiles.has(key)) return 'loading'
    for (const b of this.backends) {
      if (b.isFailed?.(key)) return 'failed'
    }
    return 'unloaded'
  }

  /** Diagnostic — total tile-key count partitioned by state. Cheap;
   *  no per-key iteration of backends. Useful for FLICKER / load-curve
   *  inspection in inspectPipeline. The `failed` count is omitted
   *  because backend failure caches don't expose a size accessor and
   *  failed keys are typically rare; query individual keys via
   *  getTileState if needed. */
  getStateBreakdown(): { cached: number; loading: number } {
    return { cached: this.cache.size, loading: this.loadingTiles.size }
  }

  /** True when any tile is still being fetched. Read each frame by the
   *  render-loop idle-skip so late arrivals trigger a redraw. */
  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  getCacheSize(): number {
    return this.cache.size
  }

  /** Diagnostic accessors — let inspectPipeline() + CPU debug tests
   *  read the budget/queue state without reaching into private fields.
   *  Not part of the public API.  */
  getSubTileBudgetUsed(): number { return this.budget.subTileCountThisFrame }
  getCompileBudgetUsed(): number { return this.budget.compileCountThisFrame }
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
          this.cacheTileData({
            key, polygons,
            vertices: tile.vertices, indices: tile.indices,
            lineVertices: tile.lineVertices, lineIndices: tile.lineIndices,
            pointVertices: tile.pointVertices, outlineIndices: tile.outlineIndices,
            dequant: { scale: tile.dequantScale, half: tile.dequantHalf },
          })
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
        this.cacheTileData({
          key, polygons,
          vertices: tile.vertices, indices: tile.indices,
          lineVertices: tile.lineVertices, lineIndices: tile.lineIndices,
          pointVertices: tile.pointVertices, outlineIndices: tile.outlineIndices,
          dequant: { scale: tile.dequantScale, half: tile.dequantHalf },
        })
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
  // Iter 131 perf: reused merged-active-keys Set for cancelStale().
  // Avoids `new Set(activeKeys)` allocation per frame.
  private readonly _mergedScratch: Set<number> = new Set()
  /** Frames since last prefetchTiles call. Used to age out the
   *  shield so genuinely abandoned background fetches can still be
   *  cancelled — e.g., camera direction reverses and the previously-
   *  intended next-LOD is no longer interesting. */
  private _prefetchAge: number = 0
  // The eviction shield for just-prefetched keys (key → expiresAt ms,
  // 2 s TTL) lives in TileEvictionPolicy (this.eviction); prefetchTiles
  // populates it, evictTiles honours + drains it.

  /** Prefetch variant of requestTiles: forwards to the same dispatch
   *  path but also adds the keys to `_prefetchKeys` so this frame's
   *  cancelStale won't abort them. Use this from background-fetch
   *  call sites (Tier 2, adjacent prefetch); `requestTiles` remains
   *  the path for visible / parent-fallback tiles. */
  prefetchTiles(keys: number[]): void {
    if (keys.length === 0) return
    this.requestTiles(keys)
    const expiresAt = Date.now() + TileEvictionPolicy.EVICT_SHIELD_TTL_MS
    for (const k of keys) {
      this._prefetchKeys.add(k)
      this.eviction.shield(k, expiresAt)
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
    this.eviction.markSkeleton(keys)
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
      if (this._stopped) return
      const remaining = keys.filter(k => !this.hasTileData(k))
      if (remaining.length === 0) return
      this.prefetchTiles(remaining)
      this._skeletonTimer = setTimeout(tick, 250)
    }
    tick()
  }

  /** Stop the prewarmSkeleton retry pump and release what pins this
   *  catalog past its source's lifetime. Called from map.ts
   *  teardownSource (reached by both destroy() and _teardownForReinit)
   *  so a 'failed' skeleton tile can no longer keep the 250 ms pump —
   *  and the catalog + dataCache it captures — alive forever. */
  destroy(): void {
    this._stopped = true
    if (this._skeletonTimer !== null) {
      clearTimeout(this._skeletonTimer)
      this._skeletonTimer = null
    }
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
    const needsCopy = this._prefetchKeys.size > 0 || this.eviction.hasSkeleton
    // Iter 131 perf: reuse a single Set across frames when copy needed.
    // Pre-fix allocated `new Set(activeKeys)` per frame — at z=14 OFM
    // Liberty Seoul activeKeys has ~300 entries, ~600 Set ops + GC on
    // every frame. Profile attribution: cancelStale 104 ms (2.3 %) of
    // a 4 s window on Seoul Liberty z16-p60 perf survey.
    let merged: Set<number>
    if (needsCopy) {
      merged = this._mergedScratch
      merged.clear()
      for (const k of activeKeys) merged.add(k)
    } else {
      merged = activeKeys
    }
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
    if (this.eviction.hasSkeleton) {
      for (const k of this.eviction.skeletonKeys) merged.add(k)
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
      if (this.cache.has(key) || this.loadingTiles.has(key)) continue
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
    if (this.budget.compileExceeded()) return false
    const ok = backend.compileSync(key)
    if (ok) this.budget.chargeCompile()
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
    /** Backend that produced this tile — forwarded to cacheTileData
     *  so the synthesised quad carries originBackend attribution. */
    originBackend?: TileSource,
  ): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const fid = entry.fullCoverFeatureId

    // Quantized-ECEF quad (POLYGON_FILL_FORMAT, stride 28 B) spanning the tile,
    // input as ABSOLUTE Mercator metres — the SAME layout the fill pipeline
    // binds and the fill VS decodes. Built via the canonical packer + anchor the
    // tiler uses (vector-tiler.ts). Earlier this emitted a stride-5 tile-local
    // DSFUN quad with no f32 tail, so the fill VS mis-decoded position and the
    // per-fragment clip_bounds discard was inert (over-zoom flood).
    const [swMx, swMy] = lonLatToMercF64(tileWest, tileSouth)
    const [seMx, seMy] = lonLatToMercF64(tileEast, tileSouth)
    const [neMx, neMy] = lonLatToMercF64(tileEast, tileNorth)
    const [nwMx, nwMy] = lonLatToMercF64(tileWest, tileNorth)

    const scratchPv = [
      swMx, swMy, fid,  // corner 0 (SW)
      seMx, seMy, fid,  // corner 1 (SE)
      neMx, neMy, fid,  // corner 2 (NE)
      nwMx, nwMy, fid,  // corner 3 (NW)
    ]
    // tileOriginMerc = [merc(tileWest), merc(tileSouth)] = [swMx, swMy] — MUST
    // match the renderer's per-tile `tile_origin_merc` uniform. The packer
    // stores the f32 tail as TILE-LOCAL Mercator (mx − tileOriginMerc); omitting
    // this arg defaulted it to [0,0], so the tail held ABSOLUTE Mercator and the
    // flat fill VS double-counted the origin → the full-cover quad rendered at
    // the wrong place (pure-ocean tiles showed the background color, #449).
    const quant = packECEFPolygonVertices(
      scratchPv, tileEcefCenterFromMerc(swMx, swMy), [swMx, swMy],
    )
    const vertices = quant.vertices
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3])

    this.cacheTileData({
      key, vertices, indices, lineVertices, lineIndices,
      sourceLayer, originBackend,
      dequant: { scale: quant.dequantScale, half: quant.dequantHalf },
    })
  }

  /** Build + store a TileData from a {@link CacheTileDataDescriptor}.
   *  The descriptor struct-ifies what used to be ~18 positional args;
   *  field semantics + defaults (sourceLayer '', dequant identity) are
   *  unchanged. Computes the tile's degree bounds from its key, assembles
   *  the TileData, sets the slice, and fires onTileLoaded. */
  private cacheTileData(d: CacheTileDataDescriptor): void {
    const key = d.key
    const sourceLayer = d.sourceLayer ?? ''
    const dequant = d.dequant ?? { scale: 1, half: 0 }
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI

    const data: TileData = {
      vertices: d.vertices,
      dequantScale: dequant.scale,
      dequantHalf: dequant.half,
      indices: d.indices, lineVertices: d.lineVertices, lineIndices: d.lineIndices,
      outlineIndices: d.outlineIndices ?? new Uint32Array(0),
      outlineVertices: d.outlineVertices && d.outlineVertices.length > 0 ? d.outlineVertices : undefined,
      outlineLineIndices: d.outlineLineIndices && d.outlineLineIndices.length > 0 ? d.outlineLineIndices : undefined,
      pointVertices: d.pointVertices,
      prebuiltLineSegments: d.prebuiltLineSegments && d.prebuiltLineSegments.length > 0 ? d.prebuiltLineSegments : undefined,
      prebuiltOutlineSegments: d.prebuiltOutlineSegments && d.prebuiltOutlineSegments.length > 0 ? d.prebuiltOutlineSegments : undefined,
      tileWest, tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
      tileZoom: tz,
      polygons: d.polygons,
      heights: d.heights,
      bases: d.bases,
      featureProps: d.featureProps,
      originBackend: d.originBackend,
    }

    this.setSlice(key, sourceLayer, data)
    try { this.onTileLoaded?.(key, data, sourceLayer) }
    catch (e) { xlog.error('[onTileLoaded]', (e as Error)?.stack ?? e) }
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
    if (this.budget.subTileExceeded()) return false

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
    this.budget.chargeSubTile()
    try { this.onTileLoaded?.(subKey, subData, sourceLayer) }
    catch (e) { xlog.error('[onTileLoaded sub]', (e as Error)?.stack ?? e) }
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
        if (!this.cache.has(key) && this.index.entryByHash.has(key)) {
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
      if (this.cache.has(key) || this.loadingTiles.has(key)) continue
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

  evictTiles(protectedKeys: Set<number>): void {
    this.eviction.evictTiles(this.cache, protectedKeys)
  }
}

