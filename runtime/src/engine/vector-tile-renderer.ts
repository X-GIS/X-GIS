// ═══ Vector Tile Renderer ═══
// Renders pre-tiled vector data from .xgvt files.
// COG-style: loads index first, then fetches tiles on demand via Range Request.
// LRU cache with Morton-keyed spatial coherence.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTiles, sortByPriority } from '../loader/tiles'
import {
  parseXGVTIndex, parseGPUReadyTile,
  tileKey, tileKeyParent,
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

const MAX_CACHED_TILES = 256
const MAX_CONCURRENT_LOADS = 6

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
    const currentZ = Math.max(0, Math.min(14, Math.round(zoom)))

    // Cancel loading for previous zoom
    if (currentZ !== this.lastZoom) {
      this.loadingTiles.clear()
      this.lastZoom = currentZ
    }

    const tiles = visibleTiles(centerLon, centerLat, zoom, canvasWidth, canvasHeight)
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

    const uniformData = new ArrayBuffer(128)
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set(fillColor)
    new Float32Array(uniformData, 80, 4).set(strokeColor)
    new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
    this.device.queue.writeBuffer(uniformBuffer, 0, uniformData)

    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })

    // Render exact-zoom tiles only (no parent fallback — prevents alpha overlap)
    for (const coord of tiles) {
      const key = tileKey(coord.z, coord.x, coord.y)
      const cached = this.tileCache.get(key)

      if (cached) {
        cached.lastUsedFrame = this.frameCount

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
      } else {
        this.ensureTileLoaded(key)
      }
    }

    // LRU eviction
    this.evictTiles()
  }

  private ensureTileLoaded(key: number): void {
    if (this.tileCache.has(key) || this.loadingTiles.has(key)) return
    if (!this.index) return
    if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) return // throttle

    const entry = this.index.entryByHash.get(key)
    if (!entry) return

    this.loadingTiles.add(key)

    if (this.fileBuf) {
      // Synchronous: full file already in memory
      const tile = parseGPUReadyTile(this.fileBuf, entry)
      this.uploadTile(key, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
      this.loadingTiles.delete(key)
    } else if (this.fileUrl) {
      // Async: Range Request for compact layer (or GPU-ready if available)
      const fetchOffset = entry.dataOffset
      const fetchSize = entry.gpuReadySize > 0
        ? entry.compactSize + entry.gpuReadySize  // both layers
        : entry.compactSize                        // compact only
      if (fetchSize === 0) { this.loadingTiles.delete(key); return }

      fetchRange(this.fileUrl, fetchOffset, fetchSize).then(buf => {
        const tile = parseGPUReadyTile(buf, { ...entry, dataOffset: 0 })
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

    const entries = [...this.tileCache.entries()]
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
