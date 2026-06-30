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
import { BLEND_ALPHA, BLEND_ALPHA_PREMULT, BLEND_MAX, DEPTH_READ_ONLY } from '../gpu/gpu-shared'
import { emitLineWgsl, emitCompositeWgsl } from '../shaders/dsl'
import { WebGpuDevice, wrapWebGpuPass } from './rhi/rhi-webgpu'
import { LineDraper } from './material/line-material'
import { LineCompositeDraper } from './material/line-composite-material'
import type { ShapeRegistry } from '../text/sdf-shape'
import {
  LINE_UNIFORM_SIZE, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
  LINE_CAP_BUTT, LINE_CAP_ROUND, LINE_CAP_SQUARE, LINE_CAP_ARROW,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
  LINE_FLAG_HAS_PATTERN, LINE_FLAG_HAS_OFFSET,
  PATTERN_UNIT_M, PATTERN_UNIT_PX, PATTERN_UNIT_KM, PATTERN_UNIT_NM,
  PATTERN_ANCHOR_REPEAT, PATTERN_ANCHOR_START, PATTERN_ANCHOR_END, PATTERN_ANCHOR_CENTER,
  checkPatternParams, packLineLayerUniform,
  type DashConfig, type PatternSlot,
} from './line-pattern'
// Re-export so test files (line-renderer.test, line-pattern-guards.test, etc.)
// keep importing the public surface from the renderer module.
export {
  LINE_UNIFORM_SIZE, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
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
  private static readonly LAYER_SLOT = 256
  /** Composite uniform slot stride. Matches LAYER_SLOT (256) so the
   *  dynamic offset is a multiple of the typical
   *  minUniformBufferOffsetAlignment, exactly as the layer ring does. */
  private static readonly COMPOSITE_SLOT = 256
  /** Bytes of the composite slot actually bound = the std140 size of the WGSL
   *  `CompUniform { opacity: f32, _pad: vec3f }` (shaders/line.ts). vec3f aligns
   *  to 16, so opacity sits at 0, _pad at 16, and the struct rounds up to 32 —
   *  NOT 16. This MUST be >= the pipeline's minimum binding size or WebGPU
   *  rejects the composite draw at frame-validation ("bound with size 16 …
   *  requires at least 32 bytes"). Equals the original pre-ring buffer size. */
  private static readonly COMPOSITE_USED = 32
  private device: GPUDevice
  private format: GPUTextureFormat
  /** Standard alpha-blend pipeline — used for opaque line draws. */
  private pipeline: GPURenderPipeline
  /** Max-blend pipeline — used for translucent line draws into the offscreen
   *  RT. Max blending eliminates within-layer alpha accumulation at corner
   *  overlaps and self-intersections. */
  private pipelineMax!: GPURenderPipeline
  /** iter-185 — line-pattern Stage 2 pipeline (fs_line_pattern,
   *  alpha-blend, same layout as `pipeline`). Selected by
   *  `pipelineFor` when the show has a resolved line-pattern UV. */
  private pipelinePattern!: GPURenderPipeline
  private tileBindGroupLayout: GPUBindGroupLayout
  private layerBindGroupLayout: GPUBindGroupLayout
  private shapeRegistry: ShapeRegistry | null = null
  /** Deduped warnings for bad pattern parameter combos. Key: stable string
   *  describing the violation. Survives per LineRenderer instance — reset on
   *  demo reload (new instance). */
  private patternWarnings = new Set<string>()
  private emptyShapeBuffer: GPUBuffer
  // Dynamic-offset layer uniform ring (shared across all VTR sources/layers)
  private layerRing!: GPUBuffer
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
  private offscreenSampler!: GPUSampler
  private compositePipeline!: GPURenderPipeline
  private compositeBindGroupLayout!: GPUBindGroupLayout
  private compositeBindGroup: GPUBindGroup | null = null
  /** Composite uniform ring. 256-byte slots → each composite() call writes
   *  its own opacity into a fresh slot and binds via dynamic offset. This
   *  prevents the multi-layer writeBuffer clobbering hazard that a single
   *  shared buffer suffers: WebGPU applies every queue.writeBuffer for the
   *  frame before any submitted draw runs, so a shared buffer would make
   *  every composite draw sample the LAST layer's opacity. Mirrors
   *  `layerRing`. */
  private compositeRing!: GPUBuffer
  private compositeRingCapacity = 256
  private compositeSlot = 0

  constructor(ctx: GPUContext, vtrTileBindGroupLayout: GPUBindGroupLayout) {
    this.device = ctx.device
    this.format = ctx.format
    this.tileBindGroupLayout = vtrTileBindGroupLayout

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
    this.layerRing = this.device.createBuffer({
      size: this.layerRingCapacity * LineRenderer.LAYER_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-layer-ring',
    })
    this.layerStaging = new Uint8Array(this.layerRingCapacity * LineRenderer.LAYER_SLOT)

    this.emptyShapeBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE,
      label: 'line-empty-shape-buf',
    })

    // Splice the pick output into the SDF line shader when `?picking=1`.
    // SDF lines are usually stroke-only — they don't carry per-feature IDs
    // in the segment buffer, so the pick value is left at (0, 0). The
    // underlying polygon fill already wrote its feature ID in this pass,
    // so writing (0, 0) from the line stroke would OVERWRITE the fill's
    // pick — which is why the `writeMask: 0` on the second target skips
    // pick output entirely for the line pipeline.
    const module = this.device.createShaderModule({ code: emitLineWgsl(isPickEnabled()), label: 'line-shader' })

    const linePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.tileBindGroupLayout, this.layerBindGroupLayout],
    })

    this.pipeline = this.device.createRenderPipeline({
      label: 'line-pipeline',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line',
        targets: isPickEnabled()
          ? [
              { format: this.format, blend: BLEND_ALPHA },
              // writeMask: 0 → pick buffer preserves whatever the
              // polygon fill wrote underneath the line stroke.
              { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 },
            ]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Depth test ON, depth write OFF — lines respect 3D building
      // occlusion (a roof-edge outline behind a foreground wall is
      // hidden by the wall) without interfering with subsequent
      // draws. The previous STENCIL_DISABLED state ignored depth
      // entirely, which is fine for purely 2D scenes but visibly
      // wrong once `extrude:` lifts outlines onto building roofs:
      // background buildings' outlines bled through foreground
      // walls. Pure painter's order via depth-disabled writes —
      // already used by ground-layer fills — doesn't apply here
      // because lines need to compete with extruded fills that
      // DO write depth.
      depthStencil: DEPTH_READ_ONLY,
      multisample: { count: getSampleCount() },
    })

    // MAX-blend variant: same shader, different blend op + NO MSAA + NO depth-stencil.
    // Targets the single-sample offscreen RT used for translucent compositing.
    // Uses fs_line_max (not fs_line) because the offscreen target has no
    // depth attachment — writing @builtin(frag_depth) would trip the
    // "shader writes frag depth but no depth texture set" validation.
    this.pipelineMax = this.device.createRenderPipeline({
      label: 'line-pipeline-max',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line_max',
        targets: [{ format: this.format, blend: BLEND_MAX }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })

    // iter-185 — line-pattern Stage 2 pipeline. Same vertex + bind
    // group layout as the standard `pipeline`; fragment routes to
    // `fs_line_pattern` which samples the sprite atlas at world-
    // anchored UV. Selected by `pipelineFor` when the show has a
    // resolved line-pattern UV bbox.
    this.pipelinePattern = this.device.createRenderPipeline({
      label: 'line-pipeline-pattern',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line_pattern',
        targets: isPickEnabled()
          ? [
              { format: this.format, blend: BLEND_ALPHA },
              { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 },
            ]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: DEPTH_READ_ONLY,
      multisample: { count: getSampleCount() },
    })

    // ── Composite pipeline ──
    this.compositeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    })
    const compositeModule = this.device.createShaderModule({ code: emitCompositeWgsl(), label: 'line-composite' })
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'line-composite-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vs_full' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_full',
        // fs_full emits PREMULTIPLIED rgb (`c.rgb * cu.opacity`); pair it
        // with the matching blend factor so we don't multiply by alpha a
        // second time at write. Using BLEND_ALPHA here was the original
        // bug — translucent line composites came out darker than asked.
        targets: [{ format: this.format, blend: BLEND_ALPHA_PREMULT }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: getSampleCount() },
    })
    this.offscreenSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
    // Composite uniform ring. 256-byte slots → dynamic offsets prevent
    // multi-layer writeBuffer clobbering within a single frame, mirroring
    // `layerRing`.
    this.compositeRing = this.device.createBuffer({
      size: this.compositeRingCapacity * LineRenderer.COMPOSITE_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-composite-ring',
    })
  }

  /** Re-create the main + composite pipelines from the live QUALITY
   *  (MSAA sample count, pick target). Called by map.setQuality(). The
   *  `pipelineMax` variant is always single-sample (offscreen RT) and
   *  has no pick target, so it doesn't need rebuilding. Bind group
   *  layouts, shape buffers, and the uniform ring survive unchanged. */
  rebuildForQuality(): void {
    const module = this.device.createShaderModule({ code: emitLineWgsl(isPickEnabled()), label: 'line-shader-rebuilt' })
    const linePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.tileBindGroupLayout, this.layerBindGroupLayout],
    })
    this.pipeline = this.device.createRenderPipeline({
      label: 'line-pipeline',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line',
        targets: isPickEnabled()
          ? [
              { format: this.format, blend: BLEND_ALPHA },
              { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 },
            ]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: DEPTH_READ_ONLY,
      multisample: { count: getSampleCount() },
    })
    // Composite pipeline samples the offscreen RT back into the MSAA main
    // color, so its multisample.count must match.
    const compositeModule = this.device.createShaderModule({ code: emitCompositeWgsl(), label: 'line-composite-rebuilt' })
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'line-composite-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vs_full' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_full',
        targets: [{ format: this.format, blend: BLEND_ALPHA_PREMULT }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: getSampleCount() },
    })
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
    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.offscreenSampler },
        { binding: 1, resource: this.offscreenView },
        // Dynamic-offset binding: actual slot is chosen per composite() call.
        { binding: 2, resource: { buffer: this.compositeRing, offset: 0, size: LineRenderer.COMPOSITE_USED } },
      ],
    })
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
    if (!this.compositeBindGroup) return
    const off = this.compositeSlot < this.compositeRingCapacity
      ? this.compositeSlot * LineRenderer.COMPOSITE_SLOT
      : (this.compositeRingCapacity - 1) * LineRenderer.COMPOSITE_SLOT
    if (this.compositeSlot >= this.compositeRingCapacity) {
      xlog.warn('[LineRenderer] composite ring overflow — capping at capacity; opacity bleed possible')
    } else {
      this.compositeSlot++
    }
    this.device.queue.writeBuffer(this.compositeRing, off, new Float32Array([opacity, 0, 0, 0]))
    // RHI seam (P1.5, behind __xgisLineViaRhi like the draw): only the composite DRAW routes through
    // the CompositeDraper; the offscreen RT/pass origination stays raw (deferred to P2). WebGPU-only
    // (the offscreen translucent path fail-closes on WebGl2).
    if ((globalThis as { __xgisLineViaRhi?: boolean }).__xgisLineViaRhi === true && this.offscreenView) {
      this.ensureCompositeDraper().draw(wrapWebGpuPass(mainPass), this.offscreenView, this.compositeRing, off)
    } else {
      mainPass.setPipeline(this.compositePipeline)
      mainPass.setBindGroup(0, this.compositeBindGroup, [off])
      mainPass.draw(3, 1)
    }
  }

  private _compositeDraper?: LineCompositeDraper
  private ensureCompositeDraper(): LineCompositeDraper {
    return (this._compositeDraper ??= new LineCompositeDraper(new WebGpuDevice(this.device), this.format, getSampleCount()))
  }

  /** Used by VTR to pick the right pipeline depending on whether the
   *  current pass is the offscreen translucent pass + whether the
   *  show wants line-pattern Stage 2. Pattern shows route to
   *  `pipelinePattern`; translucent pattern falls back to the
   *  max-blend opaque-colour pipeline (Stage 2.1 will add a pattern
   *  max variant). */
  getDrawPipeline(translucent: boolean, patternActive = false): GPURenderPipeline {
    if (translucent) return this.pipelineMax
    return patternActive ? this.pipelinePattern : this.pipeline
  }

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  /** Upload segment data and return a GPU buffer. Caller owns destruction. */
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
      return (this.layerRingCapacity - 1) * LineRenderer.LAYER_SLOT
    }
    const off = this.layerSlot * LineRenderer.LAYER_SLOT
    this.layerSlot++
    const data = packLineLayerUniform(
      strokeColor, strokeWidthPx, opacity, mppAtCenter,
      cap, join, miterLimit, dash, patterns, offsetPx, viewportHeight, blurPx, dpr,
      lineTranslateX, lineTranslateY, roundLimit,
    )
    // Stage into the CPU mirror; flushLayerStaging (called from the
    // map's render loop via `endFrame()`) emits a single writeBuffer
    // over the frame's dirty range instead of one per layer.
    const src = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, LineRenderer.LAYER_SLOT))
    this.layerStaging.set(src, off)
    const hi = off + LineRenderer.LAYER_SLOT
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
    this.device.queue.writeBuffer(
      this.layerRing, lo,
      this.layerStaging.buffer, this.layerStaging.byteOffset + lo, hi - lo,
    )
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
  createLayerBindGroup(segmentBuffer: GPUBuffer): GPUBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer ?? this.emptyShapeBuffer
    const shapeSegBuf = this.shapeRegistry?.segmentBuffer ?? this.emptyShapeBuffer
    return this.device.createBindGroup({
      layout: this.layerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.layerRing, offset: 0, size: LINE_UNIFORM_SIZE } },
        { binding: 1, resource: { buffer: segmentBuffer } },
        { binding: 2, resource: { buffer: shapeBuf } },
        { binding: 3, resource: { buffer: shapeSegBuf } },
      ],
    })
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
    layerBindGroup: GPUBindGroup,
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
    // RHI seam: opaque (main pass), translucent (the offscreen MAX-blend pass), AND the pick MRT
    // pass all route through the LineDraper now — mode 'opaque' / 'max' / 'pick' (lines write
    // pick=vec2u(0,0), so the pick variant just adds the rg32uint MRT). Still legacy: the
    // render-bundle path (no `pass.end`). The offscreen RT/pass ORIGINATION stays raw (deferred to
    // P2); only the draw is wrapped.
    const lineRhi = (globalThis as { __xgisLineViaRhi?: boolean }).__xgisLineViaRhi === true
      && typeof (pass as { end?: unknown }).end === 'function'
    if (lineRhi) {
      this.ensureLineDraper()
      if (!this._lineRhiLogged) { this._lineRhiLogged = true; console.warn(`[LINERHI] segment draw via RHI seam (segments=${segmentCount})`) }
      this._lineDraper!.draw(wrapWebGpuPass(pass as GPURenderPassEncoder), {
        tileBG: tileBindGroup, layerBG: layerBindGroup, tileOffset, layerOffset,
        pattern: patternActive, segmentCount,
      }, translucent ? 'max' : isPickEnabled() ? 'pick' : 'opaque')
    } else {
      pass.setPipeline(this.getDrawPipeline(translucent, patternActive))
      pass.setBindGroup(0, tileBindGroup, [tileOffset])
      pass.setBindGroup(1, layerBindGroup, [layerOffset])
      pass.draw(6, segmentCount)
    }
  }

  private _lineDraper?: LineDraper
  private _lineRhiLogged = false
  private ensureLineDraper(): void {
    if (this._lineDraper) return
    this._lineDraper = new LineDraper(new WebGpuDevice(this.device), this.format, getSampleCount(), this.tileBindGroupLayout, this.layerBindGroupLayout)
  }

  clearLayers(): void {
    // no-op: per-tile buffers are owned by VTR
  }
}
