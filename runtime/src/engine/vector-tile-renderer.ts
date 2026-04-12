// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from XGVTSource to WebGPU.
// Data loading/caching/sub-tiling is handled by XGVTSource.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTiles, sortByPriority } from '../loader/tiles'
import { tileKey, tileKeyUnpack, type PropertyTable } from '@xgis/compiler'
import type { ShaderVariant } from '@xgis/compiler'
import type { XGVTSource, TileData } from '../data/xgvt-source'

// ═══ Types ═══

interface GPUTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup
  tileWest: number
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  lastUsedFrame: number
  firstShownFrame: number // for fade-in animation
}

const MAX_GPU_TILES = 512

// ═══ Renderer ═══

export class VectorTileRenderer {
  private device: GPUDevice
  private source: XGVTSource | null = null
  private gpuCache = new Map<number, GPUTile>()
  private frameCount = 0
  private lastZoom = -1
  private stableKeys: number[] = []
  private uniformDataBuf = new ArrayBuffer(144)
  private uniformF32 = new Float32Array(this.uniformDataBuf) // reusable view over full uniform
  private tileRtcBuf = new Float32Array(4) // reused per-tile RTC buffer
  private lastBindGroupLayout: GPUBindGroupLayout | null = null
  private cachedFillColor = [0, 0, 0, 0]
  private cachedStrokeColor = [0, 0, 0, 0]
  private cachedShowFill = ''
  private cachedShowStroke = ''
  private currentOpacity = 1.0

  // Global feature data buffer (shared across all tiles)
  private featureDataBuffer: GPUBuffer | null = null
  private featureBindGroupLayout: GPUBindGroupLayout | null = null

  // Per-frame draw stats
  private renderedDraws = new Map<number, { polyCount: number; lineCount: number; vertexCount: number }>()

  // Upload queue: tiles waiting for GPU upload (spread across frames to avoid spikes)
  private uploadQueue: { key: number; data: TileData }[] = []
  private static MAX_UPLOADS_PER_FRAME = 8

  constructor(ctx: GPUContext) {
    this.device = ctx.device
  }

  /** Connect to a data source */
  setSource(source: XGVTSource): void {
    this.source = source
    // Queue tiles for GPU upload instead of uploading immediately
    source.onTileLoaded = (key, data) => {
      this.uploadQueue.push({ key, data })
    }
  }

  /** Process queued tile uploads (called at start of render) */
  private processUploadQueue(): void {
    const limit = VectorTileRenderer.MAX_UPLOADS_PER_FRAME
    let processed = 0
    while (this.uploadQueue.length > 0 && processed < limit) {
      const { key, data } = this.uploadQueue.shift()!
      this.uploadTile(key, data)
      processed++
    }
  }

  /** Flush entire upload queue immediately (for preloaded tiles) */
  flushUploadQueue(bindGroupLayout?: GPUBindGroupLayout): void {
    if (bindGroupLayout) this.lastBindGroupLayout = bindGroupLayout
    while (this.uploadQueue.length > 0) {
      const { key, data } = this.uploadQueue.shift()!
      this.uploadTile(key, data)
    }
  }

  /** Whether data is available */
  hasData(): boolean {
    return this.source?.hasData() ?? false
  }

  getBounds(): [number, number, number, number] | null {
    return this.source?.getBounds() ?? null
  }

  getPropertyTable(): PropertyTable | undefined {
    return this.source?.getPropertyTable()
  }

  hasFeatureData(): boolean {
    return this.featureDataBuffer !== null
  }

  getCacheSize(): number {
    return this.gpuCache.size
  }

  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const [, counts] of this.renderedDraws) {
      vertices += counts.vertexCount
      if (counts.polyCount > 0) { drawCalls++; triangles += Math.floor(counts.polyCount / 3) }
      if (counts.lineCount > 0) { drawCalls++; lines += Math.floor(counts.lineCount / 2) }
    }
    return { drawCalls, vertices, triangles, lines, tilesVisible: this.renderedDraws.size }
  }

  /** Build per-feature GPU storage buffer from PropertyTable */
  buildFeatureDataBuffer(variant: ShaderVariant, featureBindGroupLayout: GPUBindGroupLayout): void {
    const table = this.source?.getPropertyTable()
    if (!table || variant.featureFields.length === 0) return

    this.featureBindGroupLayout = featureBindGroupLayout
    const fieldCount = variant.featureFields.length
    const featureCount = table.values.length
    const data = new Float32Array(featureCount * fieldCount)

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

  /** Upload CPU tile data to GPU buffers */
  private uploadTile(key: number, data: TileData): void {
    if (this.gpuCache.has(key)) return // already uploaded

    const vertexBuffer = this.device.createBuffer({
      size: Math.max(data.vertices.byteLength * 3, 12),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, data.vertices)

    const indexBuffer = this.device.createBuffer({
      size: Math.max(data.indices.byteLength * 3, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(indexBuffer, 0, data.indices)

    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    if (data.lineVertices.length > 0) {
      lineVertexBuffer = this.device.createBuffer({
        size: data.lineVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(lineVertexBuffer, 0, data.lineVertices)

      lineIndexBuffer = this.device.createBuffer({
        size: data.lineIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(lineIndexBuffer, 0, data.lineIndices)
    }

    const uniformBuffer = this.device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

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

    this.gpuCache.set(key, {
      vertexBuffer, indexBuffer,
      indexCount: data.indices.length,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      uniformBuffer, bindGroup,
      tileWest: data.tileWest, tileSouth: data.tileSouth,
      tileWidth: data.tileWidth, tileHeight: data.tileHeight,
      tileZoom: data.tileZoom,
      lastUsedFrame: this.frameCount,
      firstShownFrame: this.frameCount,
    })
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
    fillPipelineFallback?: GPURenderPipeline,
    linePipelineFallback?: GPURenderPipeline,
  ): void {
    if (!this.source?.hasData()) return
    const index = this.source.getIndex()
    if (!index) return

    this.frameCount++
    this.renderedDraws.clear()
    this.lastBindGroupLayout = bindGroupLayout
    this.processUploadQueue()

    const { centerX, centerY } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)

    const maxLevel = this.source.maxLevel
    const maxSubTileZ = maxLevel + 6
    const currentZ = Math.max(0, Math.min(maxSubTileZ, Math.round(camera.zoom)))

    if (currentZ !== this.lastZoom) this.lastZoom = currentZ

    const tiles = visibleTiles(centerLon, centerLat, currentZ, canvasWidth, canvasHeight, camera.zoom)
    const n = Math.pow(2, currentZ)
    const ctX = Math.floor((centerLon + 180) / 360 * n)
    const ctY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
    sortByPriority(tiles, ctX, ctY)

    const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)

    // Cache color parsing — only reparse if show properties changed
    const opacity = show.opacity ?? 1.0
    this.currentOpacity = opacity
    if (show.fill !== this.cachedShowFill) {
      this.cachedShowFill = show.fill ?? ''
      const raw = show.fill ? parseHexColor(show.fill) : null
      this.cachedFillColor[0] = raw ? raw[0] : 0
      this.cachedFillColor[1] = raw ? raw[1] : 0
      this.cachedFillColor[2] = raw ? raw[2] : 0
      this.cachedFillColor[3] = raw ? raw[3] : 0
    }
    if (show.stroke !== this.cachedShowStroke) {
      this.cachedShowStroke = show.stroke ?? ''
      const raw = show.stroke ? parseHexColor(show.stroke) : null
      this.cachedStrokeColor[0] = raw ? raw[0] : 0
      this.cachedStrokeColor[1] = raw ? raw[1] : 0
      this.cachedStrokeColor[2] = raw ? raw[2] : 0
      this.cachedStrokeColor[3] = raw ? raw[3] : 0
    }

    // Write uniforms directly via cached Float32Array view (no new typed array allocations)
    const uf = this.uniformF32
    uf.set(mvp, 0) // offset 0: mvp (16 floats)
    uf[16] = this.cachedFillColor[0]; uf[17] = this.cachedFillColor[1]
    uf[18] = this.cachedFillColor[2]; uf[19] = this.cachedFillColor[3] * opacity
    uf[20] = this.cachedStrokeColor[0]; uf[21] = this.cachedStrokeColor[1]
    uf[22] = this.cachedStrokeColor[2]; uf[23] = this.cachedStrokeColor[3] * opacity
    uf[24] = projType; uf[25] = projCenterLon; uf[26] = projCenterLat; uf[27] = 0

    // Avoid tiles.map() allocation — compute keys inline
    const neededKeys: number[] = []
    for (let i = 0; i < tiles.length; i++) {
      neededKeys.push(tileKey(tiles[i].z, tiles[i].x, tiles[i].y))
    }
    const fallbackKeys: number[] = []
    const toLoad: number[] = []

    for (let i = 0; i < tiles.length; i++) {
      const key = neededKeys[i]
      if (this.gpuCache.has(key)) continue

      // Check if source has CPU data ready → upload to GPU
      if (this.source.hasTileData(key)) {
        this.uploadTile(key, this.source.getTileData(key)!)
        continue
      }

      let parentKey = key
      let foundCached = false
      let closestExisting = -1
      let hasAnyAncestor = false

      for (let pz = currentZ - 1; pz >= 0; pz--) {
        parentKey = parentKey >>> 2
        if (this.source.hasEntryInIndex(parentKey)) hasAnyAncestor = true

        if (this.gpuCache.has(parentKey) || this.source.hasTileData(parentKey)) {
          // Ensure parent is on GPU
          if (!this.gpuCache.has(parentKey)) {
            this.uploadTile(parentKey, this.source.getTileData(parentKey)!)
          }

          if (currentZ > maxLevel) {
            this.source.generateSubTile(key, parentKey)
            // Sub-tile auto-uploaded via onTileLoaded callback
            foundCached = true
          } else {
            fallbackKeys.push(parentKey)
            foundCached = true
          }
          break
        }

        if (closestExisting < 0 && this.source.hasEntryInIndex(parentKey)) {
          closestExisting = parentKey
        }
      }

      if (!hasAnyAncestor && !this.source.hasEntryInIndex(key)) continue

      if (!foundCached) {
        if (this.source.hasEntryInIndex(key)) {
          toLoad.push(key)
        } else if (closestExisting >= 0) {
          toLoad.push(closestExisting)
        }
      }
    }

    // Render current zoom tiles (stencil write)
    pass.setStencilReference(1)
    this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, this.uniformDataBuf, projCenterLon, projCenterLat)

    // Render fallback ancestors (stencil test) — dedup via renderedDraws check in renderTileKeys
    if (fillPipelineFallback && fallbackKeys.length > 0) {
      pass.setStencilReference(0)
      this.renderTileKeys(fallbackKeys, pass, fillPipelineFallback, linePipelineFallback!, this.uniformDataBuf, projCenterLon, projCenterLat)
    }

    // Request missing tiles — prioritize parents first (ensures fallback is ready)
    const parentKeys: number[] = []
    for (let i = 0; i < neededKeys.length; i++) {
      const k = neededKeys[i]
      if (!this.gpuCache.has(k) && !this.source!.isLoading(k) && this.source!.hasEntryInIndex(k)) {
        toLoad.push(k)
      }
      // Ensure parent tiles (z-1, z-2) are loaded for smooth fallback
      let pk = k
      for (let pz = 0; pz < 2 && pk > 0; pz++) {
        pk = pk >>> 2
        if (!this.gpuCache.has(pk) && !this.source!.isLoading(pk) && !this.source!.hasTileData(pk) && this.source!.hasEntryInIndex(pk)) {
          parentKeys.push(pk)
        }
      }
    }
    // Load parents first, then current zoom tiles
    if (parentKeys.length > 0) this.source.requestTiles(parentKeys)
    if (toLoad.length > 0) this.source.requestTiles(toLoad)

    // Prefetch adjacent + next zoom (every 10th frame)
    if (this.frameCount % 10 === 0) {
      this.source.prefetchAdjacent(tiles, currentZ)
    }

    // GPU cache eviction
    if (this.gpuCache.size > MAX_GPU_TILES) this.evictGPUTiles()
  }

  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    sharedUniformData: ArrayBuffer,
    projCenterLon: number,
    projCenterLat: number,
  ): void {
    for (const key of keys) {
      if (this.renderedDraws.has(key)) continue
      const cached = this.gpuCache.get(key)
      if (!cached || !cached.bindGroup) continue

      cached.lastUsedFrame = this.frameCount

      // Fade-in: ramp opacity from 0 to 1 over ~10 frames
      const fadeFrames = 10
      const age = this.frameCount - cached.firstShownFrame
      const fadeAlpha = Math.min(1.0, age / fadeFrames)

      // Apply fade to fill/stroke alpha (indices 19 and 23)
      const baseFillA = this.cachedFillColor[3] * (this.currentOpacity ?? 1.0)
      const baseStrokeA = this.cachedStrokeColor[3] * (this.currentOpacity ?? 1.0)
      this.uniformF32[19] = baseFillA * fadeAlpha
      this.uniformF32[23] = baseStrokeA * fadeAlpha

      // Compute tile_rtc directly into the uniform buffer at offset 28 (index 28-31)
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileX = cached.tileWest * DEG2RAD * R
      const centerX = projCenterLon * DEG2RAD * R
      const currentProjType = this.uniformF32[24]
      const tileY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + cached.tileSouth * DEG2RAD / 2)) * R
        : cached.tileSouth * DEG2RAD * R
      const centerY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + projCenterLat * DEG2RAD / 2)) * R
        : projCenterLat * DEG2RAD * R

      // Write tile_rtc into shared buffer, then single writeBuffer for everything
      this.uniformF32[28] = tileX - centerX
      this.uniformF32[29] = tileY - centerY
      this.uniformF32[30] = cached.tileWest
      this.uniformF32[31] = cached.tileSouth
      this.device.queue.writeBuffer(cached.uniformBuffer, 0, this.uniformDataBuf)

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

      const vc = cached.indexCount + cached.lineIndexCount
      this.renderedDraws.set(key, { polyCount: cached.indexCount, lineCount: cached.lineIndexCount, vertexCount: vc })
    }
  }

  private evictGPUTiles(): void {
    if (this.gpuCache.size <= MAX_GPU_TILES) return

    const protectedKeys = new Set(this.stableKeys)
    const entries = [...this.gpuCache.entries()]
      .filter(([key, tile]) => !protectedKeys.has(key) && tile.tileZoom > 4)
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame)

    const toEvict = this.gpuCache.size - MAX_GPU_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const [key, tile] = entries[i]
      tile.vertexBuffer.destroy()
      tile.indexBuffer.destroy()
      tile.lineVertexBuffer?.destroy()
      tile.lineIndexBuffer?.destroy()
      tile.uniformBuffer.destroy()
      this.gpuCache.delete(key)
    }
  }
}

// ═══ Helpers ═══

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
