// ═══ XGVTSource — .xgvt 파일 데이터 관리 (GeoJSON-VT 스타일) ═══
// 로딩, 캐싱, 서브타일 클리핑, 프리페치를 담당.
// GPU 독립: CPU 배열만 관리, GPU 업로드는 VectorTileRenderer가 담당.

import {
  parseXGVTIndex, parseGPUReadyTile, decompressTileData, parsePropertyTable,
  TILE_FLAG_FULL_COVER,
  tileKey, tileKeyUnpack,
  clipPolygonToRect,
  compileSingleTile,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
  type CompiledTileSet, type TileLevel,
  type GeometryPart,
} from '@xgis/compiler'
import { visibleTiles } from '../loader/tiles'

// ═══ Types ═══

/** CPU-only tile data (no GPU dependency) */
export interface TileData {
  vertices: Float32Array       // [lon, lat, featId] stride 3 (tile-local)
  indices: Uint32Array         // triangle indices
  lineVertices: Float32Array   // line vertices
  lineIndices: Uint32Array     // line segment indices (pairs)
  tileWest: number             // tile origin (degrees)
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  polygons?: RingPolygon[]     // original rings (for sub-tiling)
}

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

  /** Store raw geometry parts for on-demand compilation (GeoJSON sources) */
  setRawParts(parts: GeometryPart[], maxZoom: number): void {
    this.rawParts = parts
    this.rawMaxZoom = maxZoom
  }

  /** Compile a single tile on demand from raw parts */
  compileTileOnDemand(key: number): boolean {
    if (!this.rawParts || this.dataCache.has(key)) return false
    const [z, x, y] = tileKeyUnpack(key)
    if (z > this.rawMaxZoom) return false

    const tile = compileSingleTile(this.rawParts, z, x, y, this.rawMaxZoom)
    if (!tile) return false

    // Create synthetic index entry
    if (this.index) {
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / 3, indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / 3, lineIndexCount: tile.lineIndices.length,
        flags: 0, fullCoverFeatureId: 0,
      }
      if (!this.index.entryByHash.has(key)) {
        this.index.entries.push(entry)
        this.index.entryByHash.set(key, entry)
      }
    }

    const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
    this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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

    // Load z0-z4 tiles BEFORE returning (guarantees fallback coverage)
    await this.preloadLowZoomTiles()
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
          vertexCount: tile.vertices.length / 3,
          indexCount: tile.indices.length,
          lineVertexCount: tile.lineVertices.length / 3,
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
          this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        }
        tileCount++
      }
    }

    const [minLon, minLat, maxLon, maxLat] = tileSet.bounds
    this.index = {
      header: {
        magic: 0x54564758,
        version: 1,
        minLevel: tileSet.levels.length > 0 ? tileSet.levels[0].zoom : 0,
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
          magic: 0x54564758, version: 1,
          minLevel: level.zoom, maxLevel: level.zoom,
          bounds, indexOffset: 0, indexLength: 0,
          propTableOffset: 0, propTableLength: 0,
        },
        entries: [], entryByHash: new Map(), propertyTable,
      }
      this.isFullFileMode = true
    }

    this.index.header.maxLevel = Math.max(this.index.header.maxLevel, level.zoom)

    for (const [, tile] of level.tiles) {
      const key = tileKey(tile.z, tile.x, tile.y)
      if (this.index.entryByHash.has(key)) continue

      const isFullCover = !!tile.fullCover
      const fid = tile.fullCoverFeatureId ?? 0
      const entry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / 3, indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / 3, lineIndexCount: tile.lineIndices.length,
        flags: isFullCover ? (TILE_FLAG_FULL_COVER | (fid << 1)) : 0,
        fullCoverFeatureId: fid,
      }
      this.index.entries.push(entry)
      this.index.entryByHash.set(key, entry)

      if (isFullCover && tile.vertices.length === 0) {
        this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
      } else {
        const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
        this.cacheTileData(key, polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
      }
    }
  }

  private async preloadLowZoomTiles(): Promise<void> {
    if (!this.index) return
    const lowZoomEntries: { key: number; entry: TileIndexEntry }[] = []
    for (const entry of this.index.entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z <= 4 && !this.dataCache.has(entry.tileHash)) {
        lowZoomEntries.push({ key: entry.tileHash, entry })
      }
    }
    if (lowZoomEntries.length === 0) return

    // Full-file mode: load synchronously
    if (this.isFullFileMode && this.fileBuf) {
      for (const { key, entry } of lowZoomEntries) {
        const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
        if (entry.gpuReadySize > 0) {
          const tile = parseGPUReadyTile(this.fileBuf!, {
            ...entry, dataOffset: entry.dataOffset + entry.compactSize,
            compactSize: 0, gpuReadySize: entry.gpuReadySize,
          })
          if (isFullCover) this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
          else this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        } else if (entry.compactSize > 0) {
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          const result = await decompressTileData(slice)
          this.parseTileAndCache(key, result, entry, isFullCover)
        } else if (isFullCover) {
          this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
        }
      }
      return
    }

    // Range Request mode: batch all z0-z4 tiles in ONE request (no concurrent limit)
    if (!this.fileUrl) return
    lowZoomEntries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)

    // Find byte range covering all z0-z4 tiles
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    const startOffset = lowZoomEntries[0].entry.dataOffset
    const lastEntry = lowZoomEntries[lowZoomEntries.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)

    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)

    for (const { key, entry } of lowZoomEntries) {
      const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
      const localOffset = entry.dataOffset - startOffset

      if (entry.gpuReadySize > 0) {
        const gpuOffset = localOffset + entry.compactSize
        const gpuBuf = buf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
        const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
        if (isFullCover) this.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        else this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
      } else if (entry.compactSize > 0) {
        const compressed = buf.slice(localOffset, localOffset + entry.compactSize)
        const decompressed = await decompressTileData(compressed)
        this.parseTileAndCache(key, decompressed, entry, isFullCover)
      } else if (isFullCover) {
        this.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
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
            this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
          }
          this.loadingTiles.delete(key)
        } else {
          // Compact: decompress + earcut (no intermediate cache)
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          decompressTileData(slice).then(result => {
            this.parseTileAndCache(key, result, entry, isFullCover)
            this.loadingTiles.delete(key)
          }).catch(() => { this.loadingTiles.delete(key) })
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
              this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
            }
            this.loadingTiles.delete(key)
          } else if (entry.compactSize > 0) {
            const compressed = buf.slice(localOffset, localOffset + entry.compactSize)
            decompressTileData(compressed).then(decompressed => {
              this.parseTileAndCache(key, decompressed, entry, isFullCover)
              this.loadingTiles.delete(key)
            }).catch(() => { this.loadingTiles.delete(key) })
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
      this.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
    }
  }

  private createFullCoverTileData(key: number, entry: TileIndexEntry, lineVertices: Float32Array, lineIndices: Uint32Array): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWidth = 360 / tn
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileHeight = tileNorth - tileSouth
    const fid = entry.fullCoverFeatureId

    const vertices = new Float32Array([
      0, 0, fid, tileWidth, 0, fid,
      tileWidth, tileHeight, fid, 0, tileHeight, fid,
    ])
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3])

    this.cacheTileData(key, undefined, vertices, indices, lineVertices, lineIndices)
  }

  private cacheTileData(
    key: number,
    polygons: RingPolygon[] | undefined,
    vertices: Float32Array, indices: Uint32Array,
    lineVertices: Float32Array, lineIndices: Uint32Array,
  ): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI

    const data: TileData = {
      vertices, indices, lineVertices, lineIndices,
      tileWest, tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
      tileZoom: tz,
      polygons,
    }

    this.dataCache.set(key, data)
    this.onTileLoaded?.(key, data)
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

    const clipW = subWest - parent.tileWest
    const clipE = subEast - parent.tileWest
    const clipS = subSouth - parent.tileSouth
    const clipN = subNorth - parent.tileSouth

    // Clip polygons
    const verts = parent.vertices
    const outV: number[] = []
    const outI: number[] = []

    for (let t = 0; t < parent.indices.length; t += 3) {
      const i0 = parent.indices[t], i1 = parent.indices[t + 1], i2 = parent.indices[t + 2]
      const x0 = verts[i0 * 3], y0 = verts[i0 * 3 + 1]
      const x1 = verts[i1 * 3], y1 = verts[i1 * 3 + 1]
      const x2 = verts[i2 * 3], y2 = verts[i2 * 3 + 1]
      const fid = verts[i0 * 3 + 2]

      const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2)
      const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2)
      if (maxX < clipW || minX > clipE || maxY < clipS || minY > clipN) continue

      if (minX >= clipW && maxX <= clipE && minY >= clipS && maxY <= clipN) {
        const base = outV.length / 3
        outV.push(x0, y0, fid, x1, y1, fid, x2, y2, fid)
        outI.push(base, base + 1, base + 2)
        continue
      }

      const clipped = clipPolygonToRect([[[x0, y0], [x1, y1], [x2, y2]]], clipW, clipS, clipE, clipN)
      if (clipped.length === 0 || clipped[0].length < 3) continue
      const ring = clipped[0]
      const base = outV.length / 3
      for (const [x, y] of ring) outV.push(x, y, fid)
      for (let j = 1; j < ring.length - 1; j++) outI.push(base, base + j, base + j + 1)
    }

    // Clip lines (Liang-Barsky)
    const lineVerts = parent.lineVertices
    const lineIdx = parent.lineIndices
    const outLV: number[] = []
    const outLI: number[] = []

    for (let s = 0; s < lineIdx.length; s += 2) {
      const a = lineIdx[s], b = lineIdx[s + 1]
      const ax = lineVerts[a * 3], ay = lineVerts[a * 3 + 1], afid = lineVerts[a * 3 + 2]
      const bx = lineVerts[b * 3], by = lineVerts[b * 3 + 1]

      if (Math.max(ax, bx) < clipW || Math.min(ax, bx) > clipE ||
          Math.max(ay, by) < clipS || Math.min(ay, by) > clipN) continue

      if (ax >= clipW && ax <= clipE && ay >= clipS && ay <= clipN &&
          bx >= clipW && bx <= clipE && by >= clipS && by <= clipN) {
        const base = outLV.length / 3
        outLV.push(ax, ay, afid, bx, by, afid)
        outLI.push(base, base + 1)
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
      if (!valid || tMin > tMax) continue

      const base = outLV.length / 3
      outLV.push(ax + tMin * dx, ay + tMin * dy, afid, ax + tMax * dx, ay + tMax * dy, afid)
      outLI.push(base, base + 1)
    }

    // Cache sub-tile (even if empty — prevents parent fallback)
    const subData: TileData = {
      vertices: new Float32Array(outV),
      indices: new Uint32Array(outI),
      lineVertices: new Float32Array(outLV),
      lineIndices: new Uint32Array(outLI),
      tileWest: parent.tileWest,
      tileSouth: parent.tileSouth,
      tileWidth: parent.tileWidth,
      tileHeight: parent.tileHeight,
      tileZoom: sz,
    }

    this.dataCache.set(subKey, subData)
    this.onTileLoaded?.(subKey, subData)
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
