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
  clipPolygonToRect, clipLineToRect,
  lonLatToMercF64,
  augmentRingWithArc, tessellateLineToArrays, packDSFUNLineVertices,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { visibleTiles } from '../loader/tiles'
import { XGVTBinaryBackend } from './sources/xgvt-binary-source'
import { VirtualCatalogAdapter } from './sources/virtual-catalog-adapter'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
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
  MAX_CACHED_TILES, maxCachedBytes, maxConcurrentLoads,
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
  }

  async loadFromURL(url: string): Promise<void> {
    const backend = this.getBinaryBackend()
    await backend.loadFromURL(url)
    this.mergeBackendMeta(backend)
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
    const merged: Set<number> =
      this._prefetchKeys.size === 0
        ? activeKeys
        : new Set(activeKeys)
    if (this._prefetchKeys.size > 0) {
      for (const k of this._prefetchKeys) merged.add(k)
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
    }

    this.setSlice(key, sourceLayer, data)
    try { this.onTileLoaded?.(key, data, sourceLayer) }
    catch (e) { console.error('[onTileLoaded]', (e as Error)?.stack ?? e) }
  }

  // ── Sub-tile generation (overzoom CPU clipping) ──

  generateSubTile(subKey: number, parentKey: number, sourceLayer = ''): boolean {
    // Return cached result without charging budget — this is not new work.
    // Per-slice short-circuit: a different layer may already have generated
    // its own slice for this subKey; we still need to do the work for THIS
    // layer if its slot is empty.
    if (this.hasTileData(subKey, sourceLayer)) return true

    // Hybrid per-frame budget — see resetCompileBudget() comment.
    // Historically two count-based gates (>=16 / >=8); the 8-cap caused
    // 60-frame (~1 s) convergence stalls at pitch ≥ 60° with ~280
    // frustum tiles of microsecond-scale sub-tile clips. Hybrid keeps
    // the 8-call floor so low-zoom heavy parent geometry still self-
    // throttles, while letting µs-scale high-zoom bursts fill the 6 ms
    // wall-clock budget (typically 50+ sub-tiles per frame at z ≥ 10).
    if (this._budgetExceeded(this._subTileCountThisFrame, TileCatalog._SUBTILE_FLOOR)) return false

    // Per-slice clip: the parent stores one TileData per MVT
    // source-layer (PMTiles 'water', 'roads', ...) plus the '' slot
    // for single-layer sources. We clip the SAME layer's parent
    // slice into the requested subKey/sourceLayer slot — at over-
    // zoom past archive maxZoom every active xgis layer needs its
    // own sub-tile slice or the layer renders as a black hole.
    const parent = this.getTileData(parentKey, sourceLayer)
    // Allow sub-tile gen for ANY non-empty slice — polygon-only,
    // line-only (PMTiles 'roads' / 'transit'), point-only ('places'
    // / 'pois'), or mixed. Without this, line-only slices were
    // silently dropped at over-zoom because the early-exit
    // checked indices/lineIndices but ignored pointVertices, and
    // the polygon path's empty-iter would never produce output.
    const hasGeom = parent
      && (parent.indices.length > 0
        || parent.lineIndices.length > 0
        || (parent.pointVertices && parent.pointVertices.length >= 5))
    if (!hasGeom) return false
    if (this.hasTileData(subKey, sourceLayer)) return false // already generated for this slot

    // NOTE: do NOT increment _subTileCountThisFrame here.
    // Counter is bumped exactly once per successful generation at the
    // bottom of this method (after setSlice). Earlier code bumped
    // both early AND late, double-charging the per-frame budget so
    // 4 layer calls registered as 8 → FLOOR exceeded mid-frame →
    // time-budget mode → late layers starved at the 2 ms deadline.

    const [sz, sx, sy] = tileKeyUnpack(subKey)
    const sn = Math.pow(2, sz)

    const subWest = sx / sn * 360 - 180
    const subEast = (sx + 1) / sn * 360 - 180
    const subSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (sy + 1) / sn))) * 180 / Math.PI
    const subNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * sy / sn))) * 180 / Math.PI

    // Parent vertices are stored as DSFUN tile-local Mercator meters (high/low
    // pairs). Sub-tile clip must run in the same Mercator-meter space, so we
    // convert every bound to meters and work with reconstructed f64 values.
    const [parentMx, parentMy] = lonLatToMercF64(parent.tileWest, parent.tileSouth)
    const [subMxW, subMyS] = lonLatToMercF64(subWest, subSouth)
    const [subMxE, subMyN] = lonLatToMercF64(subEast, subNorth)
    const clipW = subMxW - parentMx
    const clipE = subMxE - parentMx
    const clipS = subMyS - parentMy
    const clipN = subMyN - parentMy

    // Clip polygons — vertex data is re-packed from parent-local DSFUN to
    // sub-tile-local DSFUN so that boundary detection and DSFUN camera
    // uniforms work correctly with the sub-tile's own tileWest/tileSouth.
    const verts = parent.vertices
    const outV: number[] = []
    const outI: number[] = []
    // Position-dedup index for outV. Quantize to ~1 cm to tolerate clipper
    // noise — with DSFUN vertices we can afford much tighter quantization
    // than the old 10 cm tile-local-degree key.
    const outVKey = new Map<string, number>()
    const splitLocal = (v: number): [number, number] => {
      const h = Math.fround(v)
      return [h, Math.fround(v - h)]
    }
    // Re-origin offset: subtract from parent-local to get sub-tile-local.
    // clipW = subMxW - parentMx, clipS = subMyS - parentMy.
    const reoriginX = clipW
    const reoriginY = clipS
    // outV layout: DSFUN stride-5 [mx_h, my_h, mx_l, my_l, feat_id] per vertex.
    const pushDedupPV = (x: number, y: number, fid: number): number => {
      const k = `${Math.round(x * 100)},${Math.round(y * 100)},${fid}`
      const hit = outVKey.get(k)
      if (hit !== undefined) return hit
      const idx = outV.length / 5
      const [xH, xL] = splitLocal(x - reoriginX)
      const [yH, yL] = splitLocal(y - reoriginY)
      outV.push(xH, yH, xL, yL, fid)
      outVKey.set(k, idx)
      return idx
    }

    // Reconstruct parent vertex to f64-equivalent tile-local meters
    const readPV = (vi: number): [number, number, number] => {
      const off = vi * 5
      const x = verts[off] + verts[off + 2]
      const y = verts[off + 1] + verts[off + 3]
      const fid = verts[off + 4]
      return [x, y, fid]
    }

    for (let t = 0; t < parent.indices.length; t += 3) {
      const i0 = parent.indices[t], i1 = parent.indices[t + 1], i2 = parent.indices[t + 2]
      const [x0, y0, fid] = readPV(i0)
      const [x1, y1] = readPV(i1)
      const [x2, y2] = readPV(i2)

      const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2)
      const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2)
      if (maxX < clipW || minX > clipE || maxY < clipS || minY > clipN) continue

      if (minX >= clipW && maxX <= clipE && minY >= clipS && maxY <= clipN) {
        outI.push(pushDedupPV(x0, y0, fid), pushDedupPV(x1, y1, fid), pushDedupPV(x2, y2, fid))
        continue
      }

      const clipped = clipPolygonToRect([[[x0, y0], [x1, y1], [x2, y2]]], clipW, clipS, clipE, clipN)
      if (clipped.length === 0 || clipped[0].length < 3) continue
      const ring = clipped[0]
      const ringIdx: number[] = []
      for (const [x, y] of ring) ringIdx.push(pushDedupPV(x, y, fid))
      for (let j = 1; j < ring.length - 1; j++) outI.push(ringIdx[0], ringIdx[j], ringIdx[j + 1])
    }

    // Clip lines (Liang-Barsky). Same DSFUN reconstruction + dedup.
    const lineVerts = parent.lineVertices
    const lineIdx = parent.lineIndices
    // outLV layout: DSFUN stride-10 [mx_h, my_h, mx_l, my_l, feat_id, arc_start, tin_x, tin_y, tout_x, tout_y]
    const outLV: number[] = []
    const outLI: number[] = []
    const outLVKey = new Map<string, number>()
    const pushDedupLV = (x: number, y: number, fid: number, arc: number, tinX: number, tinY: number, toutX: number, toutY: number): number => {
      const k = `${Math.round(x * 100)},${Math.round(y * 100)},${fid}`
      const hit = outLVKey.get(k)
      if (hit !== undefined) return hit
      const idx = outLV.length / DSFUN_LINE_STRIDE
      const [xH, xL] = splitLocal(x - reoriginX)
      const [yH, yL] = splitLocal(y - reoriginY)
      outLV.push(xH, yH, xL, yL, fid, arc, tinX, tinY, toutX, toutY)
      outLVKey.set(k, idx)
      return idx
    }
    const readLV = (vi: number): [number, number, number, number, number, number, number, number] => {
      const off = vi * DSFUN_LINE_STRIDE
      const x = lineVerts[off] + lineVerts[off + 2]
      const y = lineVerts[off + 1] + lineVerts[off + 3]
      const fid = lineVerts[off + 4]
      const arc = lineVerts[off + 5]
      const tinX = lineVerts[off + 6] ?? 0, tinY = lineVerts[off + 7] ?? 0
      const toutX = lineVerts[off + 8] ?? 0, toutY = lineVerts[off + 9] ?? 0
      return [x, y, fid, arc, tinX, tinY, toutX, toutY]
    }

    for (let s = 0; s < lineIdx.length; s += 2) {
      const a = lineIdx[s], b = lineIdx[s + 1]
      const [ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY] = readLV(a)
      const [bx, by, , barc, btinX, btinY, btoutX, btoutY] = readLV(b)

      if (Math.max(ax, bx) < clipW || Math.min(ax, bx) > clipE ||
          Math.max(ay, by) < clipS || Math.min(ay, by) > clipN) continue

      if (ax >= clipW && ax <= clipE && ay >= clipS && ay <= clipN &&
          bx >= clipW && bx <= clipE && by >= clipS && by <= clipN) {
        const ia = pushDedupLV(ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY)
        const ib = pushDedupLV(bx, by, afid, barc, btinX, btinY, btoutX, btoutY)
        if (ia !== ib) outLI.push(ia, ib)
        continue
      }

      const dx = bx - ax, dy = by - ay
      let tMin = 0, tMax = 1
      let valid = true
      const clipEdge = (p: number, q: number): void => {
        if (!valid) return
        if (Math.abs(p) < 1e-15) { if (q < 0) valid = false; return }
        const r = q / p
        if (p < 0) { if (r > tMax) valid = false; else if (r > tMin) tMin = r }
        else       { if (r < tMin) valid = false; else if (r < tMax) tMax = r }
      }
      clipEdge(-dx, ax - clipW)
      clipEdge(dx, clipE - ax)
      clipEdge(-dy, ay - clipS)
      clipEdge(dy, clipN - ay)
      if (!valid || tMax - tMin < 1e-10) continue

      const darc = barc - aarc
      // Mid-segment clip points: zero tangent → runtime boundary fallback.
      // Original vertices (tMin≈0 / tMax≈1): preserve tangent for cross-tile joins.
      const p0tinX = tMin < 1e-10 ? atinX : 0, p0tinY = tMin < 1e-10 ? atinY : 0
      const p0toutX = tMin < 1e-10 ? atoutX : 0, p0toutY = tMin < 1e-10 ? atoutY : 0
      const p1tinX = tMax > 1 - 1e-10 ? btinX : 0, p1tinY = tMax > 1 - 1e-10 ? btinY : 0
      const p1toutX = tMax > 1 - 1e-10 ? btoutX : 0, p1toutY = tMax > 1 - 1e-10 ? btoutY : 0
      const ia = pushDedupLV(ax + tMin * dx, ay + tMin * dy, afid, aarc + tMin * darc, p0tinX, p0tinY, p0toutX, p0toutY)
      const ib = pushDedupLV(ax + tMax * dx, ay + tMax * dy, afid, aarc + tMax * darc, p1tinX, p1tinY, p1toutX, p1toutY)
      if (ia !== ib) outLI.push(ia, ib)
    }

    // Polygon outlines: route through the SAME augment + clip + tessellate
    // pipeline used by line features so dash phase + pattern arc stay
    // continuous across the sub-tile boundary. The previous per-segment
    // Liang-Barsky on parent.outlineIndices reset arc_start at every
    // sub-tile clip, which surfaced as the dash bug at high zooms.
    //
    // We need the original ring data (parent.polygons) for arc continuity
    // — the parent's outlineIndices are stride-5 (no arc, no tangents)
    // and walking them per-tile gives the buggy reset behaviour. When
    // parent.polygons is absent (e.g., a sub-tile of a sub-tile that
    // dropped polygons during its own re-pack), we fall back to the old
    // legacy outlineIndices clip — the dash bug recurs there but no
    // visible regression vs. previous behaviour.
    const olvScratch: number[] = []
    const oliScratch: number[] = []
    if (parent.polygons && parent.polygons.length > 0) {
      // Sub-tile bounds in absolute Mercator meters for clipLineToRect
      // (which works in absolute, NOT tile-local, coords).
      for (const poly of parent.polygons) {
        for (const ring of poly.rings) {
          if (ring.length < 3) continue
          const arcRing = augmentRingWithArc(ring)
          if (arcRing.length < 2) continue
          const segments = clipLineToRect(arcRing, subMxW, subMyS, subMxE, subMyN)
          for (const seg of segments) {
            if (seg.length >= 2) {
              tessellateLineToArrays(seg, poly.featId, olvScratch, oliScratch)
            }
          }
        }
      }
    }
    // Pack the scratch into sub-tile-local DSFUN stride-10. When
    // parent.polygons is missing, olvScratch is empty and we ship empty
    // outline buffers — VTR falls back to the legacy outlineIndices path
    // (which we leave empty too in that case so no double-render).
    const outlineVertices = olvScratch.length > 0
      ? packDSFUNLineVertices(olvScratch, subMxW, subMyS)
      : new Float32Array(0)
    const outlineLineIndices = new Uint32Array(oliScratch)

    // Clip parent point features into the sub-tile box. Parent point
    // vertices are stride-5 DSFUN [mx_h, my_h, mx_l, my_l, fid] in
    // PARENT-local Mercator meters; reconstruct, test against
    // (clipW, clipS, clipE, clipN), and re-pack into SUB-tile-local
    // DSFUN. Without this, point layers (place labels, POIs) vanish
    // at over-zoom because they have no representation in sub-tile.
    let subPointVertices: Float32Array | undefined
    if (parent.pointVertices && parent.pointVertices.length >= 5) {
      const pv = parent.pointVertices
      const out: number[] = []
      for (let i = 0; i < pv.length; i += 5) {
        const px = pv[i] + pv[i + 2]
        const py = pv[i + 1] + pv[i + 3]
        if (px < clipW || px > clipE || py < clipS || py > clipN) continue
        const lx = px - reoriginX
        const ly = py - reoriginY
        const xH = Math.fround(lx); const xL = Math.fround(lx - xH)
        const yH = Math.fround(ly); const yL = Math.fround(ly - yH)
        out.push(xH, yH, xL, yL, pv[i + 4])
      }
      if (out.length >= 5) subPointVertices = new Float32Array(out)
    }

    // Cache sub-tile with its OWN bounds. Vertex data has been re-packed
    // from parent-local to sub-tile-local DSFUN coordinates so the DSFUN
    // camera uniform (VTR) and boundary detection (buildLineSegments) both
    // use the sub-tile's origin — seamless joins across tile edges.
    const subData: TileData = {
      vertices: new Float32Array(outV),
      indices: new Uint32Array(outI),
      lineVertices: new Float32Array(outLV),
      lineIndices: new Uint32Array(outLI),
      outlineIndices: new Uint32Array(0),
      outlineVertices: outlineVertices.length > 0 ? outlineVertices : undefined,
      outlineLineIndices: outlineLineIndices.length > 0 ? outlineLineIndices : undefined,
      pointVertices: subPointVertices,
      tileWest: subWest,
      tileSouth: subSouth,
      tileWidth: subEast - subWest,
      tileHeight: subNorth - subSouth,
      tileZoom: sz,
      // Forward parent's ring data so further over-zoom of THIS sub-tile
      // can also use the global-arc outline path (otherwise grand-child
      // sub-tiles fall back to the legacy outlineIndices and the dash
      // bug recurs at very high zoom levels).
      polygons: parent.polygons,
    }

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

  evictTiles(protectedKeys: Set<number>): void {
    // Two caps: byte-based (tight, accurate) and count-based
    // (loose safety net). Either tripping is enough to trigger
    // eviction; the loop runs until BOTH are under their limits.
    const _byteCap = maxCachedBytes()
    if (this.dataCache.size <= MAX_CACHED_TILES
        && this._cachedBytes <= _byteCap) return

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
    const entries = [...this.dataCache.entries()]
      .filter(([key]) => !protectedKeys.has(key) && !this._evictShield.has(key))

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

