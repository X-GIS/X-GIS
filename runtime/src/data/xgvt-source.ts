// ═══ XGVTSource — .xgvt 파일 데이터 관리 (GeoJSON-VT 스타일) ═══
// 로딩, 캐싱, 서브타일 클리핑, 프리페치를 담당.
// GPU 독립: CPU 배열만 관리, GPU 업로드는 VectorTileRenderer가 담당.

import {
  TILE_FLAG_FULL_COVER,
  tileKey, tileKeyUnpack,
  clipPolygonToRect, clipLineToRect,
  compileSingleTile,
  lonLatToMercF64,
  augmentRingWithArc, tessellateLineToArrays, packDSFUNLineVertices,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { visibleTiles } from '../loader/tiles'
import { XGVTBinaryBackend, type BinaryBackendSink } from './sources/xgvt-binary-source'
import { PMTilesBackend, type PMTilesBackendSink } from './sources/pmtiles-backend'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
// Step 0 of the layer-type refactor: shared types live in tile-types.ts so
// per-format backend modules can import them without pulling in catalog
// runtime state. Re-exported below for back-compat with external callers
// (loadPMTilesSource etc. import these from xgvt-source.ts today).
import {
  type TileData,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  MAX_CACHED_TILES, MAX_CONCURRENT_LOADS,
  type VirtualCatalog, type VirtualTileFetcher,
} from './tile-types'

export {
  type TileData,
  DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE,
  type VirtualCatalog, type VirtualTileFetcher,
}

// ═══ Source ═══

export class XGVTSource {
  private index: XGVTIndex | null = null
  private dataCache = new Map<number, TileData>()
  private loadingTiles = new Set<number>()

  /** Backend that handles .xgvt binary file loading (range-batched
   *  fetch, worker-pool decompress, GPU-ready vs compact dispatch).
   *  Constructed lazily when loadFromBuffer / loadFromURL is called.
   *  Step 2 of the layer-type refactor extracted this to its own
   *  class for separation of concerns; subsequent steps will move
   *  PMTiles + GeoJSON-runtime out the same way and rename the
   *  remainder to TileCatalog. */
  private binaryBackend: XGVTBinaryBackend | null = null

  /** Backend that holds raw decomposed GeoJSON parts + the spatial
   *  grid for on-demand tile compilation. Lazy — constructed when
   *  setRawParts is called. */
  private geojsonBackend: GeoJSONRuntimeBackend | null = null

  /** Backend that serves PMTiles + similar virtual-catalog sources
   *  (lazy on-demand fetch). Constructed lazily from setVirtualCatalog
   *  so the legacy hook public API is preserved. */
  private pmtilesBackend: PMTilesBackend | null = null

  /** Called when a tile finishes loading (for GPU upload) */
  onTileLoaded: ((key: number, data: TileData) => void) | null = null

  // ── Data access ──

  hasData(): boolean {
    return this.index !== null && this.index.entries.length > 0
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

  /** Store raw geometry parts for on-demand compilation (GeoJSON sources).
   *  Delegates to the GeoJSONRuntimeBackend, which owns the spatial grid. */
  setRawParts(parts: GeometryPart[], maxZoom: number): void {
    if (!this.geojsonBackend) this.geojsonBackend = new GeoJSONRuntimeBackend()
    this.geojsonBackend.setParts(parts, maxZoom)
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
  private static readonly _BUDGET_MS = 6
  private static readonly _COMPILE_FLOOR = 4  // matches previous count cap
  private static readonly _SUBTILE_FLOOR = 8  // matches previous count cap
  private static readonly _MAX_PER_FRAME = 128

  /** Reset per-frame budget (call once per frame before tile requests) */
  resetCompileBudget(): void {
    this._budgetDeadlineMs = this._now() + XGVTSource._BUDGET_MS
    this._compileCountThisFrame = 0
    this._subTileCountThisFrame = 0
  }

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
    if (callsThisFrame >= XGVTSource._MAX_PER_FRAME) return true
    if (callsThisFrame < countFloor) return false // always allow under floor
    return this._now() > this._budgetDeadlineMs
  }

  compileTileOnDemand(key: number): boolean {
    if (!this.geojsonBackend || this.dataCache.has(key)) return false
    const [z, x, y] = tileKeyUnpack(key)
    if (z > this.geojsonBackend.maxZoom) return false

    // Empty-tile shortcut: if the spatial grid has no parts overlapping
    // this tile, cache a zero-geometry tile instead of returning false
    // every frame. Without this, every VTR.render loop finds the tile
    // absent, falls through to parent-fallback, and increments
    // missedTiles — producing sustained [FLICKER] warnings for regions
    // with no data (e.g., z=6 ocean tiles far from the fixture's line).
    // A cached empty tile lets the VTR's `hasGeom === false` branch
    // short-circuit the fallback accounting. Cost: a no-op GPU upload
    // per empty tile, bounded by the LRU cap.
    const parts = this.geojsonBackend.getRelevantParts(z, x, y)
    if (!parts || parts.length === 0) {
      const empty = new Float32Array(0)
      const emptyI = new Uint32Array(0)
      this.cacheTileData(key, undefined, empty, emptyI, empty, emptyI)
      return true
    }

    // Hybrid per-frame budget — see resetCompileBudget() comment.
    // Guarantees at least _COMPILE_FLOOR (4) heavy compiles per frame;
    // beyond that, defers to time budget (6 ms) for lighter compiles.
    if (this._budgetExceeded(this._compileCountThisFrame, XGVTSource._COMPILE_FLOOR)) return false

    const tile = compileSingleTile(parts, z, x, y, this.geojsonBackend.maxZoom)
    if (!tile) {
      // Same rationale as the empty-grid branch above — a tile that
      // overlapped the spatial grid but produced no triangles after
      // clipping (very thin line slicing a corner, for example) would
      // otherwise stay "missed" forever.
      const empty = new Float32Array(0)
      const emptyI = new Uint32Array(0)
      this.cacheTileData(key, undefined, empty, emptyI, empty, emptyI)
      return true
    }

    // Create synthetic index entry. Forward compileSingleTile's
    // `fullCover` + `fullCoverFeatureId` so sub-tiles beyond the
    // pre-compiled zoom use the same quad-rendering fast path as
    // batch-compiled full-cover tiles — otherwise match()-based color
    // lookups return nothing because the feature id is never attached
    // to the cover quad.
    const tileFullCover = tile.fullCover ?? false
    const tileFullCoverFid = tile.fullCoverFeatureId ?? 0
    if (this.index) {
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE, indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE, lineIndexCount: tile.lineIndices.length,
        flags: tileFullCover ? (TILE_FLAG_FULL_COVER | (tileFullCoverFid << 1)) : 0,
        fullCoverFeatureId: tileFullCoverFid,
      }
      if (!this.index.entryByHash.has(key)) {
        this.index.entries.push(entry)
        this.index.entryByHash.set(key, entry)
      }
    }

    // Full-cover sub-tiles need the quad synthesized from their entry
    // (fullCoverFeatureId → 4-vertex quad at tile bounds) — same path
    // batch-loaded full-cover tiles take at load time. Without this,
    // the empty vertex buffer that compileSingleTile emits after
    // detecting full-cover lands in dataCache with length 0 and the
    // renderer has nothing to draw. Surfaces in the Stress-many-layers
    // fixture: each per-layer filter produces a source whose polygon
    // fully covers many zoom-tiles; without the quad, layers go blank
    // past z=6.
    if (tileFullCover && tile.vertices.length === 0) {
      const entry = this.index?.entryByHash.get(key)
      if (entry) {
        this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        this._compileCountThisFrame++
        return true
      }
    }

    const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
    // Forward the GeoJSON tiler's pre-augmented outline buffers when
    // present so VTR can use the global-arc outline path. Binary .xgvt
    // tiles ship empty buffers (Float32Array(0) / Uint32Array(0)) and
    // fall back to the legacy outlineIndices path inside cacheTileData.
    this.cacheTileData(
      key, polygons,
      tile.vertices, tile.indices,
      tile.lineVertices, tile.lineIndices,
      tile.pointVertices,
      tile.outlineIndices,
      tile.outlineVertices,
      tile.outlineLineIndices,
    )
    this._compileCountThisFrame++
    return true
  }

  // ── Tile data cache ──

  getTileData(key: number): TileData | null {
    return this.dataCache.get(key) ?? null
  }

  hasTileData(key: number): boolean {
    return this.dataCache.has(key)
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
    // On-demand sources can compile any tile within maxZoom
    if (this.geojsonBackend) {
      const [z] = tileKeyUnpack(key)
      return this.geojsonBackend.has(z)
    }
    if (this.pmtilesBackend) {
      return this.pmtilesBackend.has(key)
    }
    return false
  }

  /** Attach an external on-demand tile producer (e.g., PMTiles archive).
   *  After this call:
   *    • hasEntryInIndex(key) returns true for any (z, x, y) inside
   *      the catalog window — the renderer will request those tiles.
   *    • requestTiles(keys) dispatches the backend's fetcher for keys
   *      not already in the index/cache.
   *    • maxLevel reports the catalog's maxZoom so VTR doesn't fall
   *      back to sub-tile generation inside the available z range.
   *    • getBounds() returns the catalog bounds (camera fit + culling).
   *  Adapters live in their own module (loader/pmtiles-source.ts);
   *  XGVTSource stays format-agnostic. */
  setVirtualCatalog(catalog: VirtualCatalog): void {
    const sink: PMTilesBackendSink = {
      hasTileData: (key) => this.dataCache.has(key),
      trackLoading: (key) => { this.loadingTiles.add(key) },
      releaseLoading: (key) => { this.loadingTiles.delete(key) },
      getLoadingCount: () => this.loadingTiles.size,
      registerEntry: (key, entry) => {
        if (this.index && !this.index.entryByHash.has(key)) {
          this.index.entries.push(entry)
          this.index.entryByHash.set(key, entry)
        }
      },
      getEntry: (key) => this.index?.entryByHash.get(key),
      cacheTileData: (key, polygons, vertices, indices, lineVerts, lineIndices, pointVerts, outlineIndices, outlineVerts, outlineLineIndices) =>
        this.cacheTileData(key, polygons, vertices, indices, lineVerts, lineIndices, pointVerts, outlineIndices, outlineVerts, outlineLineIndices),
      createFullCoverTileData: (key, entry, lineVerts, lineIndices) =>
        this.createFullCoverTileData(key, entry, lineVerts, lineIndices),
    }
    this.pmtilesBackend = new PMTilesBackend(catalog, sink)
    if (!this.index) {
      this.index = {
        header: {
          levelCount: 0,
          maxLevel: catalog.maxZoom,
          bounds: catalog.bounds,
          indexOffset: 0, indexLength: 0,
          propTableOffset: 0, propTableLength: 0,
        },
        entries: [],
        entryByHash: new Map(),
        propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      }
    } else {
      this.index.header.maxLevel = Math.max(this.index.header.maxLevel, catalog.maxZoom)
    }
  }

  // ── Loading ──

  /** Lazy-build the BinaryBackendSink — the callback bundle the binary
   *  backend uses to write into our cache. Bound to private methods so
   *  backend code can't accidentally see our private state. */
  private getBinaryBackend(): XGVTBinaryBackend {
    if (!this.binaryBackend) {
      const sink: BinaryBackendSink = {
        hasTileData: (key) => this.dataCache.has(key),
        trackLoading: (key) => { this.loadingTiles.add(key) },
        releaseLoading: (key) => { this.loadingTiles.delete(key) },
        getLoadingCount: () => this.loadingTiles.size,
        cacheTileData: (key, polygons, vertices, indices, lineVerts, lineIndices, pointVerts, outlineIndices, outlineVerts, outlineLineIndices) =>
          this.cacheTileData(key, polygons, vertices, indices, lineVerts, lineIndices, pointVerts, outlineIndices, outlineVerts, outlineLineIndices),
        createFullCoverTileData: (key, entry, lineVerts, lineIndices) =>
          this.createFullCoverTileData(key, entry, lineVerts, lineIndices),
      }
      this.binaryBackend = new XGVTBinaryBackend(sink)
    }
    return this.binaryBackend
  }

  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    const backend = this.getBinaryBackend()
    await backend.loadFromBuffer(buf)
    // Adopt the backend's parsed index as our own — VTR + multi-backend
    // dispatch read it via getIndex() / hasEntryInIndex / maxLevel.
    this.index = backend.index
  }

  async loadFromURL(url: string): Promise<void> {
    const backend = this.getBinaryBackend()
    await backend.loadFromURL(url)
    this.index = backend.index
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

  // ── Tile request (async batch loading) ──

  requestTiles(keys: number[]): void {
    if (!this.index) return

    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const key of keys) {
      if (this.dataCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
      const entry = this.index.entryByHash.get(key)
      if (!entry) {
        // On-demand: compile from raw GeoJSON parts, or dispatch the
        // PMTiles backend fetcher, or give up. compileTileOnDemand
        // stays sync; PMTilesBackend.loadTile is async — it manages
        // loadingTiles itself via the sink callbacks and triggers
        // onTileLoaded when the network round-trip completes.
        if (this.geojsonBackend) this.compileTileOnDemand(key)
        else if (this.pmtilesBackend) this.pmtilesBackend.loadTile(key)
        continue
      }

      // Full-cover tiles with no data: create quad immediately
      if ((entry.flags & TILE_FLAG_FULL_COVER) && entry.compactSize === 0) {
        this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
        continue
      }

      entries.push({ key, entry })
    }

    // Delegate the actual fetch + decode + worker-pool dispatch to the
    // binary backend. It manages range-request batching, the
    // GPU-ready/compact split, and per-tile loadingTiles tracking via
    // the sink callbacks bound in getBinaryBackend().
    if (entries.length > 0) {
      this.getBinaryBackend().requestTilesBatch(entries)
    }
  }

  private createFullCoverTileData(key: number, entry: TileIndexEntry, lineVertices: Float32Array, lineIndices: Uint32Array): void {
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

    this.cacheTileData(key, undefined, vertices, indices, lineVertices, lineIndices)
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
      tileWest, tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
      tileZoom: tz,
      polygons,
    }

    this.dataCache.set(key, data)
    try { this.onTileLoaded?.(key, data) }
    catch (e) { console.error('[onTileLoaded]', (e as Error)?.stack ?? e) }
  }

  // ── Sub-tile generation (overzoom CPU clipping) ──

  generateSubTile(subKey: number, parentKey: number): boolean {
    // Return cached result without charging budget — this is not new work.
    if (this.dataCache.has(subKey)) return true

    // Hybrid per-frame budget — see resetCompileBudget() comment.
    // Historically two count-based gates (>=16 / >=8); the 8-cap caused
    // 60-frame (~1 s) convergence stalls at pitch ≥ 60° with ~280
    // frustum tiles of microsecond-scale sub-tile clips. Hybrid keeps
    // the 8-call floor so low-zoom heavy parent geometry still self-
    // throttles, while letting µs-scale high-zoom bursts fill the 6 ms
    // wall-clock budget (typically 50+ sub-tiles per frame at z ≥ 10).
    if (this._budgetExceeded(this._subTileCountThisFrame, XGVTSource._SUBTILE_FLOOR)) return false

    const parent = this.dataCache.get(parentKey)
    if (!parent || (parent.indices.length === 0 && parent.lineIndices.length === 0)) return false
    if (this.dataCache.has(subKey)) return false // already generated

    this._subTileCountThisFrame++

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

    this.dataCache.set(subKey, subData)
    this._subTileCountThisFrame++
    try { this.onTileLoaded?.(subKey, subData) }
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
        if (!this.dataCache.has(key) && !this.loadingTiles.has(key) && this.index.entryByHash.has(key)) {
          prefetchKeys.push(key)
        }
      }
    }

    if (prefetchKeys.length > 0 && this.loadingTiles.size < MAX_CONCURRENT_LOADS) {
      this.requestTiles(prefetchKeys.slice(0, MAX_CONCURRENT_LOADS - this.loadingTiles.size))
    }
  }

  prefetchNextZoom(
    centerLon: number, centerLat: number,
    currentZ: number, canvasWidth: number, canvasHeight: number,
    cameraZoom: number,
  ): void {
    if (!this.index || this.loadingTiles.size >= MAX_CONCURRENT_LOADS) return

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
      const slots = MAX_CONCURRENT_LOADS - this.loadingTiles.size
      if (slots > 0) this.requestTiles(prefetchKeys.slice(0, slots))
    }
  }

  // ── Cache eviction ──

  evictTiles(protectedKeys: Set<number>): void {
    if (this.dataCache.size <= MAX_CACHED_TILES) return

    // Protect all indexed ancestor tiles (z ≤ maxLevel) in addition
    // to the current frame's stableKeys. Same rationale as the
    // VectorTileRenderer gpuCache eviction: every over-zoom sub-tile
    // relies on its nearest indexed ancestor surviving in dataCache
    // so generateSubTile can re-clip from it if the leaf gets
    // evicted. Hardcoded 4 before; sources can go to z=5 or z=7 so
    // 4 left real ancestors evictable. Fixed alongside the E2E
    // flicker repro (_high-pitch-flicker.spec.ts).
    const safeBelow = this.index ? this.maxLevel : 4
    const entries = [...this.dataCache.entries()]
      .filter(([key, tile]) => !protectedKeys.has(key) && tile.tileZoom > safeBelow)

    // Sort by insertion order (older first — simple LRU approximation)
    const toEvict = this.dataCache.size - MAX_CACHED_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.dataCache.delete(entries[i][0])
    }
  }
}

