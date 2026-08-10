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
  tileKey,
  tileKeyUnpack,
  type XGVTIndex,
  type TileIndexEntry,
  type PropertyTable,
  type RingPolygon,
  type CompiledTileSet,
  type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { xlog } from '@xgis/shared'
import { visibleTiles } from './tile-select-helpers'
import { VirtualCatalogAdapter } from './sources/virtual-catalog-adapter'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
import { SubTileGenerator } from './sub-tile-generator'
import {
  type TileSource,
  type TileSourceSink,
  type BackendTileResult,
  type TileScheme,
} from './tile-source'
// Step 0 of the layer-type refactor: shared types live in tile-types.ts so
// per-format backend modules can import them without pulling in catalog
// runtime state. Re-exported below for back-compat with external callers
// (loadPMTilesSource etc. import these from xgvt-source.ts today).
import {
  type TileData,
  type TileState,
  type CacheTileDataDescriptor,
  DSFUN_POLY_STRIDE,
  DSFUN_LINE_STRIDE,
  maxConcurrentLoads,
  defaultSkeletonDepth,
  defaultSkeletonByteBudget,
  type VirtualCatalog,
} from './tile-types'
import { runSkeletonPrewarm, type SkeletonPrewarmHandle } from './tile-skeleton-prewarm'
import { unionBounds } from './tile-catalog-helpers'
import { buildFullCoverQuad } from './tile-full-cover-quad'
import { TileDataCache } from './tile-data-cache'
import { CompileBudget } from './tile-compile-budget'
import { TileEvictionPolicy } from './tile-eviction-policy'
import { checkBackendLayoutVersion } from './tile-catalog-layout-check'

/** Shared empty result for `consumeReplacedKeys` — the common (nothing replaced) case must not
 *  allocate, it is drained once per frame per renderer. */
const EMPTY_KEYS: number[] = []

// ═══ Catalog ═══

export class TileCatalog {
  private index: XGVTIndex | null = null
  /** #1581 — entries only ever grow; lets a memo invalidate a landed tile. */
  indexGeneration = (): number => this.index?.entryByHash.size ?? 0
  /** #1616 — bumps on every slice WRITE (`setSlice`, the one chokepoint they all pass)
   *  and on the refresh-drop, which changes content with no write to see it. NOT on
   *  eviction: `TileEvictionPolicy` calls `cache.deleteCacheEntry` directly, bypassing
   *  this class — safe for the point path only because eviction skips `protectedKeys`
   *  ⊇ the selected set, so a key a pack depends on is not evicted under it.
   *  `indexGeneration` only grows with new index entries,
   *  so neither a tile ARRIVING for an already-selected key nor a re-tile of one moves
   *  it; the selected key set does not move either. A memo that also stops re-reading
   *  tile data on a hit (#1581 leg B) is blind to both without this. Counts writes, not
   *  tiles — rely only on "differs from last frame". */
  private _contentGeneration = 0
  contentGeneration = (): number => this._contentGeneration
  /** In-memory compiled-tile store + byte accounting. Extracted to
   *  TileDataCache (redesign §3.5): owns the per-(tile key, source-
   *  layer) TileData map, the cumulative byte total, and the
   *  setSlice / deleteCacheEntry bookkeeping that keeps the two in
   *  sync. The catalog owns only the eviction POLICY; the cache owns
   *  the accounting MECHANISM. */
  private cache = new TileDataCache()
  private _destroyed = false // #1570 — latched by destroy(); guards acceptResult
  private loadingTiles = new Set<number>()
  /** #1371 — keys whose cached slice was OVERWRITTEN (not first-written) since the last
   *  `consumeReplacedKeys()`. A host data push re-tiles the same keys against a new backend;
   *  the renderer drains this set to re-upload exactly those tiles, so the previously uploaded
   *  ones keep drawing until their replacement is GPU-resident instead of the layer going
   *  blank for the whole round-trip. */
  private _replacedKeys = new Set<number>()
  /** #1371 — keys a `refreshTiles` call is currently re-producing. The first result to arrive
   *  for one of these drops the key's PREVIOUS slices before writing: the new backend may emit
   *  a different slice set (a moving feature that left this tile emits none at all, under a
   *  different slot than the stale data sits in), and a stale slice nobody overwrites keeps
   *  drawing the feature at its old position. */
  private _pendingRefresh = new Set<number>()
  /** #1402 — re-seed keys not yet ISSUED, because `requestTiles` breaks at the concurrency cap.
   *  Drained until empty; without it every tile past the cap kept the previous backend's data. */
  private _refreshQueue = new Set<number>()

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

  /** #1155 F3 — cold-start burst flag. While on, resetCompileBudget ticks
   *  backends with _BURST_TICK_BUDGET (16) instead of _TICK_BUDGET (2) so the
   *  first-viewport cascade dispatches to the worker pool in a couple of frames
   *  rather than being paced out. Flipped by XGISMap on burst enter/exit; off by
   *  default so steady-state pacing is unchanged. */
  private _coldStartBurst = false

  /** Pending timer handle for the prewarmSkeleton retry pump + a
   *  hard-stop latch. The pump lives in tile-skeleton-prewarm.ts
   *  (level-staged + byte-budgeted + backoff, #1045); this handle lets
   *  destroy() cancel it so a 'failed' skeleton tile can no longer keep
   *  a retry loop — and the catalog it captures — alive forever. */
  private _skeletonPrewarm: SkeletonPrewarmHandle | null = null

  /** Owner-registered teardown callbacks — see {@link onDestroy}. */
  private readonly _onDestroy: Array<() => void> = []

  /** Internal: set a slice via the TileDataCache (byte accounting +
   *  nested-map insert). Thin delegate — kept as a method so the
   *  test escape-hatch (`(catalog as …).setSlice.bind(catalog)` in
   *  tile-catalog-skeleton / -lifecycle / multi-layer-overzoom tests)
   *  keeps reaching the same injection path. */
  private setSlice(key: number, layer: string, data: TileData): void {
    this._contentGeneration++ // #1616 — the ONE chokepoint every slice write passes
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
      const fn = (
        b as TileSource & {
          getLayerZoomRange?: (s: string) => { minzoom: number; maxzoom: number } | null
        }
      ).getLayerZoomRange
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
      trackLoading: (key) => {
        this.loadingTiles.add(key)
      },
      releaseLoading: (key) => {
        this.loadingTiles.delete(key)
        this.drainRefreshQueue() // #1402 — a freed slot is when more of a re-seed can be issued
      },
      getLoadingCount: () => this.loadingTiles.size,
      acceptResult: (key, result, sourceLayer) =>
        this.acceptResult(key, result, sourceLayer, backend),
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
   *  visible frame re-decodes through the new layout. The comparison itself
   *  is `layoutVersionMismatch`; the warn fires once per (catalog, backend)
   *  pair via `_layoutMismatchWarned`. */
  private checkLayoutVersion(backend: TileSource): void {
    checkBackendLayoutVersion(backend, this._layoutMismatchWarned, () =>
      this.evictTilesForBackend(backend),
    )
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
          indexOffset: 0,
          indexLength: 0,
          propTableOffset: 0,
          propTableLength: 0,
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
  private acceptResult(
    key: number,
    result: BackendTileResult | null,
    sourceLayer = '',
    backend?: TileSource,
  ): void {
    if (this._destroyed) return // #1570 — nowhere to go; every write below is dead weight
    // #1371 — first result of a refresh: clear what the PREVIOUS backend left for this key, so
    // slices the new production does not emit cannot survive. Marked replaced either way, so
    // the renderer swaps (or drops) the tile it is currently drawing.
    if (this._pendingRefresh.delete(key) && this.cache.has(key)) {
      this._replacedKeys.add(key)
      this._contentGeneration++ // #1616 — a DROP changes content with no setSlice to see it
      this.deleteCacheEntry(key)
    }
    if (!result) {
      const empty = new Float32Array(0)
      const emptyI = new Uint32Array(0)
      this.cacheTileData({
        key,
        vertices: empty,
        indices: emptyI,
        lineVertices: empty,
        lineIndices: emptyI,
        sourceLayer,
        originBackend: backend,
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
        tileHash: key,
        dataOffset: 0,
        compactSize: 0,
        gpuReadySize: 0,
        vertexCount: result.vertices.length / DSFUN_POLY_STRIDE,
        indexCount: result.indices.length,
        lineVertexCount: result.lineVertices.length / DSFUN_LINE_STRIDE,
        lineIndexCount: result.lineIndices.length,
        flags: tileFullCover ? TILE_FLAG_FULL_COVER | (tileFullCoverFid << 1) : 0,
        fullCoverFeatureId: tileFullCoverFid,
      }
      this.index.entries.push(entry)
      this.index.entryByHash.set(key, entry)
    }
    if (tileFullCover && result.vertices.length === 0) {
      const entry = this.index?.entryByHash.get(key)
      if (entry) {
        this.createFullCoverTileData(
          key,
          entry,
          result.lineVertices,
          result.lineIndices,
          sourceLayer,
          backend,
        )
        return
      }
    }
    this.cacheTileData({
      key,
      polygons: result.polygons,
      vertices: result.vertices,
      indices: result.indices,
      lineVertices: result.lineVertices,
      lineIndices: result.lineIndices,
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
    // #1155 F3 — cold-start burst raises the per-frame dispatch budget to 16
    // (from 2) so the first-viewport cascade isn't paced out; steady state
    // (flag off) passes _TICK_BUDGET exactly as before.
    const tickBudget = this._coldStartBurst
      ? TileCatalog._BURST_TICK_BUDGET
      : TileCatalog._TICK_BUDGET
    for (const b of this.backends) {
      b.tick?.(tickBudget)
    }
  }

  /** #1155 F3 — flip the cold-start burst tick budget. Called by XGISMap on
   *  burst enter/exit (and at source registration while burst is on). */
  setColdStartBurst(on: boolean): void {
    this._coldStartBurst = on
  }
  // 2 paces compileSingleTile (5-50 ms each on dense MVT tiles) at
  // most ~100 ms/frame so VTR's MAX_UPLOADS_PER_FRAME (also 2) can
  // drain them without the queue growing. The pair (compile budget +
  // upload budget) bounds total per-frame work at ~300 ms worst case,
  // matching the visible-tile pipeline as a single producer→consumer
  // chain. Real fix for sub-frame work is a compile worker pool.
  private static readonly _TICK_BUDGET = 2
  // #1155 F3 — cold-start burst dispatch budget. 8x the steady 2. tick() on the
  // worker path (pmtiles-backend.ts) only postMessages the dispatch (cheap), so
  // 16 fresh dispatches/frame is safe; the downstream drain + upload caps
  // (raised in lockstep for burst) bound the actual per-frame work.
  private static readonly _BURST_TICK_BUDGET = 16

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

  /** #1448 — true when a re-seed replacement is waiting for a frame to swap it in.
   *
   *  The idle-skip gate used to ask only "is a tile still FETCHING?". The swap happens in the
   *  renderer's `applyReplacedTiles`, which runs at the START of a frame, so a replacement that
   *  arrives after the last frame needs ONE more — and the fetch count reached 0 on that very
   *  arrival, so nothing asked for it. Measured: one push left 1-2 of 7 tiles drawing the
   *  PREVIOUS seed, flat for 60 s, and one `invalidate()` fixed it.
   *
   *  A PEEK, deliberately: `consumeReplacedKeys` drains, and a predicate that consumed its own
   *  evidence would swallow the swap it exists to schedule. */
  hasReplacedKeys(): boolean {
    return this._replacedKeys.size > 0
  }

  getCacheSize(): number {
    return this.cache.size
  }

  /** Diagnostic accessors — let inspectPipeline() + CPU debug tests
   *  read the budget/queue state without reaching into private fields.
   *  Not part of the public API.  */
  getSubTileBudgetUsed(): number {
    return this.budget.subTileCountThisFrame
  }
  getCompileBudgetUsed(): number {
    return this.budget.compileCountThisFrame
  }
  getPendingLoadCount(): number {
    return this.loadingTiles.size
  }

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
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy hook's own signature
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
          flags: isFullCover ? TILE_FLAG_FULL_COVER | (fid << 1) : 0,
          fullCoverFeatureId: fid,
        }
        entries.push(entry)
        entryByHash.set(key, entry)

        // Full-cover tiles: generate quad (same as createFullCoverTileData)
        if (isFullCover && tile.vertices.length === 0) {
          this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        } else {
          const polygons: RingPolygon[] | undefined = tile.polygons?.map((p) => ({
            rings: p.rings,
            featId: p.featId,
          }))
          this.cacheTileData({
            key,
            polygons,
            vertices: tile.vertices,
            indices: tile.indices,
            lineVertices: tile.lineVertices,
            lineIndices: tile.lineIndices,
            pointVertices: tile.pointVertices,
            outlineIndices: tile.outlineIndices, // eslint-disable-line @typescript-eslint/no-deprecated -- ABI passthrough (see SerializedTile)
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

    console.log(
      `[X-GIS] In-memory tiles loaded: ${tileCount} tiles from ${tileSet.featureCount} features`,
    )
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
  addTileLevel(
    level: TileLevel,
    bounds: [number, number, number, number],
    propertyTable: PropertyTable,
  ): void {
    if (!this.index) {
      this.index = {
        header: {
          levelCount: 1,
          maxLevel: level.zoom,
          bounds,
          indexOffset: 0,
          indexLength: 0,
          propTableOffset: 0,
          propTableLength: 0,
        },
        entries: [],
        entryByHash: new Map(),
        propertyTable,
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
        tileHash: key,
        dataOffset: 0,
        compactSize: 0,
        gpuReadySize: 0,
        vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE,
        indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE,
        lineIndexCount: tile.lineIndices.length,
        flags: isFullCover ? TILE_FLAG_FULL_COVER | (fid << 1) : 0,
        fullCoverFeatureId: fid,
      }
      idx.entries.push(entry)
      idx.entryByHash.set(key, entry)

      if (isFullCover && tile.vertices.length === 0) {
        this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
      } else {
        const polygons: RingPolygon[] | undefined = tile.polygons?.map((p) => ({
          rings: p.rings,
          featId: p.featId,
        }))
        this.cacheTileData({
          key,
          polygons,
          vertices: tile.vertices,
          indices: tile.indices,
          lineVertices: tile.lineVertices,
          lineIndices: tile.lineIndices,
          pointVertices: tile.pointVertices,
          outlineIndices: tile.outlineIndices, // eslint-disable-line @typescript-eslint/no-deprecated -- ABI passthrough (see SerializedTile)
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
   *  Cost bound (#1045): the pump (tile-skeleton-prewarm.ts) is level-
   *  staged and BYTE-BUDGETED — depth alone cannot bound cost on real
   *  planet tilesets (the old full enumeration fetched 85 tiles / 33 MB
   *  for one z4 view). Floor always completes; deeper stops at budget. */
  prewarmSkeleton(
    opts: {
      depth?: number
      minzoom?: number
      maxzoom?: number
      /** Arrived-bytes ceiling past the floor levels.
       *  Default: `defaultSkeletonByteBudget()`. */
      byteBudget?: number
    } = {},
  ): void {
    const depth = opts.depth ?? defaultSkeletonDepth()
    const sourceMinzoom = opts.minzoom ?? 0
    const sourceMaxzoom = opts.maxzoom ?? this.index?.header.maxLevel ?? 0
    if (depth < 0) return
    const cap = Math.min(depth, sourceMaxzoom)
    const start = Math.max(0, sourceMinzoom)
    if (cap < start) return
    this._skeletonPrewarm?.stop()
    this._skeletonPrewarm = runSkeletonPrewarm(
      {
        hasTileData: (k) => this.hasTileData(k),
        prefetchTiles: (ks) => this.prefetchTiles(ks),
        markSkeleton: (ks) => this.markSkeleton(ks),
        unmarkSkeleton: (ks) => this.eviction.unmarkSkeleton(ks),
        bytesFor: (k) => {
          const slot = this.cache.getSlot(k)
          if (!slot) return 0
          let n = 0
          for (const td of slot.values()) n += TileDataCache.sizeOfTileData(td)
          return n
        },
      },
      {
        start,
        cap,
        keyOf: tileKey,
        floorMaxTiles: 8,
        byteBudget: opts.byteBudget ?? defaultSkeletonByteBudget(),
      },
    )
  }

  /** Stop the prewarmSkeleton retry pump and release what pins this
   *  catalog past its source's lifetime. Called from map.ts
   *  teardownSource (reached by both destroy() and _teardownForReinit)
   *  so a 'failed' skeleton tile can no longer keep the pump — and the
   *  catalog + dataCache it captures — alive forever. */
  destroy(): void {
    this._skeletonPrewarm?.stop()
    this._skeletonPrewarm = null
    // Detach BEFORE the owner callbacks: they evict the data a backend's in-flight work still
    // reads, so one told afterwards cannot tell teardown from breakage (virtual-pmtiles-teardown).
    for (const b of [...this.backends]) this.detachBackend(b)
    // Owner-registered teardown, drained so a repeated destroy() is a no-op.
    for (const fn of this._onDestroy.splice(0)) fn()
    this._destroyed = true // #1570 — late worker results must not re-enter a dead renderer
    this.onTileLoaded = null
  }

  /** Register a teardown callback keyed to this catalog's lifetime. The
   *  catalog's OWNER uses it to release process-global state it allocated
   *  on the catalog's behalf but that the catalog knows nothing about —
   *  today SourceManager's per-map GeoJSON tiling-worker index (#1353),
   *  which outlives the map otherwise. Callbacks run once, in registration
   *  order, at the end of {@link destroy}. */
  onDestroy(fn: () => void): void {
    this._onDestroy.push(fn)
  }

  /** Update the fetch-queue priority comparator on every backend that
   *  has a priority queue (PMTiles). Comparator returns positive when
   *  `a` should run before `b` — i.e. closer to camera is "higher
   *  priority", sorts last, and pops first. VTR calls this once per
   *  frame before `requestTiles` so the queue's next sort uses the
   *  current camera centre. */
  setFetchPriority(distanceFromCamera: (key: number) => number): void {
    for (const b of this.backends) {
      b.setFetchPriorityCallback?.((a, c) => distanceFromCamera(c) - distanceFromCamera(a))
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

  /** #1371 — drain the keys whose cached data was replaced since the last call. The renderer
   *  calls this once per frame; each returned key still HAS data (the new one) and still has
   *  its previous GPU upload, so the consumer swaps rather than evicts. */
  consumeReplacedKeys(): number[] {
    if (this._replacedKeys.size === 0) return EMPTY_KEYS
    const out = [...this._replacedKeys]
    this._replacedKeys.clear()
    return out
  }

  /** #1402 — put a key BACK in the replaced set. `consumeReplacedKeys` drains, so a consumer
   *  whose swap did not land (an upload that bailed on arena OOM) has no other way to be asked
   *  again, and the tile would keep drawing the previous backend's data forever. */
  markReplaced(key: number): void {
    if (this.cache.has(key)) this._replacedKeys.add(key)
  }

  /** #1371 — re-request `keys` even when they are already cached, so a source whose BACKEND
   *  was swapped (a host data push) re-tiles the keys it is currently showing. `requestTiles`
   *  deliberately skips a cached key; this is the one caller that must not.
   *
   *  #1402 — QUEUED, not issued once: `requestTiles` stops at the concurrency cap, so a one-shot
   *  refresh of a 19-tile viewport re-tiled the first 8 and left the rest drawing the previous
   *  backend's data forever (nothing else ever re-requests a cached key). */
  refreshTiles(keys: number[]): void {
    for (const k of keys) this._refreshQueue.add(k)
    this.requestTiles(keys, true)
  }

  /** #1402 — issue as much of the pending re-seed as the cap allows, on load COMPLETION rather
   *  than on the next frame: at 1-2 s/frame a frame-driven drain covered a different number of
   *  tiles every run, and covered none at all once the map went idle. The re-entrancy guard is
   *  for a synchronous backend, whose `loadTile` releases inside this very call. */
  private _draining = false
  private drainRefreshQueue(): void {
    if (this._draining || this._refreshQueue.size === 0) return
    this._draining = true
    try {
      this.requestTiles(EMPTY_KEYS)
    } finally {
      this._draining = false
    }
  }

  requestTiles(keys: number[], refreshCached = false): void {
    if (!this.index || this.backends.length === 0) return

    // Per-backend batches for backends that support batched fetch
    // (XGVT-binary's range-merge). Single keys go through loadTile.
    const batches = new Map<TileSource, number[]>()

    const _maxConcurrent = maxConcurrentLoads()
    // #1402 — pending re-seed keys go FIRST (they are on screen NOW showing the previous
    // backend's data), de-duped against `keys` because a key issued earlier in this same loop no
    // longer looks in-flight to a synchronous backend and would load twice.
    const pending =
      this._refreshQueue.size > 0 ? [...new Set([...this._refreshQueue, ...keys])] : keys
    for (const key of pending) {
      // A queued key carries its own refresh intent, so a plain selection call re-tiles it too.
      // `_pendingRefresh` is armed HERE, not in `refreshTiles`: a key still loading then is
      // cached by the time its retry issues, and arming early would miss exactly those.
      const refresh = refreshCached || this._refreshQueue.has(key)
      if ((this.cache.has(key) && !refresh) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= _maxConcurrent) break
      if (refresh) {
        if (this.cache.has(key)) this._pendingRefresh.add(key)
        this._refreshQueue.delete(key)
      }

      // Preregistered entries (XGVT-binary) route through entryToBackend.
      const owner = this.entryToBackend.get(key)
      if (owner) {
        const entry = this.index.entryByHash.get(key)!
        // Full-cover tiles with no data: synthesise quad immediately
        // from the cached entry — no fetch needed.
        if (entry.flags & TILE_FLAG_FULL_COVER && entry.compactSize === 0) {
          this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
          continue
        }
        if (owner.loadTilesBatch) {
          let batch = batches.get(owner)
          if (!batch) {
            batch = []
            batches.set(owner, batch)
          }
          batch.push(key)
        } else {
          owner.loadTile(key, refresh)
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
          backend.loadTile(key, refresh)
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
    key: number,
    entry: TileIndexEntry,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
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
    const quad = buildFullCoverQuad(key, entry.fullCoverFeatureId)
    this.cacheTileData({
      key,
      vertices: quad.vertices,
      indices: quad.indices,
      lineVertices,
      lineIndices,
      sourceLayer,
      originBackend,
      dequant: quad.dequant,
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
    const tileWest = (tx / tn) * 360 - 180
    const tileEast = ((tx + 1) / tn) * 360 - 180
    const tileNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / tn))) * 180) / Math.PI
    const tileSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / tn))) * 180) / Math.PI

    const data: TileData = {
      vertices: d.vertices,
      dequantScale: dequant.scale,
      dequantHalf: dequant.half,
      indices: d.indices,
      lineVertices: d.lineVertices,
      lineIndices: d.lineIndices,
      outlineIndices: d.outlineIndices ?? new Uint32Array(0),
      outlineVertices:
        d.outlineVertices && d.outlineVertices.length > 0 ? d.outlineVertices : undefined,
      outlineLineIndices:
        d.outlineLineIndices && d.outlineLineIndices.length > 0 ? d.outlineLineIndices : undefined,
      pointVertices: d.pointVertices,
      prebuiltLineSegments:
        d.prebuiltLineSegments && d.prebuiltLineSegments.length > 0
          ? d.prebuiltLineSegments
          : undefined,
      prebuiltOutlineSegments:
        d.prebuiltOutlineSegments && d.prebuiltOutlineSegments.length > 0
          ? d.prebuiltOutlineSegments
          : undefined,
      tileWest,
      tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
      tileZoom: tz,
      polygons: d.polygons,
      heights: d.heights,
      bases: d.bases,
      featureProps: d.featureProps,
      originBackend: d.originBackend,
    }

    // #1371 — record an OVERWRITE (a re-tile of a key we already served) before the write, so
    // the renderer can swap that tile's GPU buffers instead of being blanked. A first write is
    // not a replacement: nothing was drawing this key yet.
    if (this.hasTileData(key, sourceLayer)) {
      this._replacedKeys.add(key)
    }
    this.setSlice(key, sourceLayer, data)
    try {
      this.onTileLoaded?.(key, data, sourceLayer)
    } catch (e) {
      xlog.error('[onTileLoaded]', (e as Error)?.stack ?? e)
    }
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
    try {
      this.onTileLoaded?.(subKey, subData, sourceLayer)
    } catch (e) {
      xlog.error('[onTileLoaded sub]', (e as Error)?.stack ?? e)
    }
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
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    let matched = 0
    for (const t of visTiles) {
      if (t.z !== zoom) continue
      matched++
      if (t.x < minX) minX = t.x
      if (t.x > maxX) maxX = t.x
      if (t.y < minY) minY = t.y
      if (t.y > maxY) maxY = t.y
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
      const x = ((rawX % n) + n) % n // wrap X for world wrapping
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
    centerLon: number,
    centerLat: number,
    currentZ: number,
    canvasWidth: number,
    canvasHeight: number,
    cameraZoom: number,
  ): void {
    const _capNext = maxConcurrentLoads()
    if (!this.index || this.loadingTiles.size >= _capNext) return

    const nextZ = currentZ + 1
    const maxSubZ = this.index.header.maxLevel + 6
    if (nextZ > maxSubZ) return

    const nextTiles = visibleTiles(
      centerLon,
      centerLat,
      nextZ,
      canvasWidth,
      canvasHeight,
      cameraZoom,
    )
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
