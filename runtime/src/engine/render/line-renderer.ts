// ═══ SDF Line Renderer ═══
// Renders line features and polygon outlines as resolution-independent quads
// using signed-distance-field math in the fragment shader.
//
// Integration:
// - Group 0: VTR's tile uniform (MVP, tile_rtc, etc.) — reused from fill pipeline
// - Group 1: Line layer uniform + segment storage buffer
//
// Phase 1: variable pixel width, butt cap, bevel join (implicit).
// Later phases add cap/join styles, dash arrays, pattern stacks.
//
// ── Self-overlap behaviour (read this before reporting "weird joins") ──
//
// 1. Translucent self-intersection: when a single stroke crosses itself, the
//    crossing is handled by the offscreen + MAX-blend pipeline (see
//    `pipelineMax`, `beginTranslucentPass`, `composite`). Within-layer
//    overlap reduces to a single max-coverage value per pixel; cross-layer
//    blending then applies the per-layer opacity once. Result: no
//    double-darkening at self-intersections or corner overlap.
//
// 2. Dense vertices (many vertices within stroke-width pixels of each
//    other): segment quads overlap heavily and miter joins compute extreme
//    bisectors. The vertex shader's miter-limit clamp falls back to a bevel
//    offset when the ratio exceeds `layer.miter_limit`, and the fragment
//    shader guards `seg_len < 1e-6` against zero-length segments. This is
//    visually correct but pays heavy overdraw — push aggressive
//    Douglas-Peucker simplification at the tiler stage (`simplifyLine` in
//    `vector-tiler.ts`) rather than trying to fix it in the runtime.
//
// 3. Dash / pattern arc continuity: `arc_pos = arc_start + t_along` is
//    computed per fragment using each segment's stored `arc_start`
//    (precomputed in the tiler via `augmentLineWithArc` for stride-4 line
//    features). Across joins, `arc_start[seg_n+1] = arc_start[seg_n] +
//    segLen[seg_n]`, so dash and pattern phase advance continuously
//    regardless of vertex density. Caveat: arc length is measured along
//    the ORIGINAL geometry, not the offset stroke's parallel curve. For
//    typical small offsets the difference is sub-pixel; computing exact
//    parallel arc length would require per-segment numerical integration
//    and is deferred.

import { isPickEnabled, getSampleCount, type GPUContext } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { asyncWriteBuffer, type StagingBufferPool } from '../gpu/staging-buffer-pool'
import { xlog } from '../log'
import { wrapWebGpuPass, wrapWebGpuBuffer, wrapWebGpuBindGroup, wrapWebGpuBindGroupLayout } from './rhi/rhi-webgpu'
import type { RhiBuffer, RhiBindGroup, RhiDevice } from './rhi/rhi'
import { LineDraper } from './material/line-material'
import { LineCompositeDraper } from './material/line-composite-material'
import type { ShapeRegistry } from '../text/sdf-shape'
import {
  lineUniformSize, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
  LINE_CAP_BUTT, LINE_CAP_ROUND, LINE_CAP_SQUARE, LINE_CAP_ARROW,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
  LINE_FLAG_HAS_PATTERN, LINE_FLAG_HAS_OFFSET,
  PATTERN_UNIT_M, PATTERN_UNIT_PX, PATTERN_UNIT_KM, PATTERN_UNIT_NM,
  PATTERN_ANCHOR_REPEAT, PATTERN_ANCHOR_START, PATTERN_ANCHOR_END, PATTERN_ANCHOR_CENTER,
  checkPatternParams, packLineLayerUniform,
  type DashConfig, type PatternSlot,
} from './line-pattern'
import { lineLayerUniformStride } from './line-uniform-slots'
// Re-export so test files (line-renderer.test, line-pattern-guards.test, etc.)
// keep importing the public surface from the renderer module.
export {
  lineUniformSize, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
  LINE_CAP_BUTT, LINE_CAP_ROUND, LINE_CAP_SQUARE, LINE_CAP_ARROW,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
  LINE_FLAG_HAS_PATTERN, LINE_FLAG_HAS_OFFSET,
  PATTERN_UNIT_M, PATTERN_UNIT_PX, PATTERN_UNIT_KM, PATTERN_UNIT_NM,
  PATTERN_ANCHOR_REPEAT, PATTERN_ANCHOR_START, PATTERN_ANCHOR_END, PATTERN_ANCHOR_CENTER,
  checkPatternParams, packLineLayerUniform,
  type DashConfig, type PatternSlot,
}


// ═══ Segment Buffer Layout ═══
// 40 bytes per segment. Phase 1: p0, p1 only. Later phases add prev/next tangents, arc_start, line_length.

// Stride is 12 f32 = 48 bytes. Fields:
//   [0-1]  p0 (vec2)
//   [2-3]  p1 (vec2)
//   [4-5]  prev_tangent (vec2)  — direction of prev seg arriving at p0 (zero = cap)
//   [6-7]  next_tangent (vec2)  — direction of next seg leaving p1 (zero = cap)
//   [8]    arc_start   (f32)
// DSFUN segment layout (stride 16 f32 = 64 bytes):
//   [0-1]   p0_h (vec2<f32>)        — tile-local Mercator meters, high pair
//   [2-3]   p1_h (vec2<f32>)
//   [4-5]   p0_l (vec2<f32>)        — low pair
//   [6-7]   p1_l (vec2<f32>)
//   [8-9]   prev_tangent (vec2<f32>)
//   [10-11] next_tangent (vec2<f32>)
//   [12]    arc_start (f32)
//   [13]    line_length (f32)
//   [14]    pad_ratio_p0 (f32)
//   [15]    pad_ratio_p1 (f32)
//
// The shader subtracts (p0_h - cam_h) + (p0_l - cam_l) to cancel tile-origin
// magnitude and recover camera-relative meters with f64-equivalent precision.
// Tangents stay single-f32 — they're unit vectors in a tile-local frame and
// don't suffer from cancellation.
import { LINE_SEGMENT_STRIDE_F32, LINE_SEGMENT_STRIDE_BYTES, buildLineSegments } from '../../core/line-segment-build'
export { LINE_SEGMENT_STRIDE_F32, LINE_SEGMENT_STRIDE_BYTES, buildLineSegments }

// ═══ WGSL Shader ═══
//
// Coordinate convention (matches VTR fill shader):
//   segment.p0/p1 are tile-local, where:
//     - x = lon_local * DEG2RAD * EARTH_R  (meters from tile west edge)
//     - y = merc_lat_local * EARTH_R       (meters from tile south edge in Mercator)
//   tile.tile_rtc.xy adds the offset from tile SW corner to camera center.
//   So world position (RTC) = p + tile.tile_rtc.xy.
//
// Width expansion happens in world space using a layer-level `mpp` value
// (meters per pixel at camera center). This keeps the shader simple and
// avoids per-fragment viewport-size math.

// The line + compositor WGSL is now emitted from `runtime/src/engine/shaders/dsl/line.ts`
// (`emitLineWgsl(pickEnabled)` / `emitCompositeWgsl()`). The pick variant is
// emitted conditionally — there is no more `__PICK_FIELD__` / `__PICK_WRITE__`
// regex marker. Consumers that used to scan `LINE_SHADER_SOURCE` now call the
// emitter directly.

// ═══ Renderer ═══

export class LineRenderer {
  /** Dynamic-offset stride of the LineLayer uniform ring, in bytes. Derived
   *  from `reflect()` (the SoT) via `lineLayerUniformStride()` — assigned in the
   *  CONSTRUCTOR (runs after configureProjections(), so the reflect emit is
   *  safe) instead of a hand literal, so a future LineLayer struct growth past
   *  256 B re-aligns every slot automatically instead of silently truncating
   *  it (the #600-blank-globe drift class). */
  private readonly layerStride: number
  /** Composite uniform slot stride. The composite opacity uniform (`CompUniform`
   *  = opacity f32 + vec3 pad = 16 B) is a DIFFERENT struct than LineLayer, so
   *  this stays its own value: 256 = the WebGPU minUniformBufferOffsetAlignment
   *  (the next 256-multiple ≥ 16 B). Not derived from layerStride. */
  private static readonly COMPOSITE_SLOT = 256
  private device: GPUDevice
  /** The RHI seam (§4 batch-seam migration). One instance, reused for line's
   *  PRIVATE resources (the layer-uniform ring, the empty-shape fallback, the
   *  composite-opacity ring + their bind groups) AND the LineDraper / Line-
   *  CompositeDraper. On WebGPU `createBuffer === device.createBuffer`,
   *  `writeBuffer === queue.writeBuffer` (the `bufUsage` map is 1:1), so the GPU
   *  command stream stays byte-identical. The per-tile SEGMENT buffers
   *  (uploadSegmentBuffer*) stay raw `device.createBuffer` — they are owned +
   *  destroyed by GpuTileStore's raw retire queue (the VTR/GPUArena cluster),
   *  so they flip with that cluster, not here. */
  private readonly rhi: RhiDevice
  private format: GPUTextureFormat
  private tileBindGroupLayout: GPUBindGroupLayout
  private layerBindGroupLayout: GPUBindGroupLayout
  private shapeRegistry: ShapeRegistry | null = null
  /** Deduped warnings for bad pattern parameter combos. Key: stable string
   *  describing the violation. Survives per LineRenderer instance — reset on
   *  demo reload (new instance). */
  private patternWarnings = new Set<string>()
  private emptyShapeBuffer: RhiBuffer
  // Dynamic-offset layer uniform ring (shared across all VTR sources/layers)
  private layerRing!: RhiBuffer
  private layerRingCapacity = 512
  private layerSlot = 0
  /** CPU-side mirror of layerRing. Each writeLayerSlot() stages its
   *  packed uniform bytes here and widens a dirty range; a single
   *  writeBuffer per frame flushes the range (in endFrame). Mirrors
   *  the VTR uniform-ring batching pattern. */
  private layerStaging!: Uint8Array
  private layerDirtyLo = 0
  private layerDirtyHi = 0

  // ── Translucent line offscreen + composite ──
  /** Single-sample offscreen RT used to render translucent line layers
   *  with max blending. Composited onto the main framebuffer with per-layer
   *  alpha. Lazily allocated + resized on demand. */
  private offscreenTexture: GPUTexture | null = null
  private offscreenView: GPUTextureView | null = null
  private offscreenWidth = 0
  private offscreenHeight = 0
  /** Composite uniform ring. 256-byte slots → each composite() call writes
   *  its own opacity into a fresh slot and binds via dynamic offset. This
   *  prevents the multi-layer writeBuffer clobbering hazard that a single
   *  shared buffer suffers: WebGPU applies every queue.writeBuffer for the
   *  frame before any submitted draw runs, so a shared buffer would make
   *  every composite draw sample the LAST layer's opacity. Mirrors
   *  `layerRing`. */
  private compositeRing!: RhiBuffer
  private compositeRingCapacity = 256
  private compositeSlot = 0

  constructor(ctx: GPUContext, vtrTileBindGroupLayout: GPUBindGroupLayout) {
    this.device = ctx.device
    this.rhi = ctx.rhi
    this.format = ctx.format
    this.tileBindGroupLayout = vtrTileBindGroupLayout
    // Ctor runs post-configureProjections(), so reflecting the LineLayer
    // stride here is safe (unlike a `static` field, which evaluates at import).
    this.layerStride = lineLayerUniformStride()

    this.layerBindGroupLayout = this.device.createBindGroupLayout({
      label: 'line-layer-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    // Layer uniform ring. 256-byte slots → dynamic offsets prevent
    // multi-layer writeBuffer clobbering within a single frame.
    // UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.layerRing = this.rhi.createBuffer({
      size: this.layerRingCapacity * this.layerStride,
      usage: 'uniform', writable: true,
      label: 'line-layer-ring',
    })
    this.layerStaging = new Uint8Array(this.layerRingCapacity * this.layerStride)

    // STORAGE-only (never written), byte-identical via bufUsage('storage', writable:false).
    this.emptyShapeBuffer = this.rhi.createBuffer({
      size: 64,
      usage: 'storage', writable: false,
      label: 'line-empty-shape-buf',
    })

    // Splice the pick output into the SDF line shader when `?picking=1`.
    // SDF lines are usually stroke-only — they don't carry per-feature IDs
    // in the segment buffer, so the pick value is left at (0, 0). The
    // underlying polygon fill already wrote its feature ID in this pass,
    // so writing (0, 0) from the line stroke would OVERWRITE the fill's
    // pick — which is why the `writeMask: 0` on the second target skips
    // pick output entirely for the line pipeline.
    // The line + composite draws now route through LineDraper / LineCompositeDraper (the RHI Material
    // seam) — the raw GPURenderPipelines + the composite bind-group/sampler that lived here are gone.
    // Composite uniform ring. 256-byte slots → dynamic offsets prevent
    // multi-layer writeBuffer clobbering within a single frame, mirroring
    // `layerRing`.
    // UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.compositeRing = this.rhi.createBuffer({
      size: this.compositeRingCapacity * LineRenderer.COMPOSITE_SLOT,
      usage: 'uniform', writable: true,
      label: 'line-composite-ring',
    })
  }

  /** Re-create the main + composite pipelines from the live QUALITY
   *  (MSAA sample count, pick target). Called by map.setQuality(). The
   *  `pipelineMax` variant is always single-sample (offscreen RT) and
   *  has no pick target, so it doesn't need rebuilding. Bind group
   *  layouts, shape buffers, and the uniform ring survive unchanged. */
  rebuildForQuality(): void {
    // The line + composite draws come from LineDraper / LineCompositeDraper, which capture the MSAA
    // sample count at construction — drop them so the next draw rebuilds against the new QUALITY.
    this._lineDraper = undefined
    this._compositeDraper = undefined
  }

  /** Lazily allocate / resize the offscreen RT to match the main color target. */
  ensureOffscreen(width: number, height: number): void {
    if (this.offscreenTexture && this.offscreenWidth === width && this.offscreenHeight === height) return
    this.offscreenTexture?.destroy()
    this.offscreenTexture = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'line-translucent-offscreen',
    })
    this.offscreenView = this.offscreenTexture.createView()
    this.offscreenWidth = width
    this.offscreenHeight = height
    // The composite bind group (offscreen view + sampler + opacity ring) is built per-draw by
    // LineCompositeDraper now — nothing to pre-build here.
  }

  /** Begin a translucent line render pass against the offscreen RT. */
  beginTranslucentPass(encoder: GPUCommandEncoder): GPURenderPassEncoder {
    if (!this.offscreenView) throw new Error('LineRenderer: offscreen not initialised')
    return encoder.beginRenderPass({
      label: 'line-translucent-pass',
      colorAttachments: [{
        view: this.offscreenView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
  }

  /** Composite the offscreen RT onto a main render pass with the given opacity.
   *  Each call allocates a fresh composite-ring slot, writes its own opacity
   *  there, and binds via dynamic offset. Two composite() calls in one frame
   *  with different opacities therefore read distinct slots at GPU execution
   *  time — fixing the shared-buffer clobber where every draw sampled the
   *  last layer's opacity. */
  composite(mainPass: GPURenderPassEncoder, opacity: number): void {
    if (!this.offscreenView) return
    const off = this.compositeSlot < this.compositeRingCapacity
      ? this.compositeSlot * LineRenderer.COMPOSITE_SLOT
      : (this.compositeRingCapacity - 1) * LineRenderer.COMPOSITE_SLOT
    if (this.compositeSlot >= this.compositeRingCapacity) {
      xlog.warn('[LineRenderer] composite ring overflow — capping at capacity; opacity bleed possible')
    } else {
      this.compositeSlot++
    }
    this.rhi.writeBuffer(this.compositeRing, off, new Float32Array([opacity, 0, 0, 0]))
    // Through the RHI Material seam (the sole path). The offscreen RT/pass origination stays raw (P2).
    // WebGPU-only (the offscreen translucent path fail-closes on WebGl2).
    this.ensureCompositeDraper().draw(wrapWebGpuPass(mainPass), this.offscreenView, this.compositeRing, off)
  }

  private _compositeDraper?: LineCompositeDraper
  private ensureCompositeDraper(): LineCompositeDraper {
    return (this._compositeDraper ??= new LineCompositeDraper(this.rhi, this.format, getSampleCount()))
  }

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  /** Upload segment data and return a GPU buffer. Caller owns destruction.
   *  STAYS raw `device.createBuffer` (NOT the §4 RHI seam): the returned buffer
   *  is owned + destroyed by GpuTileStore's raw `_retiredTileBuffers: GPUBuffer[]`
   *  retire queue (the VTR/GPUArena cluster), so it flips to RhiBuffer with that
   *  cluster, not in this line step. createLayerBindGroup wraps it transiently. */
  uploadSegmentBuffer(segments: Float32Array): GPUBuffer {
    const size = Math.max(segments.byteLength, LINE_SEGMENT_STRIDE_BYTES)
    const buf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'line-segments',
    })
    this.device.queue.writeBuffer(buf, 0, segments)
    return buf
  }

  /** Async variant of `uploadSegmentBuffer`. Allocates the destination
   *  buffer, then schedules the write through `asyncWriteBuffer` (the
   *  caller's pool + encoder). Returns the destination buffer + a
   *  release closure for the staging slot — the caller submits the
   *  encoder, then invokes release() to return the staging slot to the
   *  pool. Requested by VTR's queued tile upload path so the segment
   *  buffer doesn't pay the driver's writeBuffer staging copy. */
  async uploadSegmentBufferAsync(
    segments: Float32Array,
    encoder: GPUCommandEncoder,
    pool: StagingBufferPool,
  ): Promise<{ buffer: GPUBuffer; release: () => void }> {
    const size = Math.max(segments.byteLength, LINE_SEGMENT_STRIDE_BYTES)
    const buf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'line-segments-async',
    })
    const handle = await asyncWriteBuffer(pool, encoder, buf, 0, segments)
    return { buffer: buf, release: handle.release }
  }

  /** Reset the layer + composite ring slot cursors. Call once per frame. */
  beginFrame(): void {
    this.layerSlot = 0
    this.compositeSlot = 0
  }

  /**
   * Allocate a slot and write layer uniform data. Returns byte offset to
   * pass as the dynamic offset in `drawSegments`.
   */
  writeLayerSlot(
    strokeColor: [number, number, number, number],
    strokeWidthPx: number,
    opacity: number,
    mppAtCenter: number,
    cap: number = LINE_CAP_BUTT,
    join: number = LINE_JOIN_MITER,
    miterLimit: number = 2.0, // Mapbox spec default

    dash: DashConfig | null = null,
    patterns: PatternSlot[] = [],
    offsetPx: number = 0,
    viewportHeight: number = 1,
    blurPx: number = 0,
    dpr: number = 1,
    lineTranslateX: number = 0,
    lineTranslateY: number = 0,
    /** Mapbox line-round-limit (default 1.05). 0 = use the shader's
     *  historical round-join fold constant (byte-identical default). */
    roundLimit: number = 0,
  ): number {
    // Pattern sanity checks (deduped, one warning per condition per
    // LineRenderer instance). Runs on the parameter set BEFORE packing so
    // that bogus values are flagged even if the GPU silently renders them.
    checkPatternParams(patterns, mppAtCenter, (k, m) => this.warnOnce(k, m))

    if (this.layerSlot >= this.layerRingCapacity) {
      xlog.warn('[LineRenderer] layer ring overflow — capping at capacity; style bleed possible')
      return (this.layerRingCapacity - 1) * this.layerStride
    }
    const off = this.layerSlot * this.layerStride
    this.layerSlot++
    const data = packLineLayerUniform(
      strokeColor, strokeWidthPx, opacity, mppAtCenter,
      cap, join, miterLimit, dash, patterns, offsetPx, viewportHeight, blurPx, dpr,
      lineTranslateX, lineTranslateY, roundLimit,
    )
    // Stage into the CPU mirror; flushLayerStaging (called from the
    // map's render loop via `endFrame()`) emits a single writeBuffer
    // over the frame's dirty range instead of one per layer.
    const src = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, this.layerStride))
    this.layerStaging.set(src, off)
    const hi = off + this.layerStride
    if (this.layerDirtyHi === this.layerDirtyLo) {
      this.layerDirtyLo = off
      this.layerDirtyHi = hi
    } else {
      if (off < this.layerDirtyLo) this.layerDirtyLo = off
      if (hi > this.layerDirtyHi) this.layerDirtyHi = hi
    }
    return off
  }

  /** Flush the accumulated layer-ring bytes in a single writeBuffer.
   *  Safe to call any time before queue.submit() — WebGPU orders the
   *  write before the submitted command buffer by spec. */
  endFrame(): void {
    if (this.layerDirtyHi === this.layerDirtyLo) return
    const lo = this.layerDirtyLo, hi = this.layerDirtyHi
    // A subarray view over [lo, hi) of the CPU mirror (byteOffset 0) — the same
    // bytes the 5-arg `queue.writeBuffer(buf, lo, staging.buffer, lo, hi-lo)` wrote
    // to the same GPU offset, so the upload is byte-identical (the RHI seam's
    // writeBuffer is 3-arg by contract — no dataOffset/size).
    this.rhi.writeBuffer(this.layerRing, lo, this.layerStaging.subarray(lo, hi))
    this.layerDirtyLo = 0
    this.layerDirtyHi = 0
  }

  /** Emit a warning once per (stable) key for the lifetime of this renderer. */
  private warnOnce(key: string, msg: string): void {
    if (this.patternWarnings.has(key)) return
    this.patternWarnings.add(key)
    xlog.warn(msg)
  }

  /**
   * Look up a shape name in the registry.
   * Returns the 1-based ID (0 = unknown/inactive) that goes straight into
   * PatternSlot.shapeId. The shader will call sdf_shape(uv, id - 1u).
   */
  resolveShapeId(name: string): number {
    return this.shapeRegistry?.getShapeId(name) ?? 0
  }

  /** Create a bind group for the line layer + segments + shape registry.
   *  Binding 0 uses a dynamic offset — actual slot is chosen at draw time. */
  createLayerBindGroup(segmentBuffer: GPUBuffer): RhiBindGroup {
    // §4 seam: built via the RHI. binding 0 = line's PRIVATE layer ring (RhiBuffer);
    // binding 1 = the per-tile segment buffer, still a raw GpuTileStore-owned
    // GPUBuffer (flips with the VTR/GPUArena cluster, unit 4) → wrapped transiently;
    // binding 2/3 = the SHARED ShapeRegistry shape/seg buffers, now RhiBuffer (step
    // 3c migrated them) → passed directly, with the private emptyShapeBuffer (also
    // RhiBuffer) as the no-registry fallback. The binding-1 segment wrap drops with
    // the VTR/GPUArena cluster.
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const shapeSegBuf = this.shapeRegistry?.segmentBuffer
    return this.rhi.createBindGroup(wrapWebGpuBindGroupLayout(this.layerBindGroupLayout), [
      { binding: 0, resource: { buffer: this.layerRing, offset: 0, size: lineUniformSize() } },
      { binding: 1, resource: { buffer: wrapWebGpuBuffer(segmentBuffer) } },
      { binding: 2, resource: { buffer: shapeBuf ?? this.emptyShapeBuffer } },
      { binding: 3, resource: { buffer: shapeSegBuf ?? this.emptyShapeBuffer } },
    ])
  }

  /**
   * Draw instanced quads for line segments.
   * `tileOffset` and `layerOffset` are the dynamic byte offsets returned from
   * each ring's allocator for this draw.
   */
  /** iter-218 (Phase RB.B.6) — `pass` parameter type widened to
   *  also accept `GPURenderBundleEncoder`. The 4 GPU commands here
   *  (setPipeline, setBindGroup ×2, draw) are in the common subset
   *  of both interfaces, matching the VTR `recordTileFill` pattern
   *  (iter-216). Unblocks future iters from routing the SDF stroke
   *  emit through a cached RenderBundle alongside the fill draws. */
  drawSegments(
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    tileBindGroup: GPUBindGroup,
    layerBindGroup: RhiBindGroup,
    segmentCount: number,
    tileOffset: number,
    layerOffset: number,
    translucent: boolean = false,
    patternActive: boolean = false,
  ): void {
    if (segmentCount === 0) return
    // Overdraw-debug v1: SDF stroke pipeline targets the swapchain
    // format; r16float accumulator would mismatch. Skip — strokes
    // don't contribute to the v1 heatmap. Phase 2 adds an additive
    // r16float variant so line overdraw counts too.
    if (DEBUG_OVERDRAW) return
    // RHI seam (DEFAULT ON): every line draw routes through the LineDraper Material seam — the
    // opaque main pass, the translucent offscreen MAX-blend pass, the pick MRT pass, AND the
    // render-BUNDLE path (the wrapped pass accepts a GPURenderBundleEncoder; setStencilReference/end
    // no-op there). mode 'opaque' / 'max' / 'pick' (lines write pick=vec2u(0,0)). The raw pipelines
    // below remain ONLY as an explicit opt-out (__xgisLineViaRhi === false, e.g. the parity specs);
    // they retire with the §4 seam + VTR. Offscreen RT/pass ORIGINATION stays raw (deferred to P2).
    this.ensureLineDraper()
    // layerBG is line's RhiBindGroup (createLayerBindGroup, via the RHI seam);
    // tileBG is the VTR tile bind group — still a raw GPUBindGroup (flips with the
    // VTR cluster) → wrapped here at the renderer call site (transient).
    this._lineDraper!.draw(wrapWebGpuPass(pass), {
      tileBG: wrapWebGpuBindGroup(tileBindGroup), layerBG: layerBindGroup, tileOffset, layerOffset,
      pattern: patternActive, segmentCount,
    }, translucent ? 'max' : isPickEnabled() ? 'pick' : 'opaque')
  }

  private _lineDraper?: LineDraper
  private ensureLineDraper(): void {
    if (this._lineDraper) return
    this._lineDraper = new LineDraper(this.rhi, this.format, getSampleCount(), this.tileBindGroupLayout, this.layerBindGroupLayout)
  }

  clearLayers(): void {
    // no-op: per-tile buffers are owned by VTR
  }
}
