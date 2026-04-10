// ═══ Vector Tile Renderer ═══
// Renders pre-tiled vector data from .xgvt files.
// COG-style: loads index first, then fetches tiles on demand via Range Request.
// LRU cache with Morton-keyed spatial coherence.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTiles, sortByPriority } from '../loader/tiles'
import {
  parseXGVTIndex, parseGPUReadyTile, decompressTileData,
  tileKey, tileKeyUnpack,
  type XGVTIndex, type TileIndexEntry,
} from '@xgis/compiler'

// ═══ Types ═══

interface CachedVectorTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  lastUsedFrame: number
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
  private frameCount = 0
  private lastZoom = -1

  // Zoom transition state: keep previous zoom visible until new zoom fully loaded
  private stableZoom = -1
  private stableKeys: number[] = []        // tile keys that were fully rendered at stableZoom
  private zoomAbortController: AbortController | null = null

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

  /** Load from a full ArrayBuffer (local file or pre-fetched) */
  loadFromBuffer(buf: ArrayBuffer): void {
    this.fileBuf = buf
    this.index = parseXGVTIndex(buf)
    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles, bounds: [${this.index.header.bounds.map(b => b.toFixed(1)).join(', ')}]`)
  }

  /** Load from URL (Range Request mode) */
  async loadFromURL(url: string): Promise<void> {
    this.fileUrl = url

    // Fetch header (32 bytes)
    const headerBuf = await fetchRange(url, 0, 32)
    const view = new DataView(headerBuf)
    const indexOffset = view.getUint32(24, true)
    const indexLength = view.getUint32(28, true)

    // Fetch index
    const indexBuf = await fetchRange(url, 0, indexOffset + indexLength)
    this.index = parseXGVTIndex(indexBuf)
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

    const { centerX, centerY, zoom } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    // Overzoom: clamp to max available level in the .xgvt file
    const maxLevel = this.index.header.maxLevel
    const currentZ = Math.max(0, Math.min(maxLevel, Math.round(zoom)))

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

    const uniformData = new ArrayBuffer(144)
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set(fillColor)
    new Float32Array(uniformData, 80, 4).set(strokeColor)
    new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
    // tile_origin is set per-tile in renderTileKeys
    this.device.queue.writeBuffer(uniformBuffer, 0, uniformData)

    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })

    // Check how many visible tiles are cached at current zoom
    const neededKeys = tiles.map(c => tileKey(c.z, c.x, c.y))
    const cachedCount = neededKeys.filter(k => this.tileCache.has(k)).length
    const allCached = cachedCount === neededKeys.length

    // Decide what to render
    if (allCached || this.stableZoom < 0) {
      // All tiles ready (or first load): render current zoom
      this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, bindGroup, uniformBuffer, uniformData)
      this.stableZoom = currentZ
      this.stableKeys = neededKeys
    } else if (currentZ !== this.stableZoom && cachedCount < neededKeys.length) {
      // Zoom transitioning: render STABLE zoom tiles while loading new zoom
      this.renderTileKeys(this.stableKeys, pass, fillPipeline, linePipeline, bindGroup, uniformBuffer, uniformData)

      // Also render any new-zoom tiles that are already loaded (progressive reveal)
      const newReady = neededKeys.filter(k => this.tileCache.has(k))
      if (newReady.length > 0) {
        this.renderTileKeys(newReady, pass, fillPipeline, linePipeline, bindGroup, uniformBuffer, uniformData)
      }

      // When all new tiles loaded, swap to new zoom
      if (allCached) {
        this.stableZoom = currentZ
        this.stableKeys = neededKeys
      }
    } else {
      // Same zoom, some tiles missing (panning): render what we have
      this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, bindGroup, uniformBuffer, uniformData)
      this.stableKeys = neededKeys
    }

    // Load missing tiles
    const missing = neededKeys.filter(k => !this.tileCache.has(k) && !this.loadingTiles.has(k))
    if (missing.length > 0) {
      this.batchLoadTiles([...new Set(missing)])
    }

    // Prefetch adjacent tiles
    this.prefetchAdjacent(tiles, currentZ)

    // LRU eviction
    this.evictTiles()
  }

  /** Render a list of tile keys (draws cached tiles, skips missing) */
  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    uniformBuffer: GPUBuffer,
    uniformData: ArrayBuffer,
  ): void {
    for (const key of keys) {
      const cached = this.tileCache.get(key)
      if (!cached) continue

      cached.lastUsedFrame = this.frameCount

      // Write tile origin (west, south) to uniform
      const [tz, tx, ty] = tileKeyUnpack(key)
      const tn = Math.pow(2, tz)
      const tileWest = tx / tn * 360 - 180
      const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
      new Float32Array(uniformData, 112, 4).set([tileWest, tileSouth, 0, 0])
      this.device.queue.writeBuffer(uniformBuffer, 0, uniformData)

      if (cached.indexCount > 0) {
        pass.setPipeline(fillPipeline)
        pass.setBindGroup(0, bindGroup)
        pass.setVertexBuffer(0, cached.vertexBuffer)
        pass.setIndexBuffer(cached.indexBuffer, 'uint32')
        pass.drawIndexed(cached.indexCount)
      }

      if (cached.lineIndexCount > 0 && cached.lineVertexBuffer && cached.lineIndexBuffer) {
        pass.setPipeline(linePipeline)
        pass.setBindGroup(0, bindGroup)
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
      entries.push({ key, entry })
    }

    if (entries.length === 0) return

    if (this.fileBuf) {
      // Full file in memory — decompress each tile async
      for (const { key, entry } of entries) {
        this.loadingTiles.add(key)
        const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
        decompressTileData(slice).then(decompressed => {
          const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
          this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
          this.loadingTiles.delete(key)
        }).catch(() => { this.loadingTiles.delete(key) })
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
          const localOffset = entry.dataOffset - batch.startOffset
          const localSize = entry.compactSize
          const tileBuf = buf.slice(localOffset, localOffset + localSize)
          const tile = parseGPUReadyTile(tileBuf, { ...entry, dataOffset: 0 })
          this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
          this.loadingTiles.delete(key)
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

    if (this.fileBuf) {
      // Full file in memory — extract compressed tile, decompress, parse
      const compressedSlice = this.fileBuf.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
      decompressTileData(compressedSlice).then(decompressed => {
        const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
        this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        this.loadingTiles.delete(key)
      }).catch(() => { this.loadingTiles.delete(key) })
    } else if (this.fileUrl) {
      // Range Request — fetch compressed tile, decompress, parse
      const fetchOffset = entry.dataOffset
      const fetchSize = entry.compactSize
      if (fetchSize === 0) { this.loadingTiles.delete(key); return }

      fetchRange(this.fileUrl, fetchOffset, fetchSize).then(compressed =>
        decompressTileData(compressed)
      ).then(decompressed => {
        const tile = parseGPUReadyTile(decompressed, { ...entry, dataOffset: 0, compactSize: decompressed.byteLength })
        this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
        this.loadingTiles.delete(key)
      }).catch(() => {
        this.loadingTiles.delete(key)
      })
    }
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

    this.tileCache.set(key, {
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
      lineVertexBuffer,
      lineIndexBuffer,
      lineIndexCount: lineIndices.length,
      lastUsedFrame: this.frameCount,
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
      this.tileCache.delete(key)
    }
  }
}

// ═══ Helpers ═══

async function fetchRange(url: string, offset: number, length: number): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  })
  return res.arrayBuffer()
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
