// ═══ Vector Tile Renderer ═══
// Renders pre-tiled vector data from .xgvt files.
// COG-style: loads index first, then fetches tiles on demand via Range Request.
// LRU cache with Morton-keyed spatial coherence.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTiles, sortByPriority } from '../loader/tiles'
import {
  parseXGVTIndex, parseGPUReadyTile, decompressTileData, parsePropertyTable,
  TILE_FLAG_FULL_COVER,
  tileKey, tileKeyUnpack,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable,
} from '@xgis/compiler'
import type { ShaderVariant } from '@xgis/compiler'

// ═══ Types ═══

interface CachedVectorTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  lastUsedFrame: number
  // Per-tile uniform buffer + bind group (for tile_origin)
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup
  tileWest: number
  tileSouth: number
  tileWidth: number
  tileHeight: number
}

const MAX_CACHED_TILES = 512
const MAX_CONCURRENT_LOADS = 12

// ═══ Renderer ═══

export class VectorTileRenderer {
  private device: GPUDevice
  private index: XGVTIndex | null = null
  private fileUrl = ''
  private fileBuf: ArrayBuffer | null = null // for local/full-file mode
  private tileCache = new Map<number, CachedVectorTile>()
  private loadingTiles = new Set<number>()
  private decompressedTiles: Map<number, ArrayBuffer> | null = null
  // Cached per-frame allocations (avoid GC pressure in render loop)
  private uniformDataBuf = new ArrayBuffer(144)
  private cachedBindGroup: GPUBindGroup | null = null
  private frameCount = 0
  private lastZoom = -1

  // Zoom transition state: keep previous zoom visible until new zoom fully loaded
  private stableZoom = -1
  private stableKeys: number[] = []        // tile keys that were fully rendered at stableZoom
  private zoomAbortController: AbortController | null = null

  // Global feature data buffer (shared across all tiles, built from PropertyTable)
  private featureDataBuffer: GPUBuffer | null = null
  private featureBindGroupLayout: GPUBindGroupLayout | null = null

  constructor(ctx: GPUContext) {
    this.device = ctx.device
  }

  /** Whether this renderer has data loaded */
  hasData(): boolean {
    return this.index !== null && this.index.entries.length > 0
  }

  /** Get the geographic bounds of the loaded data */
  getBounds(): [number, number, number, number] | null {
    return this.index?.header.bounds ?? null
  }

  /** Get the PropertyTable (for per-feature styling) */
  getPropertyTable(): PropertyTable | undefined {
    return this.index?.propertyTable
  }

  /** Whether feature data buffer has been built */
  hasFeatureData(): boolean {
    return this.featureDataBuffer !== null
  }

  /** Get cache size for stats */
  getCacheSize(): number {
    return this.tileCache.size
  }

  // Track per-frame rendered keys
  private renderedKeys: number[] = []

  /** Get draw stats for tiles rendered THIS frame (not all cached) */
  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const key of this.renderedKeys) {
      const tile = this.tileCache.get(key)
      if (!tile) continue
      if (tile.indexCount > 0) { drawCalls++; vertices += tile.indexCount; triangles += Math.floor(tile.indexCount / 3) }
      if (tile.lineIndexCount > 0) { drawCalls++; lines += Math.floor(tile.lineIndexCount / 2) }
    }
    return { drawCalls, vertices, triangles, lines, tilesVisible: this.renderedKeys.length }
  }

  /**
   * Build a global feature data GPU buffer from the PropertyTable.
   * Called when a shader variant requires per-feature data (needsFeatureBuffer).
   * String fields are encoded as category IDs (sorted unique values → 0-based integers).
   */
  buildFeatureDataBuffer(
    variant: ShaderVariant,
    featureBindGroupLayout: GPUBindGroupLayout,
  ): void {
    const table = this.index?.propertyTable
    if (!table || variant.featureFields.length === 0) return

    this.featureBindGroupLayout = featureBindGroupLayout
    const fieldCount = variant.featureFields.length
    const featureCount = table.values.length
    const data = new Float32Array(featureCount * fieldCount)

    // Build string→categoryID maps
    const catMaps = new Map<string, Map<string, number>>()
    for (const fieldName of variant.featureFields) {
      const fi = table.fieldNames.indexOf(fieldName)
      if (fi >= 0 && table.fieldTypes[fi] === 'string') {
        const uniqueVals = new Set<string>()
        for (const row of table.values) {
          const v = row[fi]
          if (typeof v === 'string') uniqueVals.add(v)
        }
        const sorted = [...uniqueVals].sort()
        const map = new Map<string, number>()
        sorted.forEach((v, i) => map.set(v, i))
        catMaps.set(fieldName, map)
      }
    }

    // Encode feature data
    for (let i = 0; i < featureCount; i++) {
      const row = table.values[i]
      for (let j = 0; j < fieldCount; j++) {
        const fieldName = variant.featureFields[j]
        const fi = table.fieldNames.indexOf(fieldName)
        if (fi < 0) continue
        const val = row[fi]
        const catMap = catMaps.get(fieldName)
        if (catMap && typeof val === 'string') {
          data[i * fieldCount + j] = catMap.get(val) ?? 0
        } else {
          data[i * fieldCount + j] = typeof val === 'number' ? val : 0
        }
      }
    }

    this.featureDataBuffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.featureDataBuffer, 0, data)
    console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields`)
  }

  /** Load from a full ArrayBuffer */
  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    this.fileBuf = buf
    this.index = parseXGVTIndex(buf)
    this.decompressedTiles = new Map()

    // Parse PropertyTable from the full buffer
    const { propTableOffset, propTableLength } = this.index.header
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = buf.slice(propTableOffset, propTableOffset + propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles`)
  }

  /** Load from URL (Range Request mode — COG-style async) */
  async loadFromURL(url: string): Promise<void> {
    this.fileUrl = url

    // 1. Fetch header (40 bytes for v2: includes propTable offset/length)
    const headerBuf = await fetchRange(url, 0, 40)
    const view = new DataView(headerBuf)
    const indexOffset = view.getUint32(24, true)
    const indexLength = view.getUint32(28, true)

    // 2. Fetch header + tile index in one request
    const indexBuf = await fetchRange(url, 0, indexOffset + indexLength)
    this.index = parseXGVTIndex(indexBuf)

    // 3. Fetch PropertyTable if present (v2+)
    const propTableOffset = this.index.header.propTableOffset
    const propTableLength = this.index.header.propTableLength
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = await fetchRange(url, propTableOffset, propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles (Range Request mode)`)
  }

  /** Render visible tiles into a render pass */
  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    show: ShowCommand,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
  ): void {
    if (!this.index) return
    this.frameCount++
    this.renderedKeys = []

    const { centerX, centerY, zoom } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)

    // Overzoom: clamp tile zoom to max available, camera zoom is unlimited
    // (tile-local coordinates + per-tile bind groups ensure f32 precision at any zoom)
    const maxLevel = this.index.header.maxLevel
    const currentZ = Math.max(0, Math.min(maxLevel, Math.round(camera.zoom)))

    // Zoom transition: cancel old requests when zoom changes
    if (currentZ !== this.lastZoom) {
      this.zoomAbortController?.abort()
      this.zoomAbortController = new AbortController()
      this.lastZoom = currentZ
    }

    const tiles = visibleTiles(centerLon, centerLat, currentZ, canvasWidth, canvasHeight)
    const n = Math.pow(2, currentZ)
    const ctX = Math.floor((centerLon + 180) / 360 * n)
    const ctY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
    sortByPriority(tiles, ctX, ctY)

    const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)

    // Write uniforms
    const fillRaw = show.fill ? parseHexColor(show.fill) : null
    const strokeRaw = show.stroke ? parseHexColor(show.stroke) : null
    const opacity = show.opacity ?? 1.0
    const fillColor = fillRaw ? [fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * opacity] : [0, 0, 0, 0]
    const strokeColor = strokeRaw ? [strokeRaw[0], strokeRaw[1], strokeRaw[2], strokeRaw[3] * opacity] : [0, 0, 0, 0]

    // Store bindGroupLayout for uploadTile
    this.lastBindGroupLayout = bindGroupLayout

    // Build shared uniform data (same for all tiles except tile_origin)
    const uniformData = this.uniformDataBuf
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set(fillColor)
    new Float32Array(uniformData, 80, 4).set(strokeColor)
    new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
    // tile_origin at offset 112 will be written per-tile in renderTileKeys

    // Render strategy: current zoom tiles first, parent fallback for missing positions
    const neededKeys = tiles.map(c => tileKey(c.z, c.x, c.y))

    // 1. For each visible position: find the best available tile (current zoom or ancestor)
    const fallbackKeys: number[] = []
    const toLoad: number[] = []

    for (let i = 0; i < tiles.length; i++) {
      const key = neededKeys[i]
      if (this.tileCache.has(key)) continue // already have current zoom tile

      // Walk up parent chain: find cached ancestor OR closest existing ancestor to load
      let parentKey = key
      let foundCached = false
      let closestExisting = -1
      for (let pz = currentZ - 1; pz >= 0; pz--) {
        parentKey = parentKey >>> 2
        if (this.tileCache.has(parentKey)) {
          fallbackKeys.push(parentKey)
          foundCached = true
          break
        }
        // Check if this ancestor exists in the index (adaptive tiling: leaf tile)
        if (closestExisting < 0 && this.index.entryByHash.has(parentKey)) {
          closestExisting = parentKey
        }
      }

      // If current zoom tile doesn't exist in index, load the closest ancestor
      if (!this.index.entryByHash.has(key) && closestExisting >= 0 && !foundCached) {
        toLoad.push(closestExisting)
      }
    }

    // 2. Render parent fallbacks first (behind), then current zoom on top
    const uniqueFallbacks = [...new Set(fallbackKeys)]
    if (uniqueFallbacks.length > 0) {
      this.renderTileKeys(uniqueFallbacks, pass, fillPipeline, linePipeline, null!, uniformBuffer, uniformData, centerLon, centerLat)
    }

    // 3. Render current zoom tiles (whatever is available) — drawn on top
    this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, null!, uniformBuffer, uniformData, centerLon, centerLat)
    this.stableZoom = currentZ
    this.stableKeys = neededKeys

    // 4. Load missing tiles — include ancestor tiles for adaptive leaf positions
    const missing = neededKeys
      .filter(k => !this.tileCache.has(k) && !this.loadingTiles.has(k) && this.index.entryByHash.has(k))
    const ancestorsToLoad = toLoad.filter(k => !this.tileCache.has(k) && !this.loadingTiles.has(k))
    const allToLoad = [...new Set([...missing, ...ancestorsToLoad])]
    if (allToLoad.length > 0) {
      this.batchLoadTiles(allToLoad)
    }

    // Prefetch adjacent tiles
    this.prefetchAdjacent(tiles, currentZ)

    // LRU eviction
    this.evictTiles()
  }

  /** Render a list of tile keys with per-tile bind groups */
  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    _sharedBindGroup: GPUBindGroup,
    _sharedUniformBuffer: GPUBuffer,
    sharedUniformData: ArrayBuffer,
    projCenterLon: number,
    projCenterLat: number,
  ): void {
    for (const key of keys) {
      const cached = this.tileCache.get(key)
      if (!cached || !cached.bindGroup) continue

      cached.lastUsedFrame = this.frameCount
      this.renderedKeys.push(key)

      // Write shared uniforms to this tile's buffer
      this.device.queue.writeBuffer(cached.uniformBuffer, 0, sharedUniformData)

      // Compute per-tile RTC offset on CPU in f64:
      // tile_rtc.xy = project(tile_origin) - project(center)
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileX = cached.tileWest * DEG2RAD * R
      const tileY = Math.log(Math.tan(Math.PI / 4 + cached.tileSouth * DEG2RAD / 2)) * R
      const centerX = projCenterLon * DEG2RAD * R
      const centerY = Math.log(Math.tan(Math.PI / 4 + projCenterLat * DEG2RAD / 2)) * R
      const offsetX = tileX - centerX
      const offsetY = tileY - centerY

      const tileRtc = new Float32Array([offsetX, offsetY, cached.tileWest, cached.tileSouth])
      this.device.queue.writeBuffer(cached.uniformBuffer, 112, tileRtc)

      if (cached.indexCount > 0) {
        pass.setPipeline(fillPipeline)
        pass.setBindGroup(0, cached.bindGroup)
        pass.setVertexBuffer(0, cached.vertexBuffer)
        pass.setIndexBuffer(cached.indexBuffer, 'uint32')
        pass.drawIndexed(cached.indexCount)
      }

      if (cached.lineIndexCount > 0 && cached.lineVertexBuffer && cached.lineIndexBuffer) {
        pass.setPipeline(linePipeline)
        pass.setBindGroup(0, cached.bindGroup)
        pass.setVertexBuffer(0, cached.lineVertexBuffer)
        pass.setIndexBuffer(cached.lineIndexBuffer, 'uint32')
        pass.drawIndexed(cached.lineIndexCount)
      }
    }
  }

  /**
   * Batch load multiple tiles, merging adjacent byte ranges into fewer requests.
   */
  private batchLoadTiles(keys: number[]): void {
    if (!this.index) return

    // Resolve entries and filter already loading/cached
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const key of keys) {
      if (this.tileCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
      const entry = this.index.entryByHash.get(key)
      if (!entry) continue

      // Full-cover tiles with no data: upload quad immediately, skip fetch
      if ((entry.flags & TILE_FLAG_FULL_COVER) && entry.compactSize === 0) {
        this.uploadFullCoverTile(key, entry, new Float32Array(0), new Uint32Array(0))
        continue
      }

      entries.push({ key, entry })
    }

    if (entries.length === 0) return

    if (this.decompressedTiles && this.fileBuf) {
      for (const { key, entry } of entries) {
        this.loadingTiles.add(key)
        const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
        const cached = this.decompressedTiles.get(entry.tileHash)
        if (cached) {
          const tile = parseGPUReadyTile(cached, { ...entry, dataOffset: 0, compactSize: cached.byteLength })
          if (isFullCover) {
            this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
          } else {
            this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
          }
          this.loadingTiles.delete(key)
        } else {
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          decompressTileData(slice).then(result => {
            this.decompressedTiles!.set(entry.tileHash, result)
            const tile = parseGPUReadyTile(result, { ...entry, dataOffset: 0, compactSize: result.byteLength })
            if (isFullCover) {
              this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
            } else {
              this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
            }
            this.loadingTiles.delete(key)
          }).catch(() => { this.loadingTiles.delete(key) })
        }
      }
      return
    }

    if (!this.fileUrl) return

    // Sort by file offset for merging
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)

    // Group consecutive entries into batches (merge if gap < 1KB)
    const MAX_GAP = 1024
    const batches: { entries: typeof entries; startOffset: number; endOffset: number }[] = []
    let current = {
      entries: [entries[0]],
      startOffset: entries[0].entry.dataOffset,
      endOffset: entries[0].entry.dataOffset + entries[0].entry.compactSize,
    }

    for (let i = 1; i < entries.length; i++) {
      const e = entries[i]
      const eEnd = e.entry.dataOffset + e.entry.compactSize
      if (e.entry.dataOffset - current.endOffset <= MAX_GAP) {
        // Merge into current batch
        current.entries.push(e)
        current.endOffset = Math.max(current.endOffset, eEnd)
      } else {
        batches.push(current)
        current = { entries: [e], startOffset: e.entry.dataOffset, endOffset: eEnd }
      }
    }
    batches.push(current)

    // Fetch each batch as a single Range Request
    for (const batch of batches) {
      for (const { key } of batch.entries) {
        this.loadingTiles.add(key)
      }

      const size = batch.endOffset - batch.startOffset
      if (size <= 0) continue

      fetchRange(this.fileUrl, batch.startOffset, size).then(buf => {
        for (const { key, entry } of batch.entries) {
          const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
          const localOffset = entry.dataOffset - batch.startOffset
          const localSize = entry.compactSize
          const compressed = buf.slice(localOffset, localOffset + localSize)
          decompressTileData(compressed).then(decompressed => {
            const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
            if (isFullCover) {
              this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
            } else {
              this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
            }
            this.loadingTiles.delete(key)
          }).catch(err => {
            console.warn(`[X-GIS] Tile ${key} decompress failed:`, err)
            this.loadingTiles.delete(key)
          })
        }
      }).catch(() => {
        for (const { key } of batch.entries) {
          this.loadingTiles.delete(key)
        }
      })
    }
  }

  /**
   * Prefetch tiles 1 step beyond visible bounds for smoother panning.
   */
  private prefetchAdjacent(visibleTiles: { z: number; x: number; y: number }[], zoom: number): void {
    if (!this.index || visibleTiles.length === 0) return

    // Find visible bounds in tile coordinates
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const t of visibleTiles) {
      if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x
      if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y
    }

    // Expand by 1 tile in each direction
    const n = Math.pow(2, zoom)
    const prefetchKeys: number[] = []

    for (let x = Math.max(0, minX - 1); x <= Math.min(n - 1, maxX + 1); x++) {
      for (let y = Math.max(0, minY - 1); y <= Math.min(n - 1, maxY + 1); y++) {
        // Only prefetch border tiles (not already visible)
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue
        const key = tileKey(zoom, x, y)
        if (!this.tileCache.has(key) && !this.loadingTiles.has(key) && this.index.entryByHash.has(key)) {
          prefetchKeys.push(key)
        }
      }
    }

    if (prefetchKeys.length > 0 && this.loadingTiles.size < MAX_CONCURRENT_LOADS) {
      this.batchLoadTiles(prefetchKeys.slice(0, MAX_CONCURRENT_LOADS - this.loadingTiles.size))
    }
  }

  private ensureTileLoaded(key: number): void {
    if (this.tileCache.has(key) || this.loadingTiles.has(key)) return
    if (!this.index) return
    if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) return // throttle

    const entry = this.index.entryByHash.get(key)
    if (!entry) return

    this.loadingTiles.add(key)
    const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)

    if (this.decompressedTiles && this.fileBuf) {
      let decompressed = this.decompressedTiles.get(entry.tileHash)
      if (decompressed) {
        const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
        if (isFullCover) {
          this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
        } else {
          this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        }
        this.loadingTiles.delete(key)
      } else {
        const slice = this.fileBuf.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
        decompressTileData(slice).then(result => {
          this.decompressedTiles!.set(entry.tileHash, result)
          const tile = parseGPUReadyTile(result, { ...entry, dataOffset: 0, compactSize: result.byteLength })
          if (isFullCover) {
            this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
          } else {
            this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
          }
          this.loadingTiles.delete(key)
        }).catch(() => { this.loadingTiles.delete(key) })
      }
    } else if (this.fileUrl) {
      const fetchOffset = entry.dataOffset
      const fetchSize = entry.compactSize
      if (fetchSize === 0 && !isFullCover) { this.loadingTiles.delete(key); return }

      if (isFullCover && fetchSize === 0) {
        // Full-cover with no line data — just generate quad
        this.uploadFullCoverTile(key, entry, new Float32Array(0), new Uint32Array(0))
        this.loadingTiles.delete(key)
        return
      }

      fetchRange(this.fileUrl, fetchOffset, fetchSize).then(compressed =>
        decompressTileData(compressed)
      ).then(decompressed => {
        const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
        if (isFullCover) {
          this.uploadFullCoverTile(key, entry, tile.lineVertices, tile.lineIndices)
        } else {
          this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        }
        this.loadingTiles.delete(key)
      }).catch(() => {
        this.loadingTiles.delete(key)
      })
    }
  }

  private lastBindGroupLayout: GPUBindGroupLayout | null = null

  /** Full-cover tile: generate a quad covering the tile bounds instead of tessellated polygons */
  private uploadFullCoverTile(
    key: number,
    entry: TileIndexEntry,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
  ): void {
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWidth = 360 / tn
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileHeight = tileNorth - tileSouth
    const fid = entry.fullCoverFeatureId

    // 4 vertices (tile-local coords), 2 triangles
    const vertices = new Float32Array([
      0,         0,          fid,
      tileWidth, 0,          fid,
      tileWidth, tileHeight, fid,
      0,         tileHeight, fid,
    ])
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3])

    this.uploadTile(key, vertices, indices, lineVertices, lineIndices)
  }

  private uploadTile(
    key: number,
    vertices: Float32Array,
    indices: Uint32Array,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
  ): void {
    const vertexBuffer = this.device.createBuffer({
      size: Math.max(vertices.byteLength, 12),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, vertices)

    const indexBuffer = this.device.createBuffer({
      size: Math.max(indices.byteLength, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(indexBuffer, 0, indices)

    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    if (lineVertices.length > 0) {
      lineVertexBuffer = this.device.createBuffer({
        size: lineVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(lineVertexBuffer, 0, lineVertices)

      lineIndexBuffer = this.device.createBuffer({
        size: lineIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(lineIndexBuffer, 0, lineIndices)
    }

    // Per-tile uniform buffer + bind group (for tile_origin)
    const uniformBuffer = this.device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Compute tile bounds for tile_origin
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI

    // Use feature bind group layout if storage buffer exists, else standard
    const layout = (this.featureBindGroupLayout && this.featureDataBuffer)
      ? this.featureBindGroupLayout
      : this.lastBindGroupLayout
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniformBuffer } }]
    if (this.featureBindGroupLayout && this.featureDataBuffer) {
      entries.push({ binding: 1, resource: { buffer: this.featureDataBuffer } })
    }
    const bindGroup = layout
      ? this.device.createBindGroup({ layout, entries })
      : null!

    this.tileCache.set(key, {
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
      lineVertexBuffer,
      lineIndexBuffer,
      lineIndexCount: lineIndices.length,
      lastUsedFrame: this.frameCount,
      uniformBuffer,
      bindGroup,
      tileWest, tileSouth,
      tileWidth: tileEast - tileWest,
      tileHeight: tileNorth - tileSouth,
    })
  }

  private evictTiles(): void {
    if (this.tileCache.size <= MAX_CACHED_TILES) return

    // Protect stable zoom tiles from eviction
    const protectedKeys = new Set(this.stableKeys)

    const entries = [...this.tileCache.entries()]
      .filter(([key]) => !protectedKeys.has(key))
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame)

    const toEvict = this.tileCache.size - MAX_CACHED_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const [key, tile] = entries[i]
      tile.vertexBuffer.destroy()
      tile.indexBuffer.destroy()
      tile.lineVertexBuffer?.destroy()
      tile.lineIndexBuffer?.destroy()
      tile.uniformBuffer.destroy()
      this.tileCache.delete(key)
    }
  }
}

// ═══ Helpers ═══

// Cache for full-file fallback when server doesn't support Range requests
let fullFileCache: { url: string; buf: ArrayBuffer } | null = null

async function fetchRange(url: string, offset: number, length: number): Promise<ArrayBuffer> {
  // If we already have the full file cached (server doesn't support Range), use it
  if (fullFileCache && fullFileCache.url === url) {
    return fullFileCache.buf.slice(offset, offset + length)
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  })
  const buf = await res.arrayBuffer()

  // If server returned full file (200) instead of partial (206), cache it
  if (res.status === 200 && buf.byteLength > length) {
    fullFileCache = { url, buf }
    return buf.slice(offset, offset + length)
  }
  return buf
}

function parseHexColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}
