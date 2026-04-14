// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from XGVTSource to WebGPU.
// Data loading/caching/sub-tiling is handled by XGVTSource.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTilesFrustum, sortByPriority } from '../loader/tiles'
import { tileKey, type PropertyTable } from '@xgis/compiler'
import type { ShaderVariant } from '@xgis/compiler'
import type { XGVTSource, TileData } from '../data/xgvt-source'
import { mercator as mercatorProj } from './projection'
import type { PointRenderer } from './point-renderer'
import { buildLineSegments, type LineRenderer } from './line-renderer'

// ═══ Types ═══

/** Layer draw phase — replaces the prior `translucentLines: boolean` flag.
 *  'all' draws fill + stroke in one pass (opaque default).
 *  'fills'/'strokes' split across a main pass and an offscreen MAX-blend
 *  pass so translucent strokes don't accumulate alpha across overlapping
 *  geometry. 'fills' + 'strokes' together == 'all'. */
export type LayerDrawPhase = 'all' | 'fills' | 'strokes'

interface GPUTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  outlineIndexBuffer: GPUBuffer | null
  outlineIndexCount: number
  // SDF line segment buffers for polygon outlines and line features
  outlineSegmentBuffer: GPUBuffer | null
  outlineSegmentCount: number
  outlineSegmentBindGroup: GPUBindGroup | null
  lineSegmentBuffer: GPUBuffer | null
  lineSegmentCount: number
  lineSegmentBindGroup: GPUBindGroup | null
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

const UNIFORM_SLOT = 256
const UNIFORM_SIZE = 144

export class VectorTileRenderer {
  private device: GPUDevice
  private source: XGVTSource | null = null

  /** Max tile level of the backing source (0 if none), for camera zoom
   *  clamping in the render loop. */
  get sourceMaxLevel(): number {
    return this.source?.maxLevel ?? 0
  }
  currentProjection: import('./projection').Projection | null = null
  private gpuCache = new Map<number, GPUTile>()
  private frameCount = 0
  private lastZoom = -1
  private stableKeys: number[] = []
  private uniformDataBuf = new ArrayBuffer(144)
  private uniformF32 = new Float32Array(this.uniformDataBuf) // reusable view over full uniform
  private lastBindGroupLayout: GPUBindGroupLayout | null = null
  /** Uniform-only layout — stays pinned to the base `bindGroupLayout`
   *  even when `render()` swaps `lastBindGroupLayout` for a variant layout. */
  private baseBindGroupLayout: GPUBindGroupLayout | null = null
  private cachedFillColor = [0, 0, 0, 0]
  private cachedStrokeColor = [0, 0, 0, 0]
  private cachedShowFill = ''
  private cachedShowStroke = ''
  private currentOpacity = 1.0

  // ── Uniform ring (dynamic-offset) ──
  // Shared across all tiles + world copies + layers in a frame. Each draw
  // gets a fresh 256-byte slot, preventing multi-layer writeBuffer clobber.
  private uniformRing: GPUBuffer | null = null
  private uniformRingCapacity = 1024 // slots — 256 KB initial
  private uniformSlot = 0
  /** Tile bind group referencing the ring with dynamic offset (uniform only). */
  private tileBgDefault: GPUBindGroup | null = null
  /** Tile bind group referencing the ring + feature storage (variant shaders). */
  private tileBgFeature: GPUBindGroup | null = null

  // SDF line renderer (set externally)
  private lineRenderer: LineRenderer | null = null

  // Global feature data buffer (shared across all tiles)
  private featureDataBuffer: GPUBuffer | null = null
  private featureBindGroupLayout: GPUBindGroupLayout | null = null

  // Per-frame draw stats
  private renderedDraws = new Map<number, { polyCount: number; lineCount: number; vertexCount: number }>()
  /** Deduped tile-drop warnings. Key format: "<reason>:<z>/<x>/<y>". Once
   *  per session per key; prevents flood when panning/zooming over an area
   *  that has no data at the current level. */
  private tileDropWarnings = new Set<string>()
  private _missedTiles = 0 // tiles with no fallback this frame

  constructor(ctx: GPUContext) {
    this.device = ctx.device
  }

  /** Connect to a data source */
  setSource(source: XGVTSource): void {
    this.source = source
    // Immediate GPU upload — no queue delay, no flickering
    source.onTileLoaded = (key, data) => {
      this.uploadTile(key, data)
    }
  }

  /** Set bind group layout (must be called before tiles arrive) */
  setBindGroupLayout(layout: GPUBindGroupLayout): void {
    this.lastBindGroupLayout = layout
    this.baseBindGroupLayout = layout
    this.ensureUniformRing()
  }

  private ensureUniformRing(): void {
    if (this.uniformRing) return
    this.uniformRing = this.device.createBuffer({
      size: this.uniformRingCapacity * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'vtr-uniform-ring',
    })
    this.rebuildTileBindGroups()
  }

  private rebuildTileBindGroups(): void {
    if (!this.uniformRing || !this.baseBindGroupLayout) return
    this.tileBgDefault = this.device.createBindGroup({
      layout: this.baseBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } }],
    })
    if (this.featureBindGroupLayout && this.featureDataBuffer) {
      this.tileBgFeature = this.device.createBindGroup({
        layout: this.featureBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } },
          { binding: 1, resource: { buffer: this.featureDataBuffer } },
        ],
      })
    } else {
      this.tileBgFeature = null
    }
  }

  beginFrame(): void {
    this.uniformSlot = 0
  }

  private allocUniformSlot(): number {
    if (this.uniformSlot >= this.uniformRingCapacity) this.growUniformRing(this.uniformSlot + 1)
    return this.uniformSlot++ * UNIFORM_SLOT
  }

  private growUniformRing(minSlots: number): void {
    let newCap = this.uniformRingCapacity
    while (newCap < minSlots) newCap *= 2
    this.uniformRing?.destroy()
    this.uniformRingCapacity = newCap
    this.uniformRing = this.device.createBuffer({
      size: newCap * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'vtr-uniform-ring',
    })
    this.rebuildTileBindGroups()
  }

  /** Provide the shared SDF line renderer (set by map.ts after GPU init). */
  setLineRenderer(lr: LineRenderer): void {
    const wasNull = this.lineRenderer === null
    this.lineRenderer = lr
    // If tiles were uploaded before LineRenderer was available they have no
    // segment buffers — force re-upload so outlines/lines render on next frame.
    if (wasNull && this.gpuCache.size > 0) {
      for (const tile of this.gpuCache.values()) {
        tile.vertexBuffer?.destroy()
        tile.indexBuffer?.destroy()
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
      }
      this.gpuCache.clear()
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

  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number; missedTiles: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const [, counts] of this.renderedDraws) {
      vertices += counts.vertexCount
      if (counts.polyCount > 0) { drawCalls++; triangles += Math.floor(counts.polyCount / 3) }
      if (counts.lineCount > 0) { drawCalls++; lines += Math.floor(counts.lineCount / 2) }
    }
    return { drawCalls, vertices, triangles, lines, tilesVisible: this.renderedDraws.size, missedTiles: this._missedTiles }
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

    // Build the shared feature-bound tile bind group
    this.rebuildTileBindGroups()

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

    // Outline indices (polygon edges, reuses polygon vertex buffer)
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineIndexCount = 0
    if (data.outlineIndices && data.outlineIndices.length > 0) {
      outlineIndexBuffer = this.device.createBuffer({
        size: Math.max(data.outlineIndices.byteLength, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(outlineIndexBuffer, 0, data.outlineIndices)
      outlineIndexCount = data.outlineIndices.length
    }

    // SDF line segment buffers (for polygon outlines + line features)
    let outlineSegmentBuffer: GPUBuffer | null = null
    let outlineSegmentCount = 0
    let outlineSegmentBindGroup: GPUBindGroup | null = null
    let lineSegmentBuffer: GPUBuffer | null = null
    let lineSegmentCount = 0
    let lineSegmentBindGroup: GPUBindGroup | null = null
    if (this.lineRenderer) {
      if (data.outlineIndices && data.outlineIndices.length > 0) {
        const segData = buildLineSegments(data.vertices, data.outlineIndices, data.tileSouth, 3, data.tileWidth, data.tileHeight)
        outlineSegmentBuffer = this.lineRenderer.uploadSegmentBuffer(segData)
        outlineSegmentCount = data.outlineIndices.length / 2
        outlineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(outlineSegmentBuffer)
      }
      if (data.lineIndices.length > 0 && data.lineVertices.length > 0) {
        const segData = buildLineSegments(data.lineVertices, data.lineIndices, data.tileSouth, 4, data.tileWidth, data.tileHeight)
        lineSegmentBuffer = this.lineRenderer.uploadSegmentBuffer(segData)
        lineSegmentCount = data.lineIndices.length / 2
        lineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(lineSegmentBuffer)
      }
    }

    this.gpuCache.set(key, {
      vertexBuffer, indexBuffer,
      indexCount: data.indices.length,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      outlineIndexBuffer, outlineIndexCount,
      outlineSegmentBuffer, outlineSegmentCount, outlineSegmentBindGroup,
      lineSegmentBuffer, lineSegmentCount, lineSegmentBindGroup,
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
    _uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    fillPipelineFallback?: GPURenderPipeline,
    linePipelineFallback?: GPURenderPipeline,
    pointRenderer?: PointRenderer | null,
    /** Which draws to emit for this layer.
     *  - 'all':     fills + strokes in the current pass (opaque default)
     *  - 'fills':   polygon fills only (main pass, baked opacity)
     *  - 'strokes': outlines + line features only (offscreen MAX-blend pass) */
    phase: LayerDrawPhase = 'all',
  ): void {
    if (!this.source?.hasData()) return
    const index = this.source.getIndex()
    if (!index) return

    this.frameCount++
    this.source.resetCompileBudget()
    this.renderedDraws.clear()
    this._missedTiles = 0
    this.lastBindGroupLayout = bindGroupLayout
    this.ensureUniformRing()

    const { centerX, centerY } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)

    const maxLevel = this.source.maxLevel
    const maxSubTileZ = maxLevel + 6
    const currentZ = Math.max(0, Math.min(maxSubTileZ, Math.round(camera.zoom)))

    if (currentZ !== this.lastZoom) this.lastZoom = currentZ

    // Quadtree-based frustum selection works at every pitch, including 0.
    // The legacy AABB-based `visibleTiles` path silently drifted from the
    // VTR cache pipeline and broke at low pitch, so it is no longer used.
    const tiles = visibleTilesFrustum(
      camera,
      this.currentProjection ?? mercatorProj,
      currentZ,
      canvasWidth,
      canvasHeight,
    )

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

    // Allocate + write SDF line layer slot for this render() call. All
    // drawSegments() calls below will use this same byte offset.
    // In 'fills' phase no drawSegments runs, so skip the allocation entirely
    // to avoid ring-slot churn, redundant pattern-param warnings, and any
    // incidental validation surface in the translucent fill pre-pass.
    let lineLayerOffset = 0
    if (this.lineRenderer && phase !== 'fills') {
      const strokeWidthPx = show.strokeWidth ?? 1
      const mpp = (40075016.686 / 256) / Math.pow(2, camera.zoom)
      const capMap = { butt: 0, round: 1, square: 2, arrow: 3 } as const
      const joinMap = { miter: 0, round: 1, bevel: 2 } as const
      // Default cap/join = round. Round is a stable circle SDF that fills
      // corners and chain ends correctly at any angle. Miter/bevel require
      // explicit opt-in via `stroke-linejoin-miter` / `stroke-linecap-butt`.
      const cap = capMap[show.linecap ?? 'round']
      const join = joinMap[show.linejoin ?? 'round']
      const miterLimit = show.miterlimit ?? 4.0
      // DSL dash values default to pixels (matching stroke-width convention).
      // Convert to Mercator meters here so the shader's meter-based arc_pos
      // comparison renders the pattern at a consistent on-screen size across
      // zoom levels. TODO: add explicit unit suffixes (20m_10m, 20km_5km) to
      // the parser if real-world length dashes are needed later.
      const dash = (show.dashArray && show.dashArray.length >= 2)
        ? {
            array: show.dashArray.map(v => v * mpp),
            offset: (show.dashOffset ?? 0) * mpp,
          }
        : null



      // Resolve patterns: shape name → registry ID; unit name → flag code.
      const unitMap = { m: 0, px: 1, km: 2, nm: 3 } as const
      const anchorMap = { repeat: 0, start: 1, end: 2, center: 3 } as const
      const patternSlots = (show.patterns ?? [])
        .slice(0, 3)
        .map(p => ({
          shapeId: this.lineRenderer!.resolveShapeId(p.shape),
          spacing: p.spacing,
          spacingUnit: unitMap[p.spacingUnit ?? 'm'],
          size: p.size,
          sizeUnit: unitMap[p.sizeUnit ?? 'm'],
          offset: p.offset ?? 0,
          offsetUnit: unitMap[p.offsetUnit ?? 'm'],
          startOffset: p.startOffset ?? 0,
          anchor: anchorMap[p.anchor ?? 'repeat'],
        }))
        .filter(p => p.shapeId > 0)

      // In translucent mode the offscreen RT must hold the FULL color +
      // stroke alpha (no opacity multiply). The composite step then blends
      // with the layer opacity. Otherwise we'd double-apply opacity.
      // In 'strokes' phase the offscreen RT holds the FULL color + stroke
      // alpha (no opacity multiply). The composite step then blends with the
      // layer opacity — otherwise we'd double-apply it.
      const layerOpacity = phase === 'strokes' ? 1.0 : opacity

      // Resolve stroke alignment to an effective offset. Inset/outset
      // shift by ±half_width; combines additively with explicit
      // stroke-offset-N (so users can fine-tune around the baseline).
      const explicitOffset = show.strokeOffset ?? 0
      const alignDelta = show.strokeAlign === 'inset'
        ? strokeWidthPx / 2
        : show.strokeAlign === 'outset'
          ? -strokeWidthPx / 2
          : 0
      const effectiveOffset = explicitOffset + alignDelta

      lineLayerOffset = this.lineRenderer.writeLayerSlot(
        [this.cachedStrokeColor[0], this.cachedStrokeColor[1], this.cachedStrokeColor[2], this.cachedStrokeColor[3]],
        strokeWidthPx,
        layerOpacity,
        mpp,
        cap,
        join,
        miterLimit,
        dash,
        patternSlots,
        effectiveOffset,
      )
    }

    // Compute tile keys — use wrapped x for data lookup
    const neededKeys: number[] = []
    const worldOffDeg: number[] = [] // per-tile world offset in degrees
    for (let i = 0; i < tiles.length; i++) {
      neededKeys.push(tileKey(tiles[i].z, tiles[i].x, tiles[i].y))
      const ox = tiles[i].ox ?? tiles[i].x
      const tileN = Math.pow(2, tiles[i].z)
      worldOffDeg.push((ox - tiles[i].x) * (360 / tileN))
    }
    const fallbackKeys: number[] = []
    const fallbackOffsets: number[] = []
    const toLoad: number[] = []

    for (let i = 0; i < tiles.length; i++) {
      const key = neededKeys[i]
      if (this.gpuCache.has(key)) continue

      if (this.source.hasTileData(key)) {
        this.uploadTile(key, this.source.getTileData(key)!)
        continue
      }

      let foundCached = false
      let closestExisting = -1
      let hasAnyAncestor = false
      // The nearest parent that is already cached/loaded. Used for fallback
      // draw and sub-tile generation. `-1` if none found.
      let cachedAncestorKey = -1

      // Parent-search must walk from THIS tile's zoom, not currentZ.
      // visibleTilesFrustum returns tiles at multiple levels (LOD for pitched
      // views), so currentZ is wrong as a starting bound.
      //
      // We do a SINGLE full walk (no early break) that collects all three
      // needed facts:
      //   1. hasAnyAncestor — does any ancestor exist in the precomputed index
      //   2. closestExisting — the highest (closest to tile) indexed ancestor
      //   3. cachedAncestorKey — the highest ancestor already cached/loaded
      //
      // Previously the walk broke early on the first cached/loaded ancestor,
      // which meant hasAnyAncestor could stay false if the cached ancestor
      // happened to NOT be in the precomputed index (e.g. a sub-tile that
      // was generated from an even-higher parent in an earlier frame).
      const tileZ = tiles[i].z
      {
        let walkKey = key
        for (let pz = tileZ - 1; pz >= 0; pz--) {
          walkKey = walkKey >>> 2
          if (this.source.hasEntryInIndex(walkKey)) {
            hasAnyAncestor = true
            if (closestExisting < 0) closestExisting = walkKey
          }
          if (cachedAncestorKey < 0 && (this.gpuCache.has(walkKey) || this.source.hasTileData(walkKey))) {
            cachedAncestorKey = walkKey
          }
        }
      }

      if (cachedAncestorKey >= 0) {
        const parentKey = cachedAncestorKey
        if (!this.gpuCache.has(parentKey)) {
          this.uploadTile(parentKey, this.source.getTileData(parentKey)!)
        }

        if (tileZ > maxLevel) {
          // 1. Try compileSingleTile (fast, grid-indexed)
          if (!this.source.compileTileOnDemand(key)) {
            // 2. Budget exceeded — try generateSubTile for small parents.
            //    Skip when the only parent is root (key=1): clipping the
            //    whole world is too expensive and the root fallback below
            //    already covers the region correctly.
            if (parentKey > 1) this.source.generateSubTile(key, parentKey)
          }
          const cachedSub = this.gpuCache.get(key)
          if (cachedSub) {
            foundCached = true
            // Empty sub-tile (clip produced nothing) still gets cached to
            // prevent re-generation, but it writes no stencil and covers
            // no area. Push the parent as a fallback so the region is
            // painted by coarser geometry instead of leaving a hole.
            const hasGeom =
              cachedSub.indexCount > 0 ||
              cachedSub.lineSegmentCount > 0 ||
              cachedSub.outlineSegmentCount > 0
            if (!hasGeom) {
              fallbackKeys.push(parentKey)
              fallbackOffsets.push(worldOffDeg[i])
            }
          } else {
            // 3. Still no tile — parent fallback (guaranteed visual continuity)
            fallbackKeys.push(parentKey)
            fallbackOffsets.push(worldOffDeg[i])
            foundCached = true
          }
        } else {
          fallbackKeys.push(parentKey)
          fallbackOffsets.push(worldOffDeg[i]) // same world offset as the child
          foundCached = true
        }
      }

      if (!hasAnyAncestor && !this.source.hasEntryInIndex(key)) {
        const t = tiles[i]
        const wKey = `no-ancestor:${t.z}/${t.x}/${t.y}`
        if (!this.tileDropWarnings.has(wKey)) {
          this.tileDropWarnings.add(wKey)
          console.warn(`[VTR tile-drop] no ancestor found for ${t.z}/${t.x}/${t.y} — dropping from render (maxLevel=${maxLevel}).`)
        }
        continue
      }

      if (!foundCached) {
        if (this.source.hasEntryInIndex(key)) {
          toLoad.push(key)
        } else if (closestExisting >= 0) {
          toLoad.push(closestExisting)
        }
        this._missedTiles++
      }
    }

    // Request missing tiles BEFORE drawing — on-demand tiles compile synchronously
    // and become available in gpuCache within the same frame
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

    // After on-demand compile, newly available tiles may need upload
    for (const key of toLoad) {
      if (!this.gpuCache.has(key) && this.source!.hasTileData(key)) {
        this.uploadTile(key, this.source!.getTileData(key)!)
      }
    }

    // NOW draw (tiles are guaranteed in gpuCache if they compiled synchronously)

    // Render current zoom tiles (stencil write) — with world copy offsets.
    // Translucent line passes have NO depth/stencil attachment, so skip the
    // stencil reference call there.
    if (phase !== 'strokes') pass.setStencilReference(1)
    this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, phase)

    // Render fallback ancestors (stencil test) — with world offsets for wrapping
    if (fillPipelineFallback && fallbackKeys.length > 0) {
      if (phase !== 'strokes') pass.setStencilReference(0)
      this.renderTileKeys(fallbackKeys, pass, fillPipelineFallback, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, phase)
    }

    // Prefetch adjacent + next zoom (every 10th frame)
    if (this.frameCount % 10 === 0) {
      this.source.prefetchAdjacent(tiles, currentZ)
    }

    // Track stable tile set for eviction protection and point rendering.
    // IMPORTANT: include fallbackKeys too — those tiles' buffers are bound
    // in bind groups used by the draw calls we just recorded. Evicting them
    // now would destroy their buffers before `queue.submit()` runs, causing
    // "Buffer used in submit while destroyed" validation errors.
    if (fallbackKeys.length > 0) {
      const merged = new Set<number>(neededKeys)
      for (const k of fallbackKeys) merged.add(k)
      this.stableKeys = [...merged]
    } else {
      this.stableKeys = neededKeys
    }

    // GPU cache eviction
    if (this.gpuCache.size > MAX_GPU_TILES) this.evictGPUTiles()

    // Render tile-based points via PointRenderer (if available)
    if (pointRenderer && typeof pointRenderer.addTilePoint === 'function') {
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const camMercX = projCenterLon * DEG2RAD * R
      const camClampedLat = Math.max(-85.051129, Math.min(85.051129, projCenterLat))
      const camMercY = Math.log(Math.tan(Math.PI / 4 + camClampedLat * DEG2RAD / 2)) * R

      for (const key of this.stableKeys) {
        const tileData = this.source!.getTileData(key)
        if (!tileData?.pointVertices || tileData.pointVertices.length < 3) continue
        const ptv = tileData.pointVertices
        const tileW = tileData.tileWest
        const tileS = tileData.tileSouth
        for (let i = 0; i < ptv.length; i += 3) {
          const lon = ptv[i] + tileW
          const lat = ptv[i + 1] + tileS
          const mercX = lon * DEG2RAD * R
          const clampLat = Math.max(-85.051129, Math.min(85.051129, lat))
          const mercY = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R
          pointRenderer.addTilePoint(mercX - camMercX, mercY - camMercY, ptv[i + 2])
        }
      }
      pointRenderer.flushTilePoints(pass, camera, projCenterLon, projCenterLat, canvasWidth, canvasHeight, show)
    }
  }

  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    projCenterLon: number,
    projCenterLat: number,
    worldOffsets: number[] | undefined,
    lineLayerOffset: number,
    phase: LayerDrawPhase,
  ): void {
    const drawFills = phase !== 'strokes'
    const drawStrokes = phase !== 'fills'
    const translucentLines = phase === 'strokes'
    const tileBg = this.tileBgFeature ?? this.tileBgDefault
    if (!tileBg || !this.uniformRing) return
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki]
      // For world copies: allow same key to render at different positions
      const worldOff = worldOffsets?.[ki] ?? 0
      const drawKey = worldOff === 0 ? key : key + worldOff * 1000000 // unique draw key per copy
      if (this.renderedDraws.has(drawKey)) continue
      const cached = this.gpuCache.get(key)
      if (!cached) continue

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
      // u.opacity: zoom-interpolated opacity for shader variants
      // (shader variants apply u.opacity themselves, so this is NOT double-applied
      //  because variant fill/stroke exprs use u.opacity instead of pre-multiplied alpha)
      this.uniformF32[32] = (this.currentOpacity ?? 1.0) * fadeAlpha

      // Compute tile_rtc
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileX = (cached.tileWest + worldOff) * DEG2RAD * R
      const centerX = projCenterLon * DEG2RAD * R
      const currentProjType = this.uniformF32[24]
      const MERC_LIMIT = 85.051129
      const clampLat = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      const tileY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + clampLat(cached.tileSouth) * DEG2RAD / 2)) * R
        : cached.tileSouth * DEG2RAD * R
      const centerY = currentProjType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + clampLat(projCenterLat) * DEG2RAD / 2)) * R
        : projCenterLat * DEG2RAD * R

      this.uniformF32[28] = tileX - centerX
      this.uniformF32[29] = tileY - centerY
      this.uniformF32[30] = cached.tileWest
      this.uniformF32[31] = cached.tileSouth

      // Allocate a fresh ring slot for this tile × layer × world-copy draw.
      const slotOffset = this.allocUniformSlot()
      // Ring may have grown in allocUniformSlot — use current (rebuilt) bind groups.
      const currentTileBg = this.tileBgFeature ?? this.tileBgDefault!
      const currentLineTileBg = this.tileBgDefault!
      this.device.queue.writeBuffer(this.uniformRing!, slotOffset, this.uniformDataBuf)

      // Polygon fills — skipped in 'strokes' phase (offscreen line-only RT).
      if (drawFills && cached.indexCount > 0) {
        pass.setPipeline(fillPipeline)
        pass.setBindGroup(0, currentTileBg, [slotOffset])
        pass.setVertexBuffer(0, cached.vertexBuffer)
        pass.setIndexBuffer(cached.indexBuffer, 'uint32')
        pass.drawIndexed(cached.indexCount)
      }

      // Polygon outlines via SDF line renderer — skipped in 'fills' phase.
      if (drawStrokes && this.lineRenderer && cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
        this.lineRenderer.drawSegments(pass, currentLineTileBg, cached.outlineSegmentBindGroup, cached.outlineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
      }

      // Line features via SDF line renderer — skipped in 'fills' phase.
      if (drawStrokes && this.lineRenderer && cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
        this.lineRenderer.drawSegments(pass, currentLineTileBg, cached.lineSegmentBindGroup, cached.lineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
      }

      const vc = cached.indexCount + cached.lineIndexCount
      this.renderedDraws.set(drawKey, { polyCount: cached.indexCount, lineCount: cached.lineIndexCount, vertexCount: vc })
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
      tile.outlineIndexBuffer?.destroy()
      tile.outlineSegmentBuffer?.destroy()
      tile.lineSegmentBuffer?.destroy()
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
