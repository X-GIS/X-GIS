// ═══ SDF Point Renderer ═══
// Renders Point/MultiPoint features as resolution-independent circles
// using Signed Distance Field math in the fragment shader.
// Single draw call for all points via per-feature storage buffer.

import type { Camera } from '../camera'
import { isWebMercator } from '@xgis/geo'
import { getSampleCount, FrameArena } from '@xgis/engine'
import type { ShapeRegistry } from '../text/sdf-shape'
import { parseHexColor } from '../feature-helpers'
import { resolveNumberShape } from './paint-shape-resolve'
import type { PointLayer } from './point-renderer-types'
import { buildPointModule, pointU as POINT_U } from '../shaders/dsl/point'
import { packPointInstances } from './point-feature-packer'
import { POINT_FEAT } from '../shaders/dsl/point-feat-layout'
const F = POINT_FEAT.slot
import { wrapWebGpuPass, wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import type { RhiBuffer, RhiBindGroup, RhiDevice } from '@xgis/engine'
import { PointDraper } from './material/point-material'
import { reflect } from '@xgis/shader-dsl'
import { vertexField, evaluate, makeEvalProps } from '@xgis/compiler'
import { POINT_FORMAT } from './point-vertex-format'
import { toVertexBufferLayout } from '@xgis/rhi-webgpu'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { reflectionToBindGroupLayoutEntries } from '@xgis/rhi-webgpu'
import { globeEyeUniform } from './globe-eye-uniform'
import { cameraAnchorDsfun } from './camera-anchor-dsfun'
import type { GeoJSONGeometry } from '@xgis/data'

// Float-slot indices derived from the single-source POINT_FORMAT spec so the
// packer cannot drift from the GPUVertexBufferLayout / vs_point @location.
const POINT_FLOATS_PER_VERT = POINT_FORMAT.stride / 4 // 4
const POINT_CENTER_FLOAT = vertexField(POINT_FORMAT, 'center').offset / 4 // 0 (x,y = 0,1)
const POINT_QUADID_FLOAT = vertexField(POINT_FORMAT, 'quad_id').offset / 4 // 2
const POINT_FEATID_FLOAT = vertexField(POINT_FORMAT, 'feat_id').offset / 4 // 3

// ── Reflection-driven bind-group layout + typed uniform pack target ──
// reflect(buildPointModule()) recovers, from the SAME IR the WGSL is emitted
// from, the @group(0) bind entries. The std140 `Uniforms` byte layout + write
// surface come from uniformBlock(U) (#733): the block derives per-field offsets
// from wgslLayout(U.struct) — handle-only, module-free — and its write() value
// object is TYPED by the same field record, so both the offset drift the point
// path once carried (viewport @20 vs @24) and the missing-field class (#600
// globe_eye) are compile-time impossible.
//
// LAZY + memoized: buildPointModule() gathers the injection-deferred projection
// funcs (getGpuProjectionFuncs), which require configureProjections() to have
// run first. Reflecting at module-load time would fire that emit before the app
// configures projections (the same reason buildPointModule is a build-fn). So
// the reflection is computed on first use (constructor / first frame), by which
// point configureProjections() has run. (uniformBlock(U) itself never touches
// the module, but constructing it lazily keeps one discipline for the file.)
let _pointReflection: ReturnType<typeof reflect> | null = null
let _pointBlock: UniformBlockOf<typeof POINT_U> | null = null
function pointReflection(): ReturnType<typeof reflect> {
  return (_pointReflection ??= reflect(buildPointModule()))
}
/** Memoized typed pack target for the std140 `Uniforms` struct. */
function pointBlock(): UniformBlockOf<typeof POINT_U> {
  return (_pointBlock ??= uniformBlock(POINT_U))
}
/** Canonical point `Uniforms` byte size, derived from the reflected layout.
 *  Exported so wiring tests size/identify the global uniform write from the SAME
 *  layout source the renderer uses, not a hand-coded 160. */
export function pointUniformBytes(): number {
  return pointBlock().byteLength
}
// Build the @group(0) bind-group-layout entries from the reflection. Visibility
// is the renderer's own knowledge (which stages read each binding); reflection
// records structure, not stage usage. uniform + feat_data are read by both
// stages; the SDF shape/segment storage buffers are FRAGMENT-only. Called from
// the constructor (post-configureProjections, where GPUShaderStage exists).
function buildPointBglEntries(): GPUBindGroupLayoutEntry[] {
  return reflectionToBindGroupLayoutEntries(
    pointReflection(),
    new Map([
      [0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT],
      [1, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT],
      [2, GPUShaderStage.FRAGMENT],
      [3, GPUShaderStage.FRAGMENT],
    ]),
  )
}

/** Pack the point frame uniform (shared by render() and flushTilePoints()) into
 *  the typed block — one write() per frame, every field named, completeness
 *  compile-time (#733). The #600 "projection set, eye forgotten" class is now
 *  unrepresentable at tsc level: write() has no optional fields, so a packer
 *  that omits globe_eye does not compile (the retired coupled runtime writer
 *  enforced the same proj_params + globe_eye coupling per-call-site).
 *
 *  Field notes (semantics unchanged, bytes identical to the lane writer this
 *  replaces — gated by point-frame-uniform.test.ts):
 *  · viewport: xy = canvas w/h, z = meters/px, w = log_depth_fc.
 *  · cam_ecef_h/l: camera anchor split DSFUN so the VS re-centers the ABSOLUTE
 *    per-feature ECEF against the camera-at-ENU-origin MVP via
 *    (ecefH−camH)+(ecefL−camL).
 *  · circle_params: x/y = translate baked CSS-px → NDC-per-pixel (px * 2 / w/h,
 *    y negated — NDC y is UP), z = blur_px, w = pitch-scale flag (0 = viewport,
 *    1 = map: VS scales quad expansion by w_ref/clip.w, MapLibre pitch-scale:map).
 *  · globe_eye: #600 globe(7) eye-horizon cull — frame.eye is set only on the
 *    globe/ECEF branch → all-zero on flat (flat/disc cull arms ignore it). */
// (exported for the byte-equality gate — point-frame-uniform.test.ts)
export function writePointFrameUniform(
  block: UniformBlockOf<typeof POINT_U>,
  frame: { matrix: Float32Array; logDepthFc: number; eye?: readonly [number, number, number] },
  camera: Camera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  circleTranslateX = 0,
  circleTranslateY = 0,
  circleBlur = 0,
  circlePitchScaleMap = false,
): void {
  // #739 — the world scale the frozen low-zoom flat MVP actually renders at
  // (single authority, mirrors getViewForProjection's cap), NOT the uncapped
  // WORLD_MERC/TILE_PX/2^zoom. Without this a px-sized circle changed device px
  // across the sub-cap band while the view stayed frozen, exactly like the line
  // width. Globe/ECEF returns the uncapped mpp unchanged (scoped out, #739).
  const metersPerPixel = camera.effectiveMpp(projType, canvasHeight, dpr)
  // Camera anchor for the per-vertex re-centring, split DSFUN into hi/lo lanes
  // (shared with the heatmap frame uniform, #1006). Flat Mercator (projType 0)
  // anchors on the 2D Mercator centre in .xy (z = 0, the flat VS ignores it);
  // 3D / globe anchors on the ECEF centre (getECEFCenter, sphere).
  const { hi: camH, lo: camL } = cameraAnchorDsfun(camera, projType)
  const ge = globeEyeUniform(frame.eye)
  block.write({
    mvp: frame.matrix,
    proj_params: [projType, projCenterLon, projCenterLat, 0],
    viewport: [canvasWidth, canvasHeight, metersPerPixel, frame.logDepthFc],
    cam_ecef_h: [camH[0], camH[1], camH[2], 0],
    cam_ecef_l: [camL[0], camL[1], camL[2], 0],
    circle_params: [
      canvasWidth > 0 ? (circleTranslateX * 2) / canvasWidth : 0,
      canvasHeight > 0 ? -(circleTranslateY * 2) / canvasHeight : 0,
      circleBlur,
      circlePitchScaleMap ? 1 : 0,
    ],
    globe_eye: [ge[0], ge[1], ge[2], ge[3]],
  })
}

// ── World-copy helpers (exported for unit tests) ──────────────────────────

/**
 * Returns the world-copy offset array the renderer uses for a given projType.
 * Flat Mercator (projType 0) fans out to all visible world copies via
 * `camera.getVisibleWorldCopies`; all other projTypes return `[0]` (single
 * absolute ECEF world, no wrap).
 */
export function pointWorldCopies(
  projType: number,
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): readonly number[] {
  return isWebMercator(projType)
    ? camera.getVisibleWorldCopies(canvasWidth, canvasHeight, dpr)
    : [0]
}

// worldCopyMercX moved into the stateless packer (@xgis/map, #722 S0); re-exported
// here so its discriminating unit test still imports it from this module.
export { worldCopyMercX } from './point-feature-packer'

// ═══ Renderer ═══

export class PointRenderer {
  /** The RHI seam (§4 batch-seam migration). One instance, reused for the point
   *  resources (uniform + per-frame vertex/index/feature buffers + the empty-shape
   *  fallback + the bind groups) and the PointDraper. On WebGPU `createBuffer ===
   *  device.createBuffer`, `createBindGroup === device.createBindGroup`,
   *  `writeBuffer === queue.writeBuffer`, `destroyBuffer === GPUBuffer.destroy()`,
   *  so the GPU command stream is byte-identical. */
  private readonly rhi: RhiDevice
  private readonly device: GPUDevice
  /** Native BGL, created LAZILY (#834 device retirement S6): its only
   *  consumer is makeBindGroup's WebGPU wrap (points are not drawn by the
   *  forced-WebGL2 frame) — the constructor must not touch the device. */
  private _bgl: GPUBindGroupLayout | null = null
  private format: GPUTextureFormat = 'bgra8unorm'
  // Vertex buffer layout — cached so rebuildForQuality can reuse without
  // recomputing the stride/attribute map.
  private vertexBufferLayout: GPUVertexBufferLayout | null = null
  private uniformBuffer: RhiBuffer
  // Point Uniforms: mvp(16) + proj_params(4) + viewport(4) + cam_ecef_h(4) +
  // cam_ecef_l(4) + circle_params(4) = 36 floats × 4 = 144 bytes.
  // `mvp` IS the ECEF-MVP (Camera.getECEFFrameView). The per-feature ECEF
  // DSFUN is ABSOLUTE, so cam_ecef_h/l carry the camera anchor (getECEFCenter,
  // sphere) split DSFUN; the VS re-centers via (ecefH−camH)+(ecefL−camL).
  // circle_params @32-35: translate_x_ndc, translate_y_ndc, blur_px, _unused.
  // Sized from the reflected std140 Uniforms slot count (36) — not hand-counted.
  // (Field init runs at construction, post-configureProjections, so the lazy
  // reflection is safe here.)
  private frameBlock = pointBlock()
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

  constructor(ctx: { device: GPUDevice; format: GPUTextureFormat; rhi: RhiDevice }) {
    this.rhi = ctx.rhi
    this.device = ctx.device
    this.format = ctx.format

    // Derived from the single-source POINT_FORMAT spec (vs_point @location + packer
    // derive from the same spec, so they cannot drift). The point draw goes through the
    // RHI Material seam (PointDraper, which owns the pipelines + their depth-bias variants);
    // this layout feeds ensurePointDraper.
    this.vertexBufferLayout = toVertexBufferLayout(POINT_FORMAT)

    // reflected std140 Uniforms size (160 bytes after #600 globe_eye).
    // UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.uniformBuffer = this.rhi.createBuffer({
      size: this.frameBlock.byteLength,
      usage: 'uniform',
      writable: true,
    })
  }

  /** A quality (MSAA) change invalidates the point draper so the next draw lazily rebuilds
   *  its pipelines with the new getSampleCount(). Points do no GPU picking (single colour
   *  attachment), so only the sample count matters. Safe to call mid-session. */
  rebuildForQuality(): void {
    this._pointDraper = undefined
  }

  /** Create a bind group with uniform + feat_data + shape buffers, through the
   *  RHI seam (§4). All handles are point-owned/shared RhiBuffers passed directly:
   *  uniform + feat are point-owned; the shared ShapeRegistry shape/seg buffers
   *  are now RhiBuffer too (step 3c migrated them), with the point-owned
   *  emptyStorageBuf() fallback when no registry is attached. */
  /** Lazy native BGL — see `_bgl`. WebGPU-arm consumers only. */
  private bgl(): GPUBindGroupLayout {
    return (this._bgl ??= this.device.createBindGroupLayout({
      // Entries sourced from reflect(buildPointModule()) — binding numbers +
      // buffer types come from the shader's own IR (see buildPointBglEntries);
      // the renderer supplies only the per-binding stage visibility.
      entries: buildPointBglEntries(),
    }))
  }

  private makeBindGroup(featBuffer: RhiBuffer): RhiBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const segBuf = this.shapeRegistry?.segmentBuffer
    return this.rhi.createBindGroup(wrapWebGpuBindGroupLayout(this.bgl()), [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: { buffer: featBuffer } },
      { binding: 2, resource: { buffer: shapeBuf ?? this.emptyStorageBuf() } },
      { binding: 3, resource: { buffer: segBuf ?? this.emptyStorageBuf() } },
    ])
  }
  /** Tiny empty storage buffer used as the binding-2/3 fallback when no
   *  ShapeRegistry is attached. STORAGE-only (no COPY_DST — never written),
   *  byte-identical via bufUsage('storage', writable:false). */
  private emptyStorageBuf(): RhiBuffer {
    return (this._emptyStorageBuf ??= this.rhi.createBuffer({
      size: 64,
      usage: 'storage',
      writable: false,
      label: 'empty-shape-buf',
    }))
  }
  private _emptyStorageBuf: RhiBuffer | null = null

  // ── RHI Material seam — the tile-point draw (P1: the sole path) ──
  // Storage buffers + vertex/index + drawIndexed through the generic Material: builds the
  // RHI pipelines once, then per-frame wraps the native uniform/feature/shape/seg/vertex/
  // index buffers + draws.
  private _pointDraper?: PointDraper

  private ensurePointDraper(): void {
    if (this._pointDraper) return
    const vbl = this.vertexBufferLayout!
    const vertexBuffers = [
      {
        stride: vbl.arrayStride,
        attributes: [...vbl.attributes].map((a) => ({
          location: a.shaderLocation,
          offset: a.offset,
          format: a.format as string,
        })),
      },
    ]
    this._pointDraper = new PointDraper(this.rhi, this.format, getSampleCount(), vertexBuffers)
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      this.rhi.destroyBuffer(layer.vertexBuffer)
      this.rhi.destroyBuffer(layer.indexBuffer)
      this.rhi.destroyBuffer(layer.featureBuffer)
      if (layer._expandedVertBuf) this.rhi.destroyBuffer(layer._expandedVertBuf)
      if (layer._expandedIdxBuf) this.rhi.destroyBuffer(layer._expandedIdxBuf)
      if (layer._expandedFeatBuf) this.rhi.destroyBuffer(layer._expandedFeatBuf)
    }
    this.layers = []
  }

  hasLayers(): boolean {
    return this.layers.length > 0
  }

  // ── Tile-based point accumulation (called from VectorTileRenderer) ──
  // Phase 2 PR 2d.2 — ECEF DSFUN: [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, featId, absLon, absLat]
  // #722 S4 — `featProps` carries the point's SOURCE feature properties
  // (featureProps.get(featId) from THIS point's tile), threaded in at
  // accumulation time so flushTilePoints can resolve a data-driven size
  // expression per feature. Resolved per-tile (not a single post-flush map)
  // because featId == source-feature index WITHIN a tile → fids collide across
  // tiles. Undefined when the layer has no data-driven size (constant-size path
  // stays byte-identical).
  private tilePoints: {
    exH: number
    eyH: number
    ezH: number
    exL: number
    eyL: number
    ezL: number
    featId: number
    absLon: number
    absLat: number
    mxH: number
    mxL: number
    myH: number
    myL: number
    featProps?: Record<string, unknown> | null
  }[] = []
  private tilePointBuffer: RhiBuffer | null = null
  private tilePointIndexBuffer: RhiBuffer | null = null
  private tilePointFeatBuffer: RhiBuffer | null = null
  /** Buffers retired this frame because renderTilePoints rebuilt
   *  its tile-point geometry. Destroyed at the START of the NEXT
   *  frame so any in-flight queue.submit() that bound them via
   *  the per-frame bind group completes first. Mirrors the
   *  retiredUniformRings pattern in vector-tile-renderer.ts:
   *  WebGPU spec keeps the GPU-side memory alive after destroy()
   *  for already-submitted work, but it's illegal to ENQUEUE new
   *  commands referencing a destroyed buffer. With multi-source
   *  layered demos (4 VTRs each calling renderTilePoints per
   *  frame), the rapid destroy+recreate inside renderTilePoints
   *  hit "Buffer used in submit while destroyed" validation
   *  errors when the prior frame's command encoder still
   *  referenced the same bind group. */
  private retiredTilePointBuffers: RhiBuffer[] = []

  /** Drain retired-buffer queue from the previous frame. Safe by
   *  this point because the previous frame's queue.submit() has
   *  already returned (it's synchronous in JS) and the GPU keeps
   *  destroyed buffers' memory alive until that work completes.
   *  MapRenderer should call this once per frame before any
   *  renderTilePoints / renderPoints call. */
  beginFrame(): void {
    if (this.retiredTilePointBuffers.length === 0) return
    for (const b of this.retiredTilePointBuffers) this.rhi.destroyBuffer(b)
    this.retiredTilePointBuffers.length = 0
  }

  /** Accumulate a point from a visible tile (ECEF DSFUN components).
   *  `featProps` (#722 S4) is the point's source feature properties bag
   *  (featureProps.get(featId) for this tile) — supplied only when the layer
   *  authors a data-driven size expression; undefined otherwise. */
  addTilePoint(
    exH: number,
    eyH: number,
    ezH: number,
    exL: number,
    eyL: number,
    ezL: number,
    featId: number,
    absLon: number,
    absLat: number,
    mxH: number,
    mxL: number,
    myH: number,
    myL: number,
    featProps?: Record<string, unknown> | null,
  ): void {
    this.tilePoints.push({
      exH,
      eyH,
      ezH,
      exL,
      eyL,
      ezL,
      featId,
      absLon,
      absLat,
      mxH,
      mxL,
      myH,
      myL,
      featProps,
    })
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
    show: {
      fill?: string | null
      stroke?: string | null
      strokeWidth?: number
      size?: number | null
      sizeExpr?: { ast?: unknown } | null
      shape?: string | null
      sizeUnit?: string | null
      anchor?: 'center' | 'bottom' | 'top'
      billboard?: boolean
      opacity?: number
      circleTranslateX?: number
      circleTranslateY?: number
      circleBlur?: number
      circlePitchScaleMap?: boolean
      circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number> | null
      circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number> | null
      circleStrokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null
    },
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
    // #722 S4 — data-driven per-feature size on the tile path (fixes #17 size).
    // Mirror of the INLINE GeoJSON path (map.ts:2688-2711): when the layer
    // authors a size EXPRESSION, evaluate it per feature against that feature's
    // source properties (pt.featProps, threaded on each tilePoint at
    // accumulation). Same @xgis/compiler evaluate + makeEvalProps + per-feature
    // throw-isolation → numeric fallback to the constant radius the inline path
    // uses. When there is no expression (or a point lacks props), radiusPx
    // (show.size ?? 6) is written verbatim — BYTE-IDENTICAL to pre-S4.
    const sizeAst = (show.sizeExpr?.ast ?? null) as import('@xgis/compiler').Expr | null
    const cameraZoom = camera.zoom
    const cameraPitch = camera.pitch
    const strokeWidth = show.strokeWidth ?? 1 // raw px, shader converts to UV
    // #722 S2 — resolve the tile-layer shape ONCE (mirrors map.ts:2715, the
    // inline path). Fixes #16: tile points (URL geojson / PMTiles) hardcoded
    // shape_id 0 → custom shapes (star/…) always drew as circles. show.shape
    // carries the compiled shape name; getShapeId maps it to the GPU slot.
    const tileShapeId = show.shape ? (this.shapeRegistry?.getShapeId(show.shape) ?? 0) : 0
    // WS-1 — per-frame zoom-interp on the tile-point path (mirror of the
    // GeoJSON updateDynamicSizes path). flushTilePoints rebakes feat_data +
    // the frame uniform every frame, so resolve the shapes here. These are
    // zoom-only, so elapsedMs=0 is fine.
    const tileStrokeOpacity = show.circleStrokeOpacityShape
      ? Math.max(
          0,
          Math.min(1, resolveNumberShape(show.circleStrokeOpacityShape, camera.zoom, 0).value),
        )
      : 1
    const tileTranslateX = show.circleTranslateXShape
      ? resolveNumberShape(show.circleTranslateXShape, camera.zoom, 0).value
      : (show.circleTranslateX ?? 0)
    const tileTranslateY = show.circleTranslateYShape
      ? resolveNumberShape(show.circleTranslateYShape, camera.zoom, 0).value
      : (show.circleTranslateY ?? 0)

    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2
    // #722 S3 — mirror the inline addLayer flag byte (point-renderer.ts:591-598)
    // exactly, so tile points honour size-unit / anchor / billboard instead of
    // collapsing to center-anchored, pixel-sized, always-billboarded. Same
    // encoding the point shader (map/src/shaders/dsl/point.ts) unpacks off slot
    // 10: bits 4-7 = size_mode, bit 3 = flat, bits 8-9 = anchor. Default show
    // (px / center / billboard) yields the identical old fill/stroke-only byte.
    const unitMap: Record<string, number> = { m: 1, km: 2, deg: 3, nm: 4 }
    const sizeMode = show.sizeUnit ? (unitMap[show.sizeUnit] ?? 0) : 0
    if (show.billboard === false) flags |= 8 // bit 3 = flat
    flags |= sizeMode << 4
    // Anchor mode: bits 8-9 (0=center, 1=bottom, 2=top)
    const anchorMap = { center: 0, bottom: 1, top: 2 } as const
    flags |= anchorMap[show.anchor ?? 'center'] << 8

    // #722 S1 — route the tile path through the shared world-copy fan-out
    // (fixes #17: tile points hardcoded COPIES=[0] and never replicated to the
    // flat-Mercator world copies at low zoom, unlike fills/lines/labels). Flat
    // Mercator (projType 0) fans out to every visible world copy; all other
    // projections collapse to a single absolute-ECEF world (no wrap).
    const STRIDE = POINT_FEAT.stride
    const COPIES = pointWorldCopies(projType, camera, canvasWidth, canvasHeight, dpr)
    const totalN = N * COPIES.length

    // iter-249 (Plan AAA B.2) — arena-backed scratch. Pre-iter-249
    // each flush allocated fresh typed arrays per call; now they
    // share one ArrayBuffer that grows to per-session peak.
    this._frameArena.beginFrame()
    // Per-source-point paint record (stride-24 slots 0-10 style + tileShapeId
    // at 19). Allocated FIRST so it stays valid if a later alloc grows the arena;
    // the packer reads it as `srcFeatData`, fans it out per world copy, and
    // fills the position slots (11-18 ECEF+abs, 20-23 Mercator). #722 S2 threads
    // the per-layer shape into slot 19 (0 = circle, resolved once above).
    const src = this._frameArena.allocF32(N * STRIDE)
    for (let i = 0; i < N; i++) {
      const so = i * STRIDE
      // Per-feature size when the layer authors a size expression AND this
      // point carries its source props; else the constant radius (byte-identical).
      const pt = this.tilePoints[i]
      let r = radiusPx
      if (sizeAst && pt.featProps) {
        let ev: unknown
        try {
          ev = evaluate(
            sizeAst,
            makeEvalProps({
              props: pt.featProps,
              geometryType: 'Point',
              featureId: pt.featId,
              cameraZoom,
              cameraPitch,
            }),
          )
        } catch {
          ev = radiusPx
        }
        r = typeof ev === 'number' ? ev : radiusPx
      }
      src[so + F.radius_px] = r
      src[so + F.fill_r] = fill ? fill[0] : 0
      src[so + F.fill_g] = fill ? fill[1] : 0
      src[so + F.fill_b] = fill ? fill[2] : 0
      src[so + F.fill_a] = fill ? fill[3] * opacity : 0
      src[so + F.stroke_r] = stroke ? stroke[0] : 0
      src[so + F.stroke_g] = stroke ? stroke[1] : 0
      src[so + F.stroke_b] = stroke ? stroke[2] : 0
      src[so + F.stroke_a] = stroke ? stroke[3] * opacity * tileStrokeOpacity : 0
      src[so + F.stroke_width_px] = strokeWidth
      src[so + F.flags_packed] = flags
      src[so + F.shape_id] = tileShapeId // #722 S2 — per-layer shape (0 = circle)
    }

    const verts = this._frameArena.allocF32(totalN * 4 * 4)
    const indices = this._frameArena.allocU32(totalN * 6)
    const featData = this._frameArena.allocF32(totalN * STRIDE)
    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)

    // Assemble the fan-out + quad verts/indices + per-copy position via the
    // shared stateless packer (#722). The tile record arrives with the
    // compiler's pre-split DSFUN (ECEF + abs lon/lat copy-independent, Mercator
    // re-split per copy). isTranslucent:false keeps the former tile behaviour
    // (feature-order indices, no back-to-front sort) byte-identical; the
    // pipeline-variant translucency (tileIsTranslucent below) is a separate
    // concern (no-depth-write pass), not a CPU sort.
    packPointInstances(
      {
        count: N,
        copies: COPIES,
        isTranslucent: false,
        fwdX: 0,
        fwdY: 0,
        srcFeatData: src,
        position: { kind: 'presplit', points: this.tilePoints },
      },
      { verts, u32: u32View, idx: indices, feat: featData, depths: null },
    )

    // Defer destroy of the previous frame's buffers — see
    // retiredTilePointBuffers comment. Drained at the start of the
    // next frame via beginFrame() once the prior submit has
    // completed.
    if (this.tilePointBuffer) this.retiredTilePointBuffers.push(this.tilePointBuffer)
    if (this.tilePointIndexBuffer) this.retiredTilePointBuffers.push(this.tilePointIndexBuffer)
    if (this.tilePointFeatBuffer) this.retiredTilePointBuffers.push(this.tilePointFeatBuffer)

    // VERTEX|COPY_DST / INDEX|COPY_DST / STORAGE|COPY_DST, byte-identical via
    // bufUsage(usage, writable:true); writeBuffer = queue.writeBuffer.
    this.tilePointBuffer = this.rhi.createBuffer({
      size: verts.byteLength,
      usage: 'vertex',
      writable: true,
      label: 'tile-point-vertices',
    })
    this.rhi.writeBuffer(this.tilePointBuffer, 0, verts)
    this.tilePointIndexBuffer = this.rhi.createBuffer({
      size: indices.byteLength,
      usage: 'index',
      writable: true,
      label: 'tile-point-indices',
    })
    this.rhi.writeBuffer(this.tilePointIndexBuffer, 0, indices)
    this.tilePointFeatBuffer = this.rhi.createBuffer({
      size: Math.max(featData.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'tile-point-features',
    })
    this.rhi.writeBuffer(this.tilePointFeatBuffer, 0, featData)

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    writePointFrameUniform(
      this.frameBlock,
      frame,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
      dpr,
      tileTranslateX,
      tileTranslateY,
      show.circleBlur ?? 0,
      show.circlePitchScaleMap ?? false,
    )
    this.rhi.writeBuffer(this.uniformBuffer, 0, this.frameBlock.buffer)

    // Pick the translucent (no depth write) pipeline when the effective
    // alpha drops below 1 so halos/glows rendered from tile sources don't
    // occlude opaque points or layers drawn into the same depth buffer.
    // Matches the classification used in addLayer().
    const EPS = 0.999
    const fillA = fill ? fill[3] * opacity : 1
    const strokeA = stroke ? stroke[3] * opacity * tileStrokeOpacity : 1
    const tileIsTranslucent = opacity < EPS || fillA < EPS || strokeA < EPS

    // Single draw call for all tile points, through the RHI Material seam. P1: the SOLE
    // draw path — proven pixel-identical (DC=0, real GPU) to the legacy direct draw by
    // playground/e2e/_point-rhi-parity. Points don't participate in GPU picking, so there
    // is no pick variant to keep on the legacy path.
    this.ensurePointDraper()
    // ShapeRegistry shape/seg are RhiBuffer (step 3c) → passed directly; the empty
    // fallback is a point-owned RhiBuffer.
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const segBuf = this.shapeRegistry?.segmentBuffer
    this._pointDraper!.draw(wrapWebGpuPass(pass), {
      uniform: this.uniformBuffer,
      feat: this.tilePointFeatBuffer!,
      shape: shapeBuf ?? this.emptyStorageBuf(),
      seg: segBuf ?? this.emptyStorageBuf(),
      vertex: this.tilePointBuffer!,
      index: this.tilePointIndexBuffer!,
      indexCount: totalN * 6,
      variant: tileIsTranslucent ? 1 : 0,
    })

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
    features: {
      geometry: GeoJSONGeometry | null
      properties?: Record<string, unknown>
    }[],
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
    circleTranslateX?: number,
    circleTranslateY?: number,
    circleBlur?: number,
    strokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circlePitchScaleMap?: boolean,
    perFeatureFills?: ([number, number, number, number] | null)[] | null,
    perFeatureStrokes?: ([number, number, number, number] | null)[] | null,
  ): void {
    const points: { lon: number; lat: number }[] = []

    for (const f of features) {
      if (!f.geometry) continue
      if (f.geometry.type === 'Point') {
        points.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })
      } else if (f.geometry.type === 'MultiPoint') {
        for (const coord of f.geometry.coordinates) {
          points.push({ lon: coord[0], lat: coord[1] })
        }
      }
    }

    if (points.length === 0) return

    // Build quad vertices: 4 vertices per point
    // iter-249 (Plan AAA B.2) — arena-backed.
    this._frameArena.beginFrame()
    const verts = this._frameArena.allocF32(points.length * 4 * POINT_FLOATS_PER_VERT) // 4 verts/quad
    const indices = this._frameArena.allocU32(points.length * 6)

    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)
    for (let i = 0; i < points.length; i++) {
      const base = i * 4 * POINT_FLOATS_PER_VERT // 4 verts/quad
      const { lon, lat } = points[i]
      for (let q = 0; q < 4; q++) {
        const off = base + q * POINT_FLOATS_PER_VERT
        verts[off + POINT_CENTER_FLOAT] = lon
        verts[off + POINT_CENTER_FLOAT + 1] = lat
        u32View[off + POINT_QUADID_FLOAT] = q // quad_id as uint32 (4-byte element, same slot)
        verts[off + POINT_FEATID_FLOAT] = i // feat_id as float32
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

    // Build per-feature data (stride = 24 floats, ECEF DSFUN layout +
    // absolute Mercator DSFUN tail at 20-23 for precise flat-Mercator position).
    // HEAP-allocated, NOT arena (#783): this array is stored on the persistent
    // layer record and read across frames (renderPoints copies layer.featData
    // into the per-frame expanded buffer), so an arena view here dies at the
    // next beginFrame — a second addLayer or the render-time flush reuses its
    // bytes and silently corrupts the first layer's paint data (the DEV
    // stale-view poison surfaced this as NaN radii in the circle wiring
    // gates). addLayer runs at scene-build time, not per frame, so the heap
    // allocation costs nothing hot.
    const STRIDE = POINT_FEAT.stride
    const featData = new Float32Array(points.length * STRIDE)
    let flags = 0
    // #732 S5 — a pure data-driven fill/stroke (no layer constant) still needs
    // its render bit so the per-feature colours are drawn.
    if (fill || perFeatureFills) flags |= 1
    if (stroke || perFeatureStrokes) flags |= 2
    // Size mode in upper 4 bits: 0=px, 1=m, 2=km, 3=deg
    const unitMap: Record<string, number> = { m: 1, km: 2, deg: 3, nm: 4 }
    const sizeMode = sizeUnit ? (unitMap[sizeUnit] ?? 0) : 0
    if (billboard === false) flags |= 8 // bit 3 = flat
    flags |= sizeMode << 4
    // Anchor mode: bits 8-9 (0=center, 1=bottom, 2=top)
    const anchorMap = { center: 0, bottom: 1, top: 2 } as const
    flags |= anchorMap[anchor ?? 'center'] << 8

    for (let i = 0; i < points.length; i++) {
      const off = i * STRIDE
      featData[off + F.radius_px] = perFeatureSizes ? perFeatureSizes[i] : radiusPx
      // #732 S5 — per-feature fill/stroke colour (data-driven point paint):
      // prefer the resolved per-feature colour, else the layer constant
      // (an unmatched feature falls back exactly like a match() default arm).
      const fc = (perFeatureFills ? perFeatureFills[i] : null) ?? fill
      // fill rgba (RGB not premultiplied — alpha blending handles it)
      featData[off + F.fill_r] = fc ? fc[0] : 0
      featData[off + F.fill_g] = fc ? fc[1] : 0
      featData[off + F.fill_b] = fc ? fc[2] : 0
      featData[off + F.fill_a] = fc ? fc[3] * opacity : 0
      // stroke rgba
      const sc = (perFeatureStrokes ? perFeatureStrokes[i] : null) ?? stroke
      featData[off + F.stroke_r] = sc ? sc[0] : 0
      featData[off + F.stroke_g] = sc ? sc[1] : 0
      featData[off + F.stroke_b] = sc ? sc[2] : 0
      featData[off + F.stroke_a] = sc ? sc[3] * opacity : 0
      // stroke width in UV space
      featData[off + F.stroke_width_px] = strokeWidth // raw px, shader converts to UV
      featData[off + F.flags_packed] = flags
      // [11..18] = ECEF DSFUN (pos_h.xyz, pos_l.xyz, abs_lon, abs_lat) — written per-frame in render()
      featData[off + F.shape_id] = shapeId ?? 0
    }

    // Store original coordinates in f64 for per-frame RTC computation
    const lons = new Float64Array(points.length)
    const lats = new Float64Array(points.length)
    for (let i = 0; i < points.length; i++) {
      lons[i] = points[i].lon
      lats[i] = points[i].lat
    }

    // VERTEX|COPY_DST / INDEX|COPY_DST / STORAGE|COPY_DST, byte-identical via
    // bufUsage(usage, writable:true); writeBuffer = queue.writeBuffer.
    const vertexBuffer = this.rhi.createBuffer({
      size: verts.byteLength,
      usage: 'vertex',
      writable: true,
      label: 'point-vertices',
    })
    this.rhi.writeBuffer(vertexBuffer, 0, verts)

    const indexBuffer = this.rhi.createBuffer({
      size: indices.byteLength,
      usage: 'index',
      writable: true,
      label: 'point-indices',
    })
    this.rhi.writeBuffer(indexBuffer, 0, indices)

    const featureBuffer = this.rhi.createBuffer({
      size: Math.max(featData.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'point-features',
    })
    this.rhi.writeBuffer(featureBuffer, 0, featData)

    // #834 device retirement S6 — the bind group wraps the NATIVE bgl(),
    // and points are not drawn by the forced-WebGL2 frame (no point slice in
    // #834 M5): register the layer record with an inert placeholder there so
    // scene compile never touches ctx.device. The RHI buffers above are
    // backend-neutral and keep uploading (record shape stays identical).
    const bindGroup =
      this.rhi.backend === 'webgl2'
        ? (null as unknown as RhiBindGroup)
        : this.makeBindGroup(featureBuffer)

    // Translucent iff any channel's effective alpha is < ~1. Catches both
    // top-level opacity (e.g. `opacity-30`) and color-channel alpha such as
    // `fill-amber-300/30`. Fully opaque layers with opacity=1, fill.a=1
    // and stroke.a=1 remain in the depth-writing bucket.
    const EPS = 0.999
    const fillA = fill ? fill[3] * opacity : 1
    const strokeA = stroke ? stroke[3] * opacity : 1
    const isTranslucent = opacity < EPS || fillA < EPS || strokeA < EPS

    this.layers.push({
      vertexBuffer,
      indexBuffer,
      featureBuffer,
      featData,
      lons,
      lats,
      indexCount: indices.length,
      pointCount: points.length,
      bindGroup,
      isFlat: billboard === false,
      isTranslucent,
      sizeShape: sizeShape ?? null,
      lastDynZoom: Number.NaN,
      circleTranslateX: circleTranslateX ?? 0,
      circleTranslateY: circleTranslateY ?? 0,
      circleBlur: circleBlur ?? 0,
      strokeOpacityShape: strokeOpacityShape ?? null,
      // Base stroke alpha baked into feat_data slot 8 (stroke[3] × layer
      // opacity) — the per-frame resolved stroke-opacity multiplies THIS.
      baseStrokeAlphaSlot8: stroke ? stroke[3] * opacity : 0,
      lastDynStrokeOpacityZoom: Number.NaN,
      // WS-1 — per-frame zoom-interp circle-translate. The constant
      // fallback lives in base*; updateDynamicSizes resolves the shape
      // (when animated) into circleTranslateX/Y each frame.
      circleTranslateXShape: circleTranslateXShape ?? null,
      circleTranslateYShape: circleTranslateYShape ?? null,
      baseCircleTranslateX: circleTranslateX ?? 0,
      baseCircleTranslateY: circleTranslateY ?? 0,
      lastDynTranslateZoom: Number.NaN,
      circlePitchScaleMap: circlePitchScaleMap ?? false,
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
    const STRIDE = POINT_FEAT.stride
    for (const layer of this.layers) {
      const shape = layer.sizeShape
      if (shape === null) continue
      // Skip constant / data-driven shapes — only zoom/time kinds
      // need per-frame re-resolution.
      if (
        shape.kind !== 'zoom-interpolated' &&
        shape.kind !== 'time-interpolated' &&
        shape.kind !== 'zoom-time'
      )
        continue
      const r = resolveNumberShape(shape, cameraZoom, elapsedMs)
      // Zoom-only optimization — skip when camera hasn't moved.
      // Time-animated shapes always update because elapsedMs always
      // advances.
      if (!r.hasTime && Math.abs(layer.lastDynZoom - cameraZoom) < 0.001) continue
      const size = r.value
      for (let i = 0; i < layer.pointCount; i++) {
        layer.featData[i * STRIDE + F.radius_px] = size
      }
      layer.lastDynZoom = cameraZoom
    }
    // WS-1 — per-frame zoom-interp circle-stroke-opacity. A separate loop
    // (not folded into the size loop above) because a layer may author a
    // stroke-opacity shape without a size shape — the size loop's early
    // `continue`s would otherwise skip it. Resolves the shape and writes
    // baseStrokeAlphaSlot8 × resolved into feat_data slot 8 (the stroke
    // alpha); render() re-copies slots 0–10 each frame so it propagates.
    for (const layer of this.layers) {
      const shape = layer.strokeOpacityShape
      if (shape === null) continue
      // Only zoom/time kinds need per-frame re-resolution — constant /
      // data-driven are already folded into the baked stroke colour.
      if (
        shape.kind !== 'zoom-interpolated' &&
        shape.kind !== 'time-interpolated' &&
        shape.kind !== 'zoom-time'
      )
        continue
      const r = resolveNumberShape(shape, cameraZoom, elapsedMs)
      // Zoom-only optimization — skip when the camera hasn't moved.
      if (!r.hasTime && Math.abs(layer.lastDynStrokeOpacityZoom - cameraZoom) < 0.001) continue
      const alpha = layer.baseStrokeAlphaSlot8 * Math.max(0, Math.min(1, r.value))
      for (let i = 0; i < layer.pointCount; i++) {
        layer.featData[i * STRIDE + F.stroke_a] = alpha
      }
      layer.lastDynStrokeOpacityZoom = cameraZoom
    }
    // WS-1 — per-frame zoom-interp circle-translate. Resolves the x / y
    // shapes and writes the result into layer.circleTranslateX / Y — the
    // fields writePointFrameUniform bakes to NDC (circle_params.xy) when render()
    // draws the layer next. Not feat_data: circle-translate is a frame
    // uniform, not a per-vertex attribute. A separate loop (not folded
    // into the size loop) because a layer may author a translate shape
    // without a size shape.
    for (const layer of this.layers) {
      const sx = layer.circleTranslateXShape
      const sy = layer.circleTranslateYShape
      const animatedX =
        sx !== null &&
        (sx.kind === 'zoom-interpolated' ||
          sx.kind === 'time-interpolated' ||
          sx.kind === 'zoom-time')
      const animatedY =
        sy !== null &&
        (sy.kind === 'zoom-interpolated' ||
          sy.kind === 'time-interpolated' ||
          sy.kind === 'zoom-time')
      if (!animatedX && !animatedY) continue
      const rx = animatedX ? resolveNumberShape(sx, cameraZoom, elapsedMs) : null
      const ry = animatedY ? resolveNumberShape(sy, cameraZoom, elapsedMs) : null
      const hasTime = (rx?.hasTime ?? false) || (ry?.hasTime ?? false)
      // Zoom-only optimization — skip when the camera hasn't moved.
      if (!hasTime && Math.abs(layer.lastDynTranslateZoom - cameraZoom) < 0.001) continue
      if (rx !== null) layer.circleTranslateX = rx.value
      if (ry !== null) layer.circleTranslateY = ry.value
      layer.lastDynTranslateZoom = cameraZoom
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

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)

    const DEG2RAD = Math.PI / 180

    const STRIDE = POINT_FEAT.stride
    // Flat Mercator (projType 0) fans out to all visible world copies so
    // GeoJSON points appear in every repeated world at low zoom — matching
    // the label and fill behaviour.  All other projection paths use a single
    // absolute world (ECEF globe / hemisphere projections have no world-wrap).
    const COPIES = pointWorldCopies(projType, camera, canvasWidth, canvasHeight, dpr)

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
      const u32Verts = new Uint32Array(
        expandedVerts.buffer,
        expandedVerts.byteOffset,
        expandedVerts.length,
      )

      // Depth-sort keys for translucent layers only (opaque uses feature
      // order — the depth test handles occlusion). Allocated by this method
      // (arena-backed) and filled by the packer.
      const depths = layer.isTranslucent ? this._frameArena.allocF32(totalPoints) : null

      // Assemble the stride-24 records + world-copy fan-out + quad verts/indices
      // + (translucent) back-to-front depth-sorted order via the shared stateless
      // packer (#722 S0). Byte-identical to the former inline loop; this method
      // still owns the arena allocation above + the GPU buffer create/write below.
      packPointInstances(
        {
          count: N,
          copies: COPIES,
          isTranslucent: layer.isTranslucent,
          fwdX,
          fwdY,
          srcFeatData: layer.featData,
          position: { kind: 'lonlat', lons: layer.lons, lats: layer.lats },
        },
        { verts: expandedVerts, u32: u32Verts, idx: expandedIdx, feat: expandedFeat, depths },
      )

      // Reuse or recreate GPU buffers sized for 3× points. VERTEX|COPY_DST /
      // INDEX|COPY_DST / STORAGE|COPY_DST, byte-identical via bufUsage(usage,
      // writable:true); destroyBuffer = GPUBuffer.destroy().
      if (!layer._expandedVertBuf || layer._expandedSize !== totalPoints) {
        if (layer._expandedVertBuf) this.rhi.destroyBuffer(layer._expandedVertBuf)
        if (layer._expandedIdxBuf) this.rhi.destroyBuffer(layer._expandedIdxBuf)
        if (layer._expandedFeatBuf) this.rhi.destroyBuffer(layer._expandedFeatBuf)
        layer._expandedVertBuf = this.rhi.createBuffer({
          size: expandedVerts.byteLength,
          usage: 'vertex',
          writable: true,
          label: 'point-expanded-vertices',
        })
        layer._expandedIdxBuf = this.rhi.createBuffer({
          size: expandedIdx.byteLength,
          usage: 'index',
          writable: true,
          label: 'point-expanded-indices',
        })
        layer._expandedFeatBuf = this.rhi.createBuffer({
          size: Math.max(expandedFeat.byteLength, 16),
          usage: 'storage',
          writable: true,
          label: 'point-expanded-features',
        })
        layer._expandedSize = totalPoints
      }

      this.rhi.writeBuffer(layer._expandedVertBuf!, 0, expandedVerts)
      this.rhi.writeBuffer(layer._expandedIdxBuf!, 0, expandedIdx)
      this.rhi.writeBuffer(layer._expandedFeatBuf!, 0, expandedFeat)
      return totalPoints
    }

    const drawLayer = (layer: PointLayer, variant: number, totalPoints: number) => {
      // Write per-layer uniform (circle_params may differ between layers).
      writePointFrameUniform(
        this.frameBlock,
        frame,
        camera,
        projType,
        projCenterLon,
        projCenterLat,
        canvasWidth,
        canvasHeight,
        dpr,
        layer.circleTranslateX,
        layer.circleTranslateY,
        layer.circleBlur,
        layer.circlePitchScaleMap,
      )
      this.rhi.writeBuffer(this.uniformBuffer, 0, this.frameBlock.buffer)
      // Through the RHI Material seam (P1: the sole path), same as the tile-point draw.
      // ShapeRegistry shape/seg are RhiBuffer (step 3c) → passed directly; the empty
      // fallback is a point-owned RhiBuffer.
      const shapeBuf = this.shapeRegistry?.shapeBuffer
      const segBuf = this.shapeRegistry?.segmentBuffer
      this.ensurePointDraper()
      this._pointDraper!.draw(wrapWebGpuPass(pass), {
        uniform: this.uniformBuffer,
        feat: layer._expandedFeatBuf!,
        shape: shapeBuf ?? this.emptyStorageBuf(),
        seg: segBuf ?? this.emptyStorageBuf(),
        vertex: layer._expandedVertBuf!,
        index: layer._expandedIdxBuf!,
        indexCount: totalPoints * 6,
        variant,
      })
    }

    // Upload every layer's buffers first (cheap; writes don't depend on
    // phase order), then run two draw phases.
    const totals = this.layers.map(uploadLayer)

    // Phase 1 — opaque billboards write depth so they correctly occlude
    // other opaque geometry regardless of declaration order.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (layer.isFlat || layer.isTranslucent) continue
      drawLayer(layer, 0, totals[i])
    }

    // Phase 2 — translucent billboards + flat layers blend on top without
    // writing depth. Declaration order is preserved within this phase so
    // authors still get painter's-order control for overlapping halos.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (!layer.isFlat && !layer.isTranslucent) continue
      drawLayer(layer, layer.isFlat ? 2 : 1, totals[i])
    }
  }
}
