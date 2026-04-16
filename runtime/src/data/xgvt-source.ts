// ═══ XGVTSource — .xgvt 파일 데이터 관리 (GeoJSON-VT 스타일) ═══
// 로딩, 캐싱, 서브타일 클리핑, 프리페치를 담당.
// GPU 독립: CPU 배열만 관리, GPU 업로드는 VectorTileRenderer가 담당.

import {
  parseXGVTIndex, parseGPUReadyTile, decompressTileData, parsePropertyTable,
  TILE_FLAG_FULL_COVER,
  tileKey, tileKeyUnpack,
  clipPolygonToRect,
  compileSingleTile,
  lonLatToMercF64,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { visibleTiles } from '../loader/tiles'
import { getSharedPool, type XGVTWorkerPool } from './xgvt-worker-pool'

// ═══ Types ═══

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

const MAX_CACHED_TILES = 512
const MAX_CONCURRENT_LOADS = 32

// ═══ Source ═══

export class XGVTSource {
  private index: XGVTIndex | null = null
  private fileUrl = ''
  private fileBuf: ArrayBuffer | null = null
  private dataCache = new Map<number, TileData>()
  private loadingTiles = new Set<number>()
  private isFullFileMode = false

  /** Raw geometry parts for on-demand tile compilation (GeoJSON sources only) */
  private rawParts: GeometryPart[] | null = null
  private rawMaxZoom = 7

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

  /** Spatial grid index: z=3 tile key → part indices */
  private partGrid: Map<number, number[]> | null = null
  private static readonly GRID_ZOOM = 3

  /** Store raw geometry parts for on-demand compilation (GeoJSON sources) */
  setRawParts(parts: GeometryPart[], maxZoom: number): void {
    this.rawParts = parts
    this.rawMaxZoom = maxZoom
    this.buildPartGrid(parts)
  }

  /** Build spatial grid index at z=3 (64 cells) for fast part lookup */
  private buildPartGrid(parts: GeometryPart[]): void {
    const z = XGVTSource.GRID_ZOOM
    const n = Math.pow(2, z)
    const grid = new Map<number, number[]>()

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const minTX = Math.max(0, Math.floor((p.minLon + 180) / 360 * n))
      const maxTX = Math.min(n - 1, Math.floor((p.maxLon + 180) / 360 * n))
      const minTY = Math.max(0, Math.floor((1 - Math.log(Math.tan(Math.max(p.minLat, -85) * Math.PI / 180) + 1 / Math.cos(Math.max(p.minLat, -85) * Math.PI / 180)) / Math.PI) / 2 * n))
      const maxTY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(Math.min(p.maxLat, 85) * Math.PI / 180) + 1 / Math.cos(Math.min(p.maxLat, 85) * Math.PI / 180)) / Math.PI) / 2 * n))

      // Note: in Mercator tile coords, smaller Y = higher latitude
      const yLo = Math.min(minTY, maxTY)
      const yHi = Math.max(minTY, maxTY)

      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = yLo; ty <= yHi; ty++) {
          const key = tileKey(z, tx, ty)
          let arr = grid.get(key)
          if (!arr) { arr = []; grid.set(key, arr) }
          arr.push(i)
        }
      }
    }
    this.partGrid = grid
  }

  /** Get parts that potentially overlap a tile (via grid index) */
  getRelevantParts(z: number, x: number, y: number): GeometryPart[] | null {
    if (!this.rawParts || !this.partGrid) return this.rawParts
    const gz = XGVTSource.GRID_ZOOM

    if (z >= gz) {
      // Tile fits within one grid cell
      const shift = z - gz
      const key = tileKey(gz, x >> shift, y >> shift)
      const indices = this.partGrid.get(key)
      if (!indices) return null
      return indices.map(i => this.rawParts![i])
    }

    // z < gz: tile covers multiple grid cells — aggregate with dedup
    const shift = gz - z
    const gx0 = x << shift
    const gy0 = y << shift
    const span = 1 << shift
    const seen = new Set<number>()
    const result: GeometryPart[] = []
    for (let gx = gx0; gx < gx0 + span; gx++) {
      for (let gy = gy0; gy < gy0 + span; gy++) {
        const key = tileKey(gz, gx, gy)
        const indices = this.partGrid.get(key)
        if (!indices) continue
        for (const idx of indices) {
          if (!seen.has(idx)) { seen.add(idx); result.push(this.rawParts![idx]) }
        }
      }
    }
    return result.length > 0 ? result : null
  }

  /** Compile a single tile on demand from raw parts */
  private _compileBudget = 0
  /** Reset per-frame compilation budget (call once per frame before tile requests) */
  resetCompileBudget(): void { this._compileBudget = 0 }

  compileTileOnDemand(key: number): boolean {
    if (!this.rawParts || this.dataCache.has(key)) return false
    if (this._compileBudget >= 2) return false // max 2 tiles per frame — smooth 30fps
    const [z, x, y] = tileKeyUnpack(key)
    if (z > this.rawMaxZoom) return false

    // Use spatial grid for faster part lookup (64× fewer parts at z=3+)
    const parts = this.getRelevantParts(z, x, y)
    if (!parts || parts.length === 0) return false

    const tile = compileSingleTile(parts, z, x, y, this.rawMaxZoom)
    if (!tile) return false

    // Create synthetic index entry
    if (this.index) {
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE, indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE, lineIndexCount: tile.lineIndices.length,
        flags: 0, fullCoverFeatureId: 0,
      }
      if (!this.index.entryByHash.has(key)) {
        this.index.entries.push(entry)
        this.index.entryByHash.set(key, entry)
      }
    }

    const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
    this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, tile.pointVertices, tile.outlineIndices)
    this._compileBudget++
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

  getCacheSize(): number {
    return this.dataCache.size
  }

  hasEntryInIndex(key: number): boolean {
    if (this.index?.entryByHash.has(key)) return true
    // On-demand sources can compile any tile within maxZoom
    if (this.rawParts) {
      const [z] = tileKeyUnpack(key)
      return z <= this.rawMaxZoom
    }
    return false
  }

  // ── Loading ──

  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    this.fileBuf = buf
    this.index = parseXGVTIndex(buf)
    this.isFullFileMode = true

    const { propTableOffset, propTableLength } = this.index.header
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = buf.slice(propTableOffset, propTableOffset + propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles`)
    await this.preloadLowZoomTiles()
  }

  async loadFromURL(url: string): Promise<void> {
    this.fileUrl = url

    const headerBuf = await fetchRange(url, 0, 40)
    const view = new DataView(headerBuf)
    const indexOffset = view.getUint32(24, true)
    const indexLength = view.getUint32(28, true)

    const indexBuf = await fetchRange(url, 0, indexOffset + indexLength)
    this.index = parseXGVTIndex(indexBuf)

    const propTableOffset = this.index.header.propTableOffset
    const propTableLength = this.index.header.propTableLength
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = await fetchRange(url, propTableOffset, propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles (Range Request mode)`)

    // Stage the z = 0 tile BEFORE returning — this is 1 tile per source,
    // parses in <100 ms, and gives the render loop a coarse global
    // fallback to paint the first frame against. All remaining low-zoom
    // tiles (z=1..3) are queued in the background via preloadBackground()
    // and populate dataCache as they arrive. The render loop's parent
    // walk will find them as soon as they're ready; until then it falls
    // back to the z=0 tile or renders nothing.
    await this.preloadZeroTile()
    // Kick off background preload but do NOT await — loadFromURL returns
    // immediately after z=0 is ready.
    this.preloadBackground().catch(e => console.error('[xgvt preload bg]', (e as Error)?.stack ?? e))
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
    this.isFullFileMode = true

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
      this.isFullFileMode = true
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

  /** Parse an entry list from an already-fetched shared buffer into
   *  dataCache. Called by both preloadZeroTile and preloadBackground.
   *  Compact tiles are dispatched to the worker pool so decompress +
   *  earcut runs off the main thread. Returns a promise that resolves
   *  when all compact jobs finish. */
  private async parseEntryBatch(
    entries: { key: number; entry: TileIndexEntry }[],
    sharedBuf: ArrayBuffer,
    sharedStartOffset: number,
  ): Promise<void> {
    const pool = this.getPool()
    const compactJobs: Promise<void>[] = []
    for (const { key, entry } of entries) {
      const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
      const localOffset = entry.dataOffset - sharedStartOffset

      if (entry.gpuReadySize > 0) {
        const gpuOffset = localOffset + entry.compactSize
        const gpuBuf = sharedBuf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
        const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
        if (isFullCover) this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        else this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
      } else if (entry.compactSize > 0) {
        // Slice the compressed bytes and hand them to a worker. The
        // worker returns already-decompressed + earcut-tessellated
        // typed arrays as Transferables, so the main thread only runs
        // cacheTileData / createFullCoverTileData (which is fast).
        const compressed = sharedBuf.slice(localOffset, localOffset + entry.compactSize)
        compactJobs.push(
          pool.parseTile(compressed, entry).then(parsed => {
            if (isFullCover) {
              this.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
            } else {
              this.cacheTileData(
                key, parsed.polygons,
                parsed.vertices, parsed.indices,
                parsed.lineVertices, parsed.lineIndices,
                undefined, parsed.outlineIndices,
              )
            }
          }).catch(err => {
            console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
          }),
        )
      } else if (isFullCover) {
        this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
      }
    }
    if (compactJobs.length > 0) await Promise.all(compactJobs)
  }

  private _pool: XGVTWorkerPool | null = null
  private getPool(): XGVTWorkerPool {
    if (!this._pool) this._pool = getSharedPool()
    return this._pool
  }

  /** Stage 1 of preload: the z=0 root tile only. Resolves in ~50-100 ms
   *  per source and gives the render loop a coarse global fallback so
   *  the first frame paints immediately. Full-file and Range Request
   *  paths handled uniformly. */
  private async preloadZeroTile(): Promise<void> {
    if (!this.index) return
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const entry of this.index.entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z === 0 && !this.dataCache.has(entry.tileHash)) {
        entries.push({ key: entry.tileHash, entry })
      }
    }
    if (entries.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      // In-memory mode: entries already point into the full buffer.
      await this.parseEntryBatch(entries, this.fileBuf, 0)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = entries[0].entry.dataOffset
    const lastEntry = entries[entries.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(entries, buf, startOffset)
  }

  /** Stage 2 of preload: all z=1..3 tiles, background. Runs after
   *  loadFromURL has already returned. Tiles populate dataCache as they
   *  finish; the render loop's parent walk picks them up as soon as
   *  they're ready. Errors are logged, never thrown. */
  private async preloadBackground(): Promise<void> {
    if (!this.index) return
    const PRELOAD_MAX_Z = 3
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const entry of this.index.entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z >= 1 && z <= PRELOAD_MAX_Z && !this.dataCache.has(entry.tileHash)) {
        entries.push({ key: entry.tileHash, entry })
      }
    }
    if (entries.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      await this.parseEntryBatch(entries, this.fileBuf, 0)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = entries[0].entry.dataOffset
    const lastEntry = entries[entries.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(entries, buf, startOffset)
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
        // On-demand: compile from raw GeoJSON parts if available
        if (this.rawParts) this.compileTileOnDemand(key)
        continue
      }

      // Full-cover tiles with no data: create quad immediately
      if ((entry.flags & TILE_FLAG_FULL_COVER) && entry.compactSize === 0) {
        this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
        continue
      }

      entries.push({ key, entry })
    }

    if (entries.length === 0) return

    // Full-file mode (ArrayBuffer already loaded)
    if (this.isFullFileMode && this.fileBuf) {
      for (const { key, entry } of entries) {
        this.loadingTiles.add(key)
        const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)

        if (entry.gpuReadySize > 0) {
          // GPU-ready: read directly from file buffer (no decompression, no copy)
          const tile = parseGPUReadyTile(this.fileBuf!, {
            ...entry, dataOffset: entry.dataOffset + entry.compactSize,
            compactSize: 0, gpuReadySize: entry.gpuReadySize,
          })
          if (isFullCover) {
            this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
          } else {
            this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
          }
          this.loadingTiles.delete(key)
        } else {
          // Compact in full-file mode: hand off to worker pool so
          // decompress + earcut runs off-main-thread.
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          this.getPool().parseTile(slice, entry).then(parsed => {
            if (isFullCover) {
              this.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
            } else {
              this.cacheTileData(
                key, parsed.polygons,
                parsed.vertices, parsed.indices,
                parsed.lineVertices, parsed.lineIndices,
                undefined, parsed.outlineIndices,
              )
            }
            this.loadingTiles.delete(key)
          }).catch(err => {
            this.loadingTiles.delete(key)
            console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
          })
        }
      }
      return
    }

    if (!this.fileUrl) return

    // Range Request mode: sort by offset, merge adjacent tiles
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)

    const MAX_GAP = 8 * 1024  // 8KB gap tolerance — merge nearby tiles into fewer requests
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    const batches: { entries: typeof entries; startOffset: number; endOffset: number }[] = []
    let current = {
      entries: [entries[0]],
      startOffset: entries[0].entry.dataOffset,
      endOffset: entries[0].entry.dataOffset + tileSize(entries[0].entry),
    }

    for (let i = 1; i < entries.length; i++) {
      const e = entries[i]
      const eEnd = e.entry.dataOffset + tileSize(e.entry)
      if (e.entry.dataOffset - current.endOffset <= MAX_GAP) {
        current.entries.push(e)
        current.endOffset = Math.max(current.endOffset, eEnd)
      } else {
        batches.push(current)
        current = { entries: [e], startOffset: e.entry.dataOffset, endOffset: eEnd }
      }
    }
    batches.push(current)

    for (const batch of batches) {
      for (const { key } of batch.entries) this.loadingTiles.add(key)

      const size = batch.endOffset - batch.startOffset
      if (size <= 0) continue

      fetchRange(this.fileUrl, batch.startOffset, size).then(buf => {
        for (const { key, entry } of batch.entries) {
          const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
          const localOffset = entry.dataOffset - batch.startOffset

          if (entry.gpuReadySize > 0) {
            const gpuOffset = localOffset + entry.compactSize
            const gpuBuf = buf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
            const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
            if (isFullCover) {
              this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
            } else {
              this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
            }
            this.loadingTiles.delete(key)
          } else if (entry.compactSize > 0) {
            // Route compact-tile decompress + earcut through the worker
            // pool so the main thread stays free for interactive frames.
            const compressed = buf.slice(localOffset, localOffset + entry.compactSize)
            this.getPool().parseTile(compressed, entry).then(parsed => {
              if (isFullCover) {
                this.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
              } else {
                this.cacheTileData(
                  key, parsed.polygons,
                  parsed.vertices, parsed.indices,
                  parsed.lineVertices, parsed.lineIndices,
                  undefined, parsed.outlineIndices,
                )
              }
              this.loadingTiles.delete(key)
            }).catch(err => {
              this.loadingTiles.delete(key)
              console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
            })
          } else if (isFullCover) {
            this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
            this.loadingTiles.delete(key)
          }
        }
      }).catch(() => {
        for (const { key } of batch.entries) this.loadingTiles.delete(key)
      })
    }
  }

  private parseTileAndCache(key: number, decompressed: ArrayBuffer, entry: TileIndexEntry, isFullCover: boolean): void {
    const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength, gpuReadySize: 0 })
    if (isFullCover) {
      this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
    } else {
      this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
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
    const parent = this.dataCache.get(parentKey)
    if (!parent || (parent.indices.length === 0 && parent.lineIndices.length === 0)) return false

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

    // Clip polygon outlines (same Liang-Barsky as lines, but uses polygon vertices)
    const outlineIdx = parent.outlineIndices
    const outOI: number[] = []
    if (outlineIdx && outlineIdx.length > 0) {
      for (let s = 0; s < outlineIdx.length; s += 2) {
        const a = outlineIdx[s], b = outlineIdx[s + 1]
        const [ax, ay, afid] = readPV(a)
        const [bx, by] = readPV(b)

        if (Math.max(ax, bx) < clipW || Math.min(ax, bx) > clipE ||
            Math.max(ay, by) < clipS || Math.min(ay, by) > clipN) continue

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

        const i0 = pushDedupPV(ax + tMin * dx, ay + tMin * dy, afid)
        const i1 = pushDedupPV(ax + tMax * dx, ay + tMax * dy, afid)
        if (i0 === i1) continue // degenerate clip
        outOI.push(i0, i1)
      }
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
      outlineIndices: new Uint32Array(outOI),
      tileWest: subWest,
      tileSouth: subSouth,
      tileWidth: subEast - subWest,
      tileHeight: subNorth - subSouth,
      tileZoom: sz,
    }

    this.dataCache.set(subKey, subData)
    try { this.onTileLoaded?.(subKey, subData) }
    catch (e) { console.error('[onTileLoaded sub]', (e as Error)?.stack ?? e) }
    return true
  }

  // ── Prefetch ──

  prefetchAdjacent(visTiles: { z: number; x: number; y: number }[], zoom: number): void {
    if (!this.index || visTiles.length === 0) return

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const t of visTiles) {
      if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x
      if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y
    }

    const n = Math.pow(2, zoom)
    const prefetchKeys: number[] = []

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

    const entries = [...this.dataCache.entries()]
      .filter(([key, tile]) => !protectedKeys.has(key) && tile.tileZoom > 4)

    // Sort by insertion order (older first — simple LRU approximation)
    const toEvict = this.dataCache.size - MAX_CACHED_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.dataCache.delete(entries[i][0])
    }
  }
}

// ═══ Helpers ═══

let fullFileCache: { url: string; buf: ArrayBuffer } | null = null

async function fetchRange(url: string, offset: number, length: number): Promise<ArrayBuffer> {
  if (fullFileCache && fullFileCache.url === url) {
    return fullFileCache.buf.slice(offset, offset + length)
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  })
  const buf = await res.arrayBuffer()

  if (res.status === 200 && buf.byteLength > length) {
    fullFileCache = { url, buf }
    return buf.slice(offset, offset + length)
  }
  return buf
}
