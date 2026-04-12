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
  clipPolygonToRect,
  type XGVTIndex, type TileIndexEntry,
  type PropertyTable, type RingPolygon,
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
  uniformBuffer: GPUBuffer
  bindGroup: GPUBindGroup
  tileWest: number
  tileSouth: number
  tileWidth: number
  tileHeight: number
  // CPU-side data for runtime sub-tile clipping during overzoom
  cpuVertices: Float32Array
  cpuIndices: Uint32Array
  cpuLineVertices: Float32Array
  cpuLineIndices: Uint32Array
  tileZoom: number
  /** Original polygon rings for runtime sub-tiling during overzoom */
  polygons?: RingPolygon[]
}

const MAX_CACHED_TILES = 512
const MAX_CONCURRENT_LOADS = 32  // .xgvt supports parallel Range Requests

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

  // Track per-frame actual draw counts (after overzoom clipping)
  private renderedDraws = new Map<number, { polyCount: number; lineCount: number; vertexCount: number }>()

  /** Get draw stats for tiles rendered THIS frame (reflects clipping) */
  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const [, counts] of this.renderedDraws) {
      vertices += counts.vertexCount
      if (counts.polyCount > 0) { drawCalls++; triangles += Math.floor(counts.polyCount / 3) }
      if (counts.lineCount > 0) { drawCalls++; lines += Math.floor(counts.lineCount / 2) }
    }
    return { drawCalls, vertices, triangles, lines, tilesVisible: this.renderedDraws.size }
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
    fillPipelineFallback?: GPURenderPipeline,
    linePipelineFallback?: GPURenderPipeline,
  ): void {
    if (!this.index) return
    this.frameCount++
    this.renderedDraws.clear()

    const { centerX, centerY, zoom } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)

    // Overzoom: clamp tile zoom to max available, camera zoom is unlimited
    // (tile-local coordinates + per-tile bind groups ensure f32 precision at any zoom)
    const maxLevel = this.index.header.maxLevel
    const maxSubTileZ = maxLevel + 6  // allow overzoom sub-tiles up to +6 levels
    const currentZ = Math.max(0, Math.min(maxSubTileZ, Math.round(camera.zoom)))

    // Track zoom changes (no abort — let all fetches complete, LRU manages memory)
    if (currentZ !== this.lastZoom) {
      this.lastZoom = currentZ
    }

    const tiles = visibleTiles(centerLon, centerLat, currentZ, canvasWidth, canvasHeight, camera.zoom)
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

    // 1. For uncached positions: try sub-tile generation or find fallback ancestor
    const fallbackKeys: number[] = []
    const toLoad: number[] = []

    for (let i = 0; i < tiles.length; i++) {
      const key = neededKeys[i]
      if (this.tileCache.has(key)) continue

      let parentKey = key
      let foundCached = false
      let closestExisting = -1
      let hasAnyAncestor = false

      for (let pz = currentZ - 1; pz >= 0; pz--) {
        parentKey = parentKey >>> 2
        if (this.index.entryByHash.has(parentKey)) hasAnyAncestor = true
        if (this.tileCache.has(parentKey)) {
          // Try generating sub-tile from cached parent (overzoom)
          if (currentZ > maxLevel) {
            // Always generate sub-tile (even if empty — caches "no data here"
            // so the parent tile doesn't fallback-render its entire geometry)
            this.generateSubTile(key, parentKey)
            foundCached = true
          } else {
            fallbackKeys.push(parentKey)
            foundCached = true
          }
          break
        }
        if (closestExisting < 0 && this.index.entryByHash.has(parentKey)) {
          closestExisting = parentKey
        }
      }

      if (!hasAnyAncestor && !this.index.entryByHash.has(key)) continue

      if (!this.index.entryByHash.has(key) && closestExisting >= 0 && !foundCached) {
        toLoad.push(closestExisting)
      }
    }

    // 2. Render current zoom tiles FIRST (stencil writes 1 where drawn)
    // Use projCenterLon/Lat for tile_rtc (must match shader uniform proj_params)
    pass.setStencilReference(1)
    this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, null!, uniformBuffer, uniformData, projCenterLon, projCenterLat)

    // 3. Render fallback ancestors with stencil test (only where stencil=0, not covered by children)
    if (fillPipelineFallback && fallbackKeys.length > 0) {
      pass.setStencilReference(0)
      const uniqueFallbacks = [...new Set(fallbackKeys)]
      this.renderTileKeys(uniqueFallbacks, pass, fillPipelineFallback, linePipelineFallback!, null!, uniformBuffer, uniformData, projCenterLon, projCenterLat)
    }

    // Load missing tiles
    const missing = neededKeys
      .filter(k => !this.tileCache.has(k) && !this.loadingTiles.has(k) && this.index.entryByHash.has(k))
    const ancestorsToLoad = toLoad.filter(k => !this.tileCache.has(k) && !this.loadingTiles.has(k))
    const allToLoad = [...new Set([...missing, ...ancestorsToLoad])]
    if (allToLoad.length > 0) {
      this.batchLoadTiles(allToLoad)
    }

    // Prefetch: adjacent + next zoom (zoom in) + prev zoom (zoom out)
    this.prefetchAdjacent(tiles, currentZ)
    this.prefetchNextZoom(centerLon, centerLat, currentZ, canvasWidth, canvasHeight, camera.zoom)
    if (currentZ > 0) {
      this.prefetchNextZoom(centerLon, centerLat, currentZ - 2, canvasWidth, canvasHeight, camera.zoom)
    }

    // LRU eviction
    this.evictTiles()
  }

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
      if (this.renderedDraws.has(key)) continue
      const cached = this.tileCache.get(key)
      if (!cached || !cached.bindGroup) continue

      cached.lastUsedFrame = this.frameCount

      this.device.queue.writeBuffer(cached.uniformBuffer, 0, sharedUniformData)

      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileX = cached.tileWest * DEG2RAD * R
      const centerX = projCenterLon * DEG2RAD * R
      // proj_params.x is in sharedUniformData at offset 96
      const currentProjType = new Float32Array(sharedUniformData, 96, 1)[0]
      const tileY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + cached.tileSouth * DEG2RAD / 2)) * R  // Mercator
        : cached.tileSouth * DEG2RAD * R  // Equirectangular (linear)
      const centerY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + projCenterLat * DEG2RAD / 2)) * R
        : projCenterLat * DEG2RAD * R

      const tileRtc = new Float32Array([tileX - centerX, tileY - centerY, cached.tileWest, cached.tileSouth])
      this.device.queue.writeBuffer(cached.uniformBuffer, 112, tileRtc)

      // Render full cached tile — GPU viewport clipping handles off-screen geometry
      // TODO: per-tile triangle clipping for overzoom optimization
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

      const vc = (cached.cpuVertices.length / 3) + (cached.cpuLineVertices.length / 3)
      this.renderedDraws.set(key, { polyCount: cached.indexCount, lineCount: cached.lineIndexCount, vertexCount: vc })
    }
  }

  /** Check if any ancestor tile has data for this position */
  private hasAnyAncestorData(key: number, currentZ: number): boolean {
    if (this.index?.entryByHash.has(key)) return true
    let pk = key
    for (let pz = currentZ - 1; pz >= 0; pz--) {
      pk = pk >>> 2
      if (this.index?.entryByHash.has(pk)) return true
    }
    return false
  }

  /**
   * Generate a sub-tile by clipping parent tile's triangles to sub-tile bounds.
   * Each triangle is convex → Sutherland-Hodgman is exact.
   * Result is cached as a new tile entry with its own GPU buffers.
   */
  private generateSubTile(subKey: number, parentKey: number): boolean {
    const parent = this.tileCache.get(parentKey)
    if (!parent || (parent.cpuIndices.length === 0 && parent.cpuLineIndices.length === 0)) return false

    const [sz, sx, sy] = tileKeyUnpack(subKey)
    const sn = Math.pow(2, sz)

    // Sub-tile bounds in absolute degrees
    const subWest = sx / sn * 360 - 180
    const subEast = (sx + 1) / sn * 360 - 180
    const subSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (sy + 1) / sn))) * 180 / Math.PI
    const subNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * sy / sn))) * 180 / Math.PI

    // Convert to parent tile-local coordinates
    const clipW = subWest - parent.tileWest
    const clipE = subEast - parent.tileWest
    const clipS = subSouth - parent.tileSouth
    const clipN = subNorth - parent.tileSouth

    const verts = parent.cpuVertices
    const outV: number[] = []
    const outI: number[] = []

    for (let t = 0; t < parent.cpuIndices.length; t += 3) {
      const i0 = parent.cpuIndices[t], i1 = parent.cpuIndices[t + 1], i2 = parent.cpuIndices[t + 2]
      const x0 = verts[i0 * 3], y0 = verts[i0 * 3 + 1]
      const x1 = verts[i1 * 3], y1 = verts[i1 * 3 + 1]
      const x2 = verts[i2 * 3], y2 = verts[i2 * 3 + 1]
      const fid = verts[i0 * 3 + 2]

      // Fast AABB reject
      const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2)
      const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2)
      if (maxX < clipW || minX > clipE || maxY < clipS || minY > clipN) continue

      // Fast accept: fully inside sub-tile bounds
      if (minX >= clipW && maxX <= clipE && minY >= clipS && maxY <= clipN) {
        const base = outV.length / 3
        outV.push(x0, y0, fid, x1, y1, fid, x2, y2, fid)
        outI.push(base, base + 1, base + 2)
        continue
      }

      // Clip triangle (convex → exact)
      const clipped = clipPolygonToRect([[[x0, y0], [x1, y1], [x2, y2]]], clipW, clipS, clipE, clipN)
      if (clipped.length === 0 || clipped[0].length < 3) continue
      const ring = clipped[0]
      const base = outV.length / 3
      for (const [x, y] of ring) outV.push(x, y, fid)
      for (let j = 1; j < ring.length - 1; j++) outI.push(base, base + j, base + j + 1)
    }

    // ── Line clipping: clip parent line segments to sub-tile bounds ──
    const lineVerts = parent.cpuLineVertices
    const lineIdx = parent.cpuLineIndices
    const outLV: number[] = []
    const outLI: number[] = []

    for (let s = 0; s < lineIdx.length; s += 2) {
      const a = lineIdx[s], b = lineIdx[s + 1]
      const ax = lineVerts[a * 3], ay = lineVerts[a * 3 + 1], afid = lineVerts[a * 3 + 2]
      const bx = lineVerts[b * 3], by = lineVerts[b * 3 + 1]

      // AABB reject
      if (Math.max(ax, bx) < clipW || Math.min(ax, bx) > clipE ||
          Math.max(ay, by) < clipS || Math.min(ay, by) > clipN) continue

      // Fast accept: both endpoints inside
      if (ax >= clipW && ax <= clipE && ay >= clipS && ay <= clipN &&
          bx >= clipW && bx <= clipE && by >= clipS && by <= clipN) {
        const base = outLV.length / 3
        outLV.push(ax, ay, afid, bx, by, afid)
        outLI.push(base, base + 1)
        continue
      }

      // Liang-Barsky parametric clip
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

    // Empty sub-tiles are still cached (with zero geometry) to prevent
    // parent tile fallback rendering entire coastlines for ocean areas.

    // Upload as new cache entry (parent coordinates, parent bindGroup layout)
    const vertices = new Float32Array(outV)
    const indices = new Uint32Array(outI)
    const clippedLineVerts = new Float32Array(outLV)
    const clippedLineIdx = new Uint32Array(outLI)
    this.uploadTile(subKey, undefined, vertices, indices, clippedLineVerts, clippedLineIdx)

    // Fix sub-tile's tileWest/tileSouth to match PARENT (coordinates are parent-local)
    const cached = this.tileCache.get(subKey)
    if (cached) {
      cached.tileWest = parent.tileWest
      cached.tileSouth = parent.tileSouth
      cached.tileWidth = parent.tileWidth
      cached.tileHeight = parent.tileHeight
    }

    return true
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
            this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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
              this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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
              this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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

  /** Prefetch tiles at the next zoom level for smoother zoom-in transitions */
  private prefetchNextZoom(
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
      if (this.tileCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.index.entryByHash.has(key)) {
        prefetchKeys.push(key)
      }
    }

    if (prefetchKeys.length > 0) {
      const slots = MAX_CONCURRENT_LOADS - this.loadingTiles.size
      if (slots > 0) {
        this.batchLoadTiles(prefetchKeys.slice(0, slots))
      }
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
          this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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
            this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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
          this.uploadTile(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices)
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

    this.uploadTile(key, undefined, vertices, indices, lineVertices, lineIndices)
  }

  private uploadTile(
    key: number,
    polygons?: RingPolygon[],
    vertices: Float32Array,
    indices: Uint32Array,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
  ): void {
    // 3x size headroom for triangle clipping expansion (each tri → up to 7 verts)
    const vertexBuffer = this.device.createBuffer({
      size: Math.max(vertices.byteLength * 3, 12),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, vertices)

    const indexBuffer = this.device.createBuffer({
      size: Math.max(indices.byteLength * 3, 4),
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
      cpuVertices: vertices,
      cpuIndices: indices,
      cpuLineVertices: lineVertices,
      cpuLineIndices: lineIndices,
      tileZoom: tz,
      polygons,
    })
  }

  private evictTiles(): void {
    if (this.tileCache.size <= MAX_CACHED_TILES) return

    // Protect: stable zoom tiles + low-zoom tiles (always needed as fallbacks)
    const protectedKeys = new Set(this.stableKeys)

    const entries = [...this.tileCache.entries()]
      .filter(([key, tile]) => !protectedKeys.has(key) && tile.tileZoom > 4)
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

async function fetchRange(url: string, offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  // If we already have the full file cached (server doesn't support Range), use it
  if (fullFileCache && fullFileCache.url === url) {
    return fullFileCache.buf.slice(offset, offset + length)
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    signal,
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
