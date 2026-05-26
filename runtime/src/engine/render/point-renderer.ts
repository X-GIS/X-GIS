// ═══ SDF Point Renderer ═══
// Renders Point/MultiPoint features as resolution-independent circles
// using Signed Distance Field math in the fragment shader.
// Single draw call for all points via per-feature storage buffer.

import type { Camera } from '../projection/camera'
import { BLEND_ALPHA, DEPTH_TEST_WRITE, WORLD_MERC, TILE_PX, worldCopiesFor } from '../gpu/gpu-shared'
import { getSampleCount } from '../gpu/gpu'
import type { ShapeRegistry } from '../text/sdf-shape'
import { parseHexColor } from '../feature-helpers'
import { resolveNumberShape } from './paint-shape-resolve'
import { FrameArena } from '../gpu/frame-arena'
import type { PointLayer } from './point-renderer-types'
import { emitPointWgsl } from '../shader-dsl'

// ═══ Renderer ═══

export class PointRenderer {
  private device: GPUDevice
  private pipeline: GPURenderPipeline            // billboard: depth test + write + bias
  private pipelineTranslucent: GPURenderPipeline // billboard: depth test only, no write (transparency)
  private pipelineFlat: GPURenderPipeline        // flat: depth test only, no write (avoids coplanar z-fight)
  private bindGroupLayout: GPUBindGroupLayout
  private pipelineLayout: GPUPipelineLayout | null = null
  private format: GPUTextureFormat = 'bgra8unorm'
  // Vertex buffer layout — cached so rebuildForQuality can reuse without
  // recomputing the stride/attribute map.
  private vertexBufferLayout: GPUVertexBufferLayout | null = null
  private uniformBuffer: GPUBuffer
  private uniformData = new Float32Array(28) // mvp(16) + proj_params(4) + tile_rtc(4) + viewport(2) + pad(2)
  /** iter-249 (Plan AAA B.2) — per-flush arena. Each flush*() call
   *  allocates 3 large typed arrays (verts / indices / featData)
   *  sized to per-call vertex count. On flush entry, beginFrame()
   *  resets the watermark and reuses the same backing buffer; on
   *  flush exit, the data has been queue.writeBuffer'd to GPU
   *  (synchronous copy per WebGPU spec) so the arena views can be
   *  safely invalidated by the next flush's beginFrame call. */
  private readonly _frameArena = new FrameArena(64 * 1024)
  private layers: PointLayer[] = []
  private shapeRegistry: ShapeRegistry | null = null

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  constructor(ctx: { device: GPUDevice; format: GPUTextureFormat }) {
    this.device = ctx.device
    const { device } = ctx

    const shaderModule = device.createShaderModule({ code: emitPointWgsl(), label: 'sdf-point-shader' })

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    this.format = ctx.format
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] })
    const pipelineLayout = this.pipelineLayout

    this.vertexBufferLayout = {
      arrayStride: 16, // center(2×f32) + quad_id(u32) + feat_id(f32)
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'uint32' as GPUVertexFormat },
        { shaderLocation: 2, offset: 12, format: 'float32' as GPUVertexFormat },
      ],
    }
    const vertexBufferLayout = this.vertexBufferLayout

    // Polygon offset (depth bias) pulls point markers slightly toward the
    // camera so they never z-fight with ground polygons, line strokes, or
    // each other. Negative bias = closer in WebGPU's [0,1] depth range.
    // `depthBiasSlopeScale: -1` makes the offset proportional to surface
    // slope so the effect is roughly constant in screen space regardless
    // of pitch. Values chosen empirically — large enough to dominate any
    // realistic coplanar tie at 24-bit depth precision.
    const pointDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthBias: -10,
      depthBiasSlopeScale: -1,
      depthBiasClamp: 0,
    }

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: pointDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline',
    })

    // Translucent billboard pipeline — same as `pipeline` (depth bias, test
    // less-equal) but does NOT write depth. Translucent halos, glows, and
    // any fill/stroke with effective alpha < 1 use this so the depth buffer
    // only retains values from opaque fragments. Without this, a halo drawn
    // first writes depth across its large area and causes opaque pins of
    // other points drawn later to fail the depth test under pitch+rotation.
    const translucentDepthStencil: GPUDepthStencilState = {
      ...pointDepthStencil,
      depthWriteEnabled: false,
    }
    this.pipelineTranslucent = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: translucentDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline-translucent',
    })

    // Flat pipeline — depth read but NO write. Flat circles (e.g. coverage
    // overlays lying on the ground plane) have identical clip-space Z at
    // any overlapping fragment, so writing depth produces a coplanar tie
    // that flickers as z-fighting. Painter's order + alpha blending is the
    // correct composition for these. Depth test is kept at less-equal so
    // future opaque 3D geometry (not present today) can still occlude them.
    const flatDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthWriteEnabled: false,
    }
    this.pipelineFlat = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: flatDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline-flat',
    })

    this.uniformBuffer = device.createBuffer({
      size: 128, // 28 floats × 4 = 112, padded to 128
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  /** Rebuild the 3 point pipelines with the current QUALITY.msaa.
   *  Points don't participate in GPU picking today (their render pass has
   *  only one color attachment), so `isPickEnabled()` is ignored here —
   *  only MSAA changes require the rebuild. Safe to call mid-session. */
  rebuildForQuality(): void {
    if (!this.pipelineLayout || !this.vertexBufferLayout) return
    const device = this.device
    const shaderModule = device.createShaderModule({ code: emitPointWgsl(), label: 'sdf-point-shader-rebuilt' })
    const msaa = { count: getSampleCount() }
    const vb = this.vertexBufferLayout
    const pl = this.pipelineLayout
    const fmt = this.format
    const pointDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthBias: -10, depthBiasSlopeScale: -1, depthBiasClamp: 0,
    }
    this.pipeline = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: pointDepthStencil,
      multisample: msaa,
      label: 'sdf-point-pipeline',
    })
    this.pipelineTranslucent = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { ...pointDepthStencil, depthWriteEnabled: false },
      multisample: msaa,
      label: 'sdf-point-pipeline-translucent',
    })
    this.pipelineFlat = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { ...DEPTH_TEST_WRITE, depthWriteEnabled: false },
      multisample: msaa,
      label: 'sdf-point-pipeline-flat',
    })
  }

  /** Create a bind group with uniform + feat_data + shape buffers */
  private makeBindGroup(featBuffer: GPUBuffer): GPUBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const segBuf = this.shapeRegistry?.segmentBuffer
    // Fallback: tiny empty buffers if no registry
    const emptyBuf = this._emptyStorageBuf ??= this.device.createBuffer({
      size: 64, usage: GPUBufferUsage.STORAGE, label: 'empty-shape-buf',
    })
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: featBuffer } },
        { binding: 2, resource: { buffer: shapeBuf ?? emptyBuf } },
        { binding: 3, resource: { buffer: segBuf ?? emptyBuf } },
      ],
    })
  }
  private _emptyStorageBuf: GPUBuffer | null = null

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.vertexBuffer.destroy()
      layer.indexBuffer.destroy()
      layer.featureBuffer.destroy()
      layer._expandedVertBuf?.destroy()
      layer._expandedIdxBuf?.destroy()
      layer._expandedFeatBuf?.destroy()
    }
    this.layers = []
  }

  hasLayers(): boolean {
    return this.layers.length > 0
  }

  // ── Tile-based point accumulation (called from VectorTileRenderer) ──
  private tilePoints: { rtcX: number; rtcY: number; featId: number }[] = []
  private tilePointBuffer: GPUBuffer | null = null
  private tilePointIndexBuffer: GPUBuffer | null = null
  private tilePointFeatBuffer: GPUBuffer | null = null
  /** Buffers retired this frame because renderTilePoints rebuilt
   *  its tile-point geometry. Destroyed at the START of the NEXT
   *  frame so any in-flight queue.submit() that bound them via
   *  tilePointBindGroup completes first. Mirrors the
   *  retiredUniformRings pattern in vector-tile-renderer.ts:
   *  WebGPU spec keeps the GPU-side memory alive after destroy()
   *  for already-submitted work, but it's illegal to ENQUEUE new
   *  commands referencing a destroyed buffer. With multi-source
   *  layered demos (4 VTRs each calling renderTilePoints per
   *  frame), the rapid destroy+recreate inside renderTilePoints
   *  hit "Buffer used in submit while destroyed" validation
   *  errors when the prior frame's command encoder still
   *  referenced the same bind group. */
  private retiredTilePointBuffers: GPUBuffer[] = []
  private tilePointBindGroup: GPUBindGroup | null = null

  /** Drain retired-buffer queue from the previous frame. Safe by
   *  this point because the previous frame's queue.submit() has
   *  already returned (it's synchronous in JS) and the GPU keeps
   *  destroyed buffers' memory alive until that work completes.
   *  MapRenderer should call this once per frame before any
   *  renderTilePoints / renderPoints call. */
  beginFrame(): void {
    if (this.retiredTilePointBuffers.length === 0) return
    for (const b of this.retiredTilePointBuffers) b.destroy()
    this.retiredTilePointBuffers.length = 0
  }

  /** Accumulate a point from a visible tile (pre-computed RTC) */
  addTilePoint(rtcX: number, rtcY: number, featId: number): void {
    this.tilePoints.push({ rtcX, rtcY, featId })
  }

  /** Flush accumulated tile points as a single draw call */
  flushTilePoints(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    show: { fill?: string | null; stroke?: string | null; strokeWidth?: number; size?: number | null; opacity?: number },
    dpr: number = 1,
  ): void {
    if (this.tilePoints.length === 0) return
    const N = this.tilePoints.length

    // Parse show colors
    const fillHex = show.fill
    const strokeHex = show.stroke
    const fill = fillHex ? parseHexColor(fillHex) : null
    const stroke = strokeHex ? parseHexColor(strokeHex) : null
    const opacity = show.opacity ?? 1.0
    const radiusPx = show.size ?? 6
    const strokeWidth = show.strokeWidth ?? 1  // raw px, shader converts to UV

    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2

    // Build expanded buffers (one per world copy). Mercator wraps; other
    // projections collapse to a single world (worldCopiesFor()).
    const STRIDE = 14
    // WORLD_MERC imported from gpu-shared
    const COPIES = worldCopiesFor(projType)
    const totalN = N * COPIES.length

    // iter-249 (Plan AAA B.2) — arena-backed scratch. Pre-iter-249
    // each flush allocated 3 fresh typed arrays per call; now they
    // share one ArrayBuffer that grows to per-session peak.
    this._frameArena.beginFrame()
    const verts = this._frameArena.allocF32(totalN * 4 * 4)
    const indices = this._frameArena.allocU32(totalN * 6)
    const featData = this._frameArena.allocF32(totalN * STRIDE)
    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)

    for (let w = 0; w < COPIES.length; w++) {
      const worldOff = COPIES[w] * WORLD_MERC
      for (let i = 0; i < N; i++) {
        const pt = this.tilePoints[i]
        const gi = w * N + i

        const base = gi * 4 * 4
        for (let q = 0; q < 4; q++) {
          const off = base + q * 4
          verts[off] = 0; verts[off + 1] = 0; u32View[off + 2] = q; verts[off + 3] = gi
        }

        const iBase = gi * 6, vBase = gi * 4
        indices[iBase] = vBase; indices[iBase+1] = vBase+1; indices[iBase+2] = vBase+2
        indices[iBase+3] = vBase; indices[iBase+4] = vBase+2; indices[iBase+5] = vBase+3

        const fOff = gi * STRIDE
        featData[fOff+0] = radiusPx
        featData[fOff+1] = fill?fill[0]:0; featData[fOff+2] = fill?fill[1]:0
        featData[fOff+3] = fill?fill[2]:0; featData[fOff+4] = fill?fill[3]*opacity:0
        featData[fOff+5] = stroke?stroke[0]:0; featData[fOff+6] = stroke?stroke[1]:0
        featData[fOff+7] = stroke?stroke[2]:0; featData[fOff+8] = stroke?stroke[3]*opacity:0
        featData[fOff+9] = strokeWidth; featData[fOff+10] = flags
        featData[fOff+11] = pt.rtcX + worldOff
        featData[fOff+12] = pt.rtcY
        featData[fOff+13] = 0 // shape_id (circle default for tile points)
      }
    }

    // Defer destroy of the previous frame's buffers — see
    // retiredTilePointBuffers comment. Drained at the start of the
    // next frame via beginFrame() once the prior submit has
    // completed.
    if (this.tilePointBuffer) this.retiredTilePointBuffers.push(this.tilePointBuffer)
    if (this.tilePointIndexBuffer) this.retiredTilePointBuffers.push(this.tilePointIndexBuffer)
    if (this.tilePointFeatBuffer) this.retiredTilePointBuffers.push(this.tilePointFeatBuffer)

    this.tilePointBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'tile-point-vertices' })
    this.device.queue.writeBuffer(this.tilePointBuffer, 0, verts)
    this.tilePointIndexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'tile-point-indices' })
    this.device.queue.writeBuffer(this.tilePointIndexBuffer, 0, indices)
    this.tilePointFeatBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'tile-point-features' })
    this.device.queue.writeBuffer(this.tilePointFeatBuffer, 0, featData)

    this.tilePointBindGroup = this.makeBindGroup(this.tilePointFeatBuffer)

    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const uf = this.uniformData
    uf.set(frame.matrix, 0)
    uf[16] = projType; uf[17] = projCenterLon; uf[18] = projCenterLat; uf[19] = 0
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, camera.zoom)
    // viewport.w = log_depth_fc so fs_point can write @builtin(frag_depth)
    uf[24] = canvasWidth; uf[25] = canvasHeight; uf[26] = metersPerPixel; uf[27] = frame.logDepthFc
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Pick the translucent (no depth write) pipeline when the effective
    // alpha drops below 1 so halos/glows rendered from tile sources don't
    // occlude opaque points or layers drawn into the same depth buffer.
    // Matches the classification used in addLayer().
    const EPS = 0.999
    const fillA = fill ? fill[3] * opacity : 1
    const strokeA = stroke ? stroke[3] * opacity : 1
    const tileIsTranslucent = opacity < EPS || fillA < EPS || strokeA < EPS

    // Single draw call for all 3 world copies
    pass.setPipeline(tileIsTranslucent ? this.pipelineTranslucent : this.pipeline)
    pass.setBindGroup(0, this.tilePointBindGroup)
    pass.setVertexBuffer(0, this.tilePointBuffer)
    pass.setIndexBuffer(this.tilePointIndexBuffer, 'uint32')
    pass.drawIndexed(totalN * 6)

    // Clear for next frame
    this.tilePoints = []
  }


  /**
   * Add a point layer from GeoJSON features.
   * @param features Array of GeoJSON features with Point geometry
   * @param fill Fill color [r,g,b,a] (0-1)
   * @param stroke Stroke color [r,g,b,a] (0-1)
   * @param strokeWidth Stroke width in UV space (0-1, relative to radius)
   * @param radiusPx Base radius in pixels
   * @param opacity Overall opacity multiplier
   */
  addLayer(
    features: { geometry: { type: string; coordinates: number[] }; properties?: Record<string, unknown> }[],
    fill: [number, number, number, number] | null,
    stroke: [number, number, number, number] | null,
    strokeWidth: number,
    radiusPx: number,
    opacity: number,
    sizeUnit?: string | null,
    perFeatureSizes?: number[] | null,
    billboard?: boolean,
    shapeId?: number,
    anchor?: 'center' | 'bottom' | 'top',
    sizeShape?: import('@xgis/compiler').PropertyShape<number> | null,
  ): void {
    const points: { lon: number; lat: number }[] = []

    for (const f of features) {
      if (!f.geometry) continue
      if (f.geometry.type === 'Point') {
        points.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })
      } else if (f.geometry.type === 'MultiPoint') {
        for (const coord of (f.geometry as unknown as { coordinates: number[][] }).coordinates) {
          points.push({ lon: coord[0], lat: coord[1] })
        }
      }
    }

    if (points.length === 0) return

    // Build quad vertices: 4 vertices per point
    // iter-249 (Plan AAA B.2) — arena-backed.
    this._frameArena.beginFrame()
    const verts = this._frameArena.allocF32(points.length * 4 * 4) // 4 verts × 4 floats
    const indices = this._frameArena.allocU32(points.length * 6)

    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)
    for (let i = 0; i < points.length; i++) {
      const base = i * 4 * 4 // 4 verts × 4 floats
      const { lon, lat } = points[i]
      for (let q = 0; q < 4; q++) {
        const off = base + q * 4
        verts[off + 0] = lon
        verts[off + 1] = lat
        u32View[off + 2] = q  // quad_id as uint32 (same index — both are 4-byte elements)
        verts[off + 3] = i    // feat_id as float32
      }
      const iBase = i * 6
      const vBase = i * 4
      indices[iBase + 0] = vBase + 0
      indices[iBase + 1] = vBase + 1
      indices[iBase + 2] = vBase + 2
      indices[iBase + 3] = vBase + 0
      indices[iBase + 4] = vBase + 2
      indices[iBase + 5] = vBase + 3
    }

    // Build per-feature data (stride = 11 floats)
    const STRIDE = 14
    const featData = this._frameArena.allocF32(points.length * STRIDE)
    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2
    // Size mode in upper 4 bits: 0=px, 1=m, 2=km, 3=deg
    const unitMap: Record<string, number> = { m: 1, km: 2, deg: 3, nm: 4 }
    const sizeMode = sizeUnit ? (unitMap[sizeUnit] ?? 0) : 0
    if (billboard === false) flags |= 8  // bit 3 = flat
    flags |= (sizeMode << 4)
    // Anchor mode: bits 8-9 (0=center, 1=bottom, 2=top)
    const anchorMap = { center: 0, bottom: 1, top: 2 } as const
    flags |= (anchorMap[anchor ?? 'center']) << 8

    for (let i = 0; i < points.length; i++) {
      const off = i * STRIDE
      featData[off + 0] = perFeatureSizes ? perFeatureSizes[i] : radiusPx
      // fill rgba (RGB not premultiplied — alpha blending handles it)
      featData[off + 1] = fill ? fill[0] : 0
      featData[off + 2] = fill ? fill[1] : 0
      featData[off + 3] = fill ? fill[2] : 0
      featData[off + 4] = fill ? fill[3] * opacity : 0
      // stroke rgba
      featData[off + 5] = stroke ? stroke[0] : 0
      featData[off + 6] = stroke ? stroke[1] : 0
      featData[off + 7] = stroke ? stroke[2] : 0
      featData[off + 8] = stroke ? stroke[3] * opacity : 0
      // stroke width in UV space
      featData[off + 9] = strokeWidth  // raw px, shader converts to UV
      featData[off + 10] = flags
      // [11] and [12] = RTC x/y, written per-frame in render()
      featData[off + 13] = shapeId ?? 0
    }

    // Store original coordinates in f64 for per-frame RTC computation
    const lons = new Float64Array(points.length)
    const lats = new Float64Array(points.length)
    for (let i = 0; i < points.length; i++) {
      lons[i] = points[i].lon
      lats[i] = points[i].lat
    }

    const vertexBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'point-vertices' })
    this.device.queue.writeBuffer(vertexBuffer, 0, verts)

    const indexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'point-indices' })
    this.device.queue.writeBuffer(indexBuffer, 0, indices)

    const featureBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'point-features' })
    this.device.queue.writeBuffer(featureBuffer, 0, featData)

    const bindGroup = this.makeBindGroup(featureBuffer)

    // Translucent iff any channel's effective alpha is < ~1. Catches both
    // top-level opacity (e.g. `opacity-30`) and color-channel alpha such as
    // `fill-amber-300/30`. Fully opaque layers with opacity=1, fill.a=1
    // and stroke.a=1 remain in the depth-writing bucket.
    const EPS = 0.999
    const fillA = fill ? fill[3] * opacity : 1
    const strokeA = stroke ? stroke[3] * opacity : 1
    const isTranslucent = opacity < EPS || fillA < EPS || strokeA < EPS

    this.layers.push({
      vertexBuffer, indexBuffer, featureBuffer,
      featData, lons, lats,
      indexCount: indices.length,
      pointCount: points.length,
      bindGroup,
      isFlat: billboard === false,
      isTranslucent,
      sizeShape: sizeShape ?? null,
      lastDynZoom: Number.NaN,
    })

    console.log(`[X-GIS] SDF point layer: ${points.length} points`)
  }

  /** Re-evaluate animated point sizes against the current camera
   *  state and patch `layer.featData` in place. Caller invokes once
   *  per frame before render(). No-op for layers whose `sizeShape` is
   *  null or `constant` / `data-driven` (those are baked into
   *  featData at addLayer time or evaluated per-feature by the
   *  worker). render() copies from layer.featData into the per-world
   *  expanded buffer each frame, so the patched values propagate
   *  naturally — no need to touch the expanded buffer. */
  updateDynamicSizes(cameraZoom: number, elapsedMs: number): void {
    const STRIDE = 14
    for (const layer of this.layers) {
      const shape = layer.sizeShape
      if (shape === null) continue
      // Skip constant / data-driven shapes — only zoom/time kinds
      // need per-frame re-resolution.
      if (shape.kind !== 'zoom-interpolated'
          && shape.kind !== 'time-interpolated'
          && shape.kind !== 'zoom-time') continue
      const r = resolveNumberShape(shape, cameraZoom, elapsedMs)
      // Zoom-only optimization — skip when camera hasn't moved.
      // Time-animated shapes always update because elapsedMs always
      // advances.
      if (!r.hasTime && Math.abs(layer.lastDynZoom - cameraZoom) < 0.001) continue
      const size = r.value
      for (let i = 0; i < layer.pointCount; i++) {
        layer.featData[i * STRIDE + 0] = size
      }
      layer.lastDynZoom = cameraZoom
    }
  }

  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number = 1,
  ): void {
    if (this.layers.length === 0) return

    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const uf = this.uniformData

    // MVP matrix
    uf.set(frame.matrix, 0)
    // proj_params: shader's reproject_point branches on projType
    uf[16] = projType
    uf[17] = projCenterLon
    uf[18] = projCenterLat
    uf[19] = 0
    // tile_rtc: -project(center)
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    uf[20] = -projCenterLon * DEG2RAD * R
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, projCenterLat))
    uf[21] = -Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) * R
    uf[22] = 0
    uf[23] = 0
    // viewport: xy = size, z = meters_per_pixel, w = log_depth_fc
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, camera.zoom)
    uf[24] = canvasWidth
    uf[25] = canvasHeight
    uf[26] = metersPerPixel
    uf[27] = frame.logDepthFc

    // tile_rtc no longer needed in uniform (RTC computed per-point in CPU)
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Camera center in Mercator (f64 precision)
    const camMercX = projCenterLon * DEG2RAD * R
    const camClampedLat = Math.max(-85.051129, Math.min(85.051129, projCenterLat))
    const camMercY = Math.log(Math.tan(Math.PI / 4 + camClampedLat * DEG2RAD / 2)) * R

    // WORLD_MERC imported from gpu-shared
    const STRIDE = 14
    // World-copy enumeration depends on projection — Mercator wraps,
    // others collapse to a single world. See worldCopiesFor().
    const COPIES = worldCopiesFor(projType)

    // View-forward projection onto the ground plane, used to sort
    // translucent instances back-to-front. Pitch=0 gives a zero vector
    // (no in-plane forward component — everything ties), so the sort
    // becomes a no-op there; non-zero pitch orders so far points render
    // first. This matches painter's-algorithm expectations for alpha
    // blending across overlapping markers.
    const bearingRad = camera.bearing * DEG2RAD
    const pitchRad = camera.pitch * DEG2RAD
    const fwdX = Math.sin(bearingRad) * Math.sin(pitchRad)
    const fwdY = -Math.cos(bearingRad) * Math.sin(pitchRad)

    // Per-layer buffer upload — runs once per layer regardless of which
    // draw phase the layer belongs to.
    const uploadLayer = (layer: PointLayer): number => {
      const N = layer.pointCount
      const totalPoints = N * COPIES.length
      // iter-249 (Plan AAA B.2) — arena-backed scratch for layer
      // upload. Lifetime ends at queue.writeBuffer (sync copy);
      // safe to reset on next uploadLayer call.
      this._frameArena.beginFrame()
      const expandedFeat = this._frameArena.allocF32(totalPoints * STRIDE)
      const expandedVerts = this._frameArena.allocF32(totalPoints * 4 * 4)
      const expandedIdx = this._frameArena.allocU32(totalPoints * 6)
      const u32Verts = new Uint32Array(expandedVerts.buffer, expandedVerts.byteOffset, expandedVerts.length)

      // Pre-compute each instance's view-forward depth so we can write
      // the index buffer in back-to-front order. Only translucent layers
      // actually need this (opaque depth-test handles occlusion); for
      // opaque we skip the sort and keep feature-index order.
      const depths = layer.isTranslucent ? this._frameArena.allocF32(totalPoints) : null
      const order = layer.isTranslucent ? this._frameArena.allocU32(totalPoints) : null

      for (let w = 0; w < COPIES.length; w++) {
        const worldOff = COPIES[w] * WORLD_MERC
        const basePoint = w * N

        for (let i = 0; i < N; i++) {
          const lon = layer.lons[i]
          const lat = layer.lats[i]
          const mercX = lon * DEG2RAD * R
          const clampLat = Math.max(-85.051129, Math.min(85.051129, lat))
          const mercY = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R

          const dx = mercX - camMercX + worldOff
          const dy = mercY - camMercY

          // Copy style data from original
          const srcOff = i * STRIDE
          const dstOff = (basePoint + i) * STRIDE
          expandedFeat.set(layer.featData.subarray(srcOff, srcOff + 11), dstOff)
          expandedFeat[dstOff + 13] = layer.featData[srcOff + 13] // shape_id
          expandedFeat[dstOff + 11] = dx
          expandedFeat[dstOff + 12] = dy

          // Build quad vertices
          const globalIdx = basePoint + i
          const vBase = globalIdx * 4 * 4
          for (let q = 0; q < 4; q++) {
            const off = vBase + q * 4
            expandedVerts[off + 0] = 0 // placeholder (RTC in feat_data)
            expandedVerts[off + 1] = 0
            u32Verts[off + 2] = q
            expandedVerts[off + 3] = globalIdx // feat_id indexes into expanded buffer
          }

          if (depths && order) {
            depths[globalIdx] = dx * fwdX + dy * fwdY
            order[globalIdx] = globalIdx
          } else {
            // Feature-order indices for opaque layers.
            const iBase = globalIdx * 6
            const vIdx = globalIdx * 4
            expandedIdx[iBase] = vIdx; expandedIdx[iBase + 1] = vIdx + 1; expandedIdx[iBase + 2] = vIdx + 2
            expandedIdx[iBase + 3] = vIdx; expandedIdx[iBase + 4] = vIdx + 2; expandedIdx[iBase + 5] = vIdx + 3
          }
        }
      }

      // Back-to-front: larger depth first. Sorted order[p] gives the
      // globalIdx to emit at draw position p.
      if (depths && order) {
        const arr = Array.from(order)
        arr.sort((a, b) => depths[b] - depths[a])
        for (let p = 0; p < totalPoints; p++) {
          const globalIdx = arr[p]
          const iBase = p * 6
          const vIdx = globalIdx * 4
          expandedIdx[iBase] = vIdx; expandedIdx[iBase + 1] = vIdx + 1; expandedIdx[iBase + 2] = vIdx + 2
          expandedIdx[iBase + 3] = vIdx; expandedIdx[iBase + 4] = vIdx + 2; expandedIdx[iBase + 5] = vIdx + 3
        }
      }

      // Reuse or recreate GPU buffers sized for 3× points
      if (!layer._expandedVertBuf || layer._expandedSize !== totalPoints) {
        layer._expandedVertBuf?.destroy()
        layer._expandedIdxBuf?.destroy()
        layer._expandedFeatBuf?.destroy()
        layer._expandedVertBuf = this.device.createBuffer({ size: expandedVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'point-expanded-vertices' })
        layer._expandedIdxBuf = this.device.createBuffer({ size: expandedIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'point-expanded-indices' })
        layer._expandedFeatBuf = this.device.createBuffer({ size: Math.max(expandedFeat.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'point-expanded-features' })
        layer._expandedBindGroup = this.makeBindGroup(layer._expandedFeatBuf)
        layer._expandedSize = totalPoints
      }

      this.device.queue.writeBuffer(layer._expandedVertBuf!, 0, expandedVerts)
      this.device.queue.writeBuffer(layer._expandedIdxBuf!, 0, expandedIdx)
      this.device.queue.writeBuffer(layer._expandedFeatBuf!, 0, expandedFeat)
      return totalPoints
    }

    const drawLayer = (layer: PointLayer, pipeline: GPURenderPipeline, totalPoints: number) => {
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, layer._expandedBindGroup!)
      pass.setVertexBuffer(0, layer._expandedVertBuf!)
      pass.setIndexBuffer(layer._expandedIdxBuf!, 'uint32')
      pass.drawIndexed(totalPoints * 6)
    }

    // Upload every layer's buffers first (cheap; writes don't depend on
    // phase order), then run two draw phases.
    const totals = this.layers.map(uploadLayer)

    // Phase 1 — opaque billboards write depth so they correctly occlude
    // other opaque geometry regardless of declaration order.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (layer.isFlat || layer.isTranslucent) continue
      drawLayer(layer, this.pipeline, totals[i])
    }

    // Phase 2 — translucent billboards + flat layers blend on top without
    // writing depth. Declaration order is preserved within this phase so
    // authors still get painter's-order control for overlapping halos.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (!layer.isFlat && !layer.isTranslucent) continue
      const pipeline = layer.isFlat ? this.pipelineFlat : this.pipelineTranslucent
      drawLayer(layer, pipeline, totals[i])
    }
  }
}
