// ═══ SDF Point Renderer ═══
// Renders Point/MultiPoint features as resolution-independent circles
// using Signed Distance Field math in the fragment shader.
// Single draw call for all points via per-feature storage buffer.

import type { Camera } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/engine'
import { isWebMercator } from '@xgis/engine'
import { WORLD_MERC, TILE_PX } from '@xgis/engine'
import { getSampleCount } from '@xgis/engine'
import type { ShapeRegistry } from '../text/sdf-shape'
import { parseHexColor } from '../feature-helpers'
import { resolveNumberShape } from './paint-shape-resolve'
import { FrameArena } from '@xgis/engine'
import type { PointLayer } from './point-renderer-types'
import { buildPointModule } from '@xgis/map'
import { wrapWebGpuPass, wrapWebGpuBindGroupLayout } from '@xgis/engine'
import type { RhiBuffer, RhiBindGroup, RhiDevice } from '@xgis/engine'
import { PointDraper } from '@xgis/map'
import { reflect } from '@xgis/shader-dsl'
import { vertexField } from '@xgis/compiler'
import { POINT_FORMAT } from '@xgis/map'
import { toVertexBufferLayout } from '@xgis/engine'
import { reflectionToBindGroupLayoutEntries, uniformFieldSlots } from '@xgis/engine'
import { writeProjectionCull } from './frame-projection-uniform'

// Float-slot indices derived from the single-source POINT_FORMAT spec so the
// packer cannot drift from the GPUVertexBufferLayout / vs_point @location.
const POINT_FLOATS_PER_VERT = POINT_FORMAT.stride / 4                        // 4
const POINT_CENTER_FLOAT = vertexField(POINT_FORMAT, 'center').offset / 4    // 0 (x,y = 0,1)
const POINT_QUADID_FLOAT = vertexField(POINT_FORMAT, 'quad_id').offset / 4   // 2
const POINT_FEATID_FLOAT = vertexField(POINT_FORMAT, 'feat_id').offset / 4   // 3

// ── Reflection-driven bind-group layout + uniform field offsets ──
// reflect(buildPointModule()) recovers, from the SAME IR the WGSL is emitted
// from, the @group(0) bind entries and the std140 `Uniforms` struct byte
// layout. Sourcing the layout entries + the per-field f32 slots from there makes
// the hand-maintained drift that the point path once carried (viewport @20 vs
// @24) structurally impossible — the packer writes each field at its reflected
// slot.
//
// LAZY + memoized: buildPointModule() gathers the injection-deferred projection
// funcs (getGpuProjectionFuncs), which require configureProjections() to have
// run first. Reflecting at module-load time would fire that emit before the app
// configures projections (the same reason buildPointModule is a build-fn). So
// the reflection is computed on first use (constructor / first frame), by which
// point configureProjections() has run.
interface PointUniformSlots {
  readonly mvp: number; readonly proj: number; readonly viewport: number
  readonly camH: number; readonly camL: number; readonly circle: number
  // #600 — globe(7) eye-horizon cull dir (normalize(eye), R/|eye|).
  readonly eye: number
  readonly slots: number
}
let _pointReflection: ReturnType<typeof reflect> | null = null
let _pointSlots: PointUniformSlots | null = null
function pointReflection(): ReturnType<typeof reflect> {
  return (_pointReflection ??= reflect(buildPointModule()))
}
/** Memoized std140 `Uniforms` field → f32 slot (byteOffset / 4) + slot count. */
function pointUniformSlots(): PointUniformSlots {
  if (_pointSlots) return _pointSlots
  const u = uniformFieldSlots(pointReflection(), 'Uniforms')
  return (_pointSlots = {
    mvp: u.slot.mvp, proj: u.slot.proj_params, viewport: u.slot.viewport,
    camH: u.slot.cam_ecef_h, camL: u.slot.cam_ecef_l, circle: u.slot.circle_params,
    eye: u.slot.globe_eye,
    slots: u.slots,
  })
}
/** Canonical point `Uniforms` byte size, derived from reflect() (= slots × 4).
 *  Exported so wiring tests size/identify the global uniform write from the SAME
 *  reflect source the renderer uses, not a hand-coded 160. LAZY (calls
 *  pointUniformSlots → reflect → projection emit) — call only post-configureProjections. */
export function pointUniformBytes(): number {
  return pointUniformSlots().slots * 4
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

/** Pack the point frame uniform (shared by render() and flushTilePoints()).
 *  Layout (f32 slots): mvp 0..15, proj_params 16..19, viewport 20..23,
 *  cam_ecef_h 24..27, cam_ecef_l 28..31, circle_params 32..35.
 *
 *  Two fixes live here: (1) viewport now lands at 20..23 — it was previously
 *  written at 24..27, past the old Float32Array(24) bound, so the shader read
 *  an all-zero viewport (NDC quad expansion divided by zero). (2) cam_ecef_h/l
 *  carry the camera anchor (getECEFCenter, sphere) split DSFUN so the VS can
 *  re-center the now-ABSOLUTE per-feature ECEF against the camera-at-ENU-origin
 *  MVP via (ecefH−camH)+(ecefL−camL).
 *
 *  circle_params @32-35: x=translate_x_ndc, y=translate_y_ndc, z=blur_px, w=0.
 *  translate_x/y are pre-baked as NDC-per-pixel (px * 2 / w/h), same
 *  convention as fill_translate in polygon.ts. Default [0,0,0,0] = no-op. */
function writePointFrameUniform(
  uf: Float32Array,
  // #600 — frame.eye is the absolute sphere-ECEF camera position (globe/ECEF
  // branch only; undefined on flat) for the globe(7) eye-horizon cull.
  frame: { matrix: Float32Array; logDepthFc: number; eye?: readonly [number, number, number] },
  camera: Camera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  canvasWidth: number,
  canvasHeight: number,
  circleTranslateX = 0,
  circleTranslateY = 0,
  circleBlur = 0,
  circlePitchScaleMap = false,
): void {
  // Field base slots are sourced from reflect(buildPointModule()) (the std140
  // Uniforms struct), not hand-counted — so the packer cannot drift from the
  // WGSL struct it shares an IR with.
  const { mvp: U_MVP, proj: U_PROJ, viewport: U_VIEWPORT, camH: U_CAM_H, camL: U_CAM_L, circle: U_CIRCLE, eye: U_EYE } = pointUniformSlots()
  uf.set(frame.matrix, U_MVP)
  // proj_params + globe_eye written TOGETHER (coupled so a missing globe_eye —
  // the #600 leak class — is unrepresentable). frame.eye is set only on the
  // globe/ECEF branch → globe_eye all-zero on flat (flat/disc cull arms ignore it).
  writeProjectionCull(uf, U_PROJ, U_EYE, projType, projCenterLon, projCenterLat, frame.eye, 0)
  const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, camera.zoom)
  uf[U_VIEWPORT] = canvasWidth; uf[U_VIEWPORT + 1] = canvasHeight; uf[U_VIEWPORT + 2] = metersPerPixel; uf[U_VIEWPORT + 3] = frame.logDepthFc
  // Camera centre for the per-vertex re-centring. Flat Mercator (projType 0)
  // uses the 2D Mercator centre (camera.centerX/Y) split DSFUN into the .xy
  // lanes — the flat VS does rel = project(abs) − (cam_ecef_h.xy + cam_ecef_l.xy)
  // and ignores .z. 3D / globe uses the ECEF anchor (getECEFCenter, sphere).
  if (projType === 0) {
    const cmx = camera.centerX, cmy = camera.centerY
    const cmxH = Math.fround(cmx), cmyH = Math.fround(cmy)
    uf[U_CAM_H] = cmxH; uf[U_CAM_H + 1] = cmyH; uf[U_CAM_H + 2] = 0; uf[U_CAM_H + 3] = 0
    uf[U_CAM_L] = cmx - cmxH; uf[U_CAM_L + 1] = cmy - cmyH; uf[U_CAM_L + 2] = 0; uf[U_CAM_L + 3] = 0
  } else {
    const camC = camera.getECEFCenter()
    const cxH = Math.fround(camC[0]); const cyH = Math.fround(camC[1]); const czH = Math.fround(camC[2])
    uf[U_CAM_H] = cxH; uf[U_CAM_H + 1] = cyH; uf[U_CAM_H + 2] = czH; uf[U_CAM_H + 3] = 0
    uf[U_CAM_L] = camC[0] - cxH; uf[U_CAM_L + 1] = camC[1] - cyH; uf[U_CAM_L + 2] = camC[2] - czH; uf[U_CAM_L + 3] = 0
  }
  // circle_params @32-35: translate_x_ndc, translate_y_ndc, blur_px, _unused.
  // Bake translate from CSS-px to NDC-per-pixel (multiply by clip.w in VS).
  // Negate y because NDC y is UP (screen y is DOWN).
  uf[U_CIRCLE] = canvasWidth  > 0 ? (circleTranslateX * 2) / canvasWidth  : 0
  uf[U_CIRCLE + 1] = canvasHeight > 0 ? -(circleTranslateY * 2) / canvasHeight : 0
  uf[U_CIRCLE + 2] = circleBlur
  // circle_params.w: circle-pitch-scale flag. 0 = viewport (default —
  // radius constant in screen px, byte-identical). 1 = map (the point VS
  // scales the quad expansion by w_ref/clip.w = mvp[3][3]/clip.w so circles
  // foreshorten with pitch/distance, matching MapLibre's pitch-scale:map).
  uf[U_CIRCLE + 3] = circlePitchScaleMap ? 1 : 0
  // (proj_params + globe_eye written together above via writeProjectionCull.)
}

// ── World-copy helpers (exported for unit tests) ──────────────────────────

const _DEG2RAD = Math.PI / 180
const _R_MERC  = 6378137 // web-Mercator sphere radius (matches the tiler packer)

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

/**
 * Returns the Mercator x (in metres) for a point at `lon` (degrees) in
 * world-copy `wo`.  `wo = 0` is the primary world; `wo = ±1, ±2, …` shift
 * by one full world-width (360° × DEG2RAD × R_MERC) each.
 * The caller is responsible for splitting into hi/lo f32 DSFUN slots.
 */
export function worldCopyMercX(lon: number, wo: number): number {
  return lon * _DEG2RAD * _R_MERC + wo * 360 * _DEG2RAD * _R_MERC
}

// ═══ Renderer ═══

export class PointRenderer {
  /** The RHI seam (§4 batch-seam migration). One instance, reused for the point
   *  resources (uniform + per-frame vertex/index/feature buffers + the empty-shape
   *  fallback + the bind groups) and the PointDraper. On WebGPU `createBuffer ===
   *  device.createBuffer`, `createBindGroup === device.createBindGroup`,
   *  `writeBuffer === queue.writeBuffer`, `destroyBuffer === GPUBuffer.destroy()`,
   *  so the GPU command stream is byte-identical. */
  private readonly rhi: RhiDevice
  private bindGroupLayout: GPUBindGroupLayout
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
  private uniformData = new Float32Array(pointUniformSlots().slots)
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
    const { device } = ctx

    this.bindGroupLayout = device.createBindGroupLayout({
      // Entries sourced from reflect(buildPointModule()) — binding numbers +
      // buffer types come from the shader's own IR (see buildPointBglEntries);
      // the renderer supplies only the per-binding stage visibility.
      entries: buildPointBglEntries(),
    })

    this.format = ctx.format

    // Derived from the single-source POINT_FORMAT spec (vs_point @location + packer
    // derive from the same spec, so they cannot drift). The point draw goes through the
    // RHI Material seam (PointDraper, which owns the pipelines + their depth-bias variants);
    // this layout feeds ensurePointDraper.
    this.vertexBufferLayout = toVertexBufferLayout(POINT_FORMAT)

    // reflected std140 Uniforms size (40 slots × 4 = 160 bytes after #600 globe_eye).
    // UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.uniformBuffer = this.rhi.createBuffer({
      size: pointUniformSlots().slots * 4,
      usage: 'uniform', writable: true,
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
  private makeBindGroup(featBuffer: RhiBuffer): RhiBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const segBuf = this.shapeRegistry?.segmentBuffer
    return this.rhi.createBindGroup(wrapWebGpuBindGroupLayout(this.bindGroupLayout), [
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
    return this._emptyStorageBuf ??= this.rhi.createBuffer({
      size: 64, usage: 'storage', writable: false, label: 'empty-shape-buf',
    })
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
    const vertexBuffers = [{
      stride: vbl.arrayStride,
      attributes: [...vbl.attributes].map((a) => ({ location: a.shaderLocation, offset: a.offset, format: a.format as string })),
    }]
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
  private tilePoints: { exH: number; eyH: number; ezH: number; exL: number; eyL: number; ezL: number; featId: number; absLon: number; absLat: number; mxH: number; mxL: number; myH: number; myL: number }[] = []
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

  /** Accumulate a point from a visible tile (ECEF DSFUN components). */
  addTilePoint(exH: number, eyH: number, ezH: number, exL: number, eyL: number, ezL: number, featId: number, absLon: number, absLat: number, mxH: number, mxL: number, myH: number, myL: number): void {
    this.tilePoints.push({ exH, eyH, ezH, exL, eyL, ezL, featId, absLon, absLat, mxH, mxL, myH, myL })
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
    show: { fill?: string | null; stroke?: string | null; strokeWidth?: number; size?: number | null; opacity?: number; circleTranslateX?: number; circleTranslateY?: number; circleBlur?: number; circlePitchScaleMap?: boolean; circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number> | null; circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number> | null; circleStrokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null },
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
    // WS-1 — per-frame zoom-interp on the tile-point path (mirror of the
    // GeoJSON updateDynamicSizes path). flushTilePoints rebakes feat_data +
    // the frame uniform every frame, so resolve the shapes here. These are
    // zoom-only, so elapsedMs=0 is fine.
    const tileStrokeOpacity = show.circleStrokeOpacityShape
      ? Math.max(0, Math.min(1, resolveNumberShape(show.circleStrokeOpacityShape, camera.zoom, 0).value))
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

    // Phase 2 PR 2d.2 — ECEF DSFUN: one world copy (ECEF is absolute,
    // no Mercator world-wrapping needed).
    const STRIDE = 24
    const COPIES = [0]
    const totalN = N * COPIES.length

    // iter-249 (Plan AAA B.2) — arena-backed scratch. Pre-iter-249
    // each flush allocated 3 fresh typed arrays per call; now they
    // share one ArrayBuffer that grows to per-session peak.
    this._frameArena.beginFrame()
    const verts = this._frameArena.allocF32(totalN * 4 * 4)
    const indices = this._frameArena.allocU32(totalN * 6)
    const featData = this._frameArena.allocF32(totalN * STRIDE)
    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)

    for (let i = 0; i < N; i++) {
      const pt = this.tilePoints[i]

      const base = i * 4 * 4
      for (let q = 0; q < 4; q++) {
        const off = base + q * 4
        verts[off] = 0; verts[off + 1] = 0; u32View[off + 2] = q; verts[off + 3] = i
      }

      const iBase = i * 6, vBase = i * 4
      indices[iBase] = vBase; indices[iBase+1] = vBase+1; indices[iBase+2] = vBase+2
      indices[iBase+3] = vBase; indices[iBase+4] = vBase+2; indices[iBase+5] = vBase+3

      const fOff = i * STRIDE
      featData[fOff+0] = radiusPx
      featData[fOff+1] = fill?fill[0]:0; featData[fOff+2] = fill?fill[1]:0
      featData[fOff+3] = fill?fill[2]:0; featData[fOff+4] = fill?fill[3]*opacity:0
      featData[fOff+5] = stroke?stroke[0]:0; featData[fOff+6] = stroke?stroke[1]:0
      featData[fOff+7] = stroke?stroke[2]:0; featData[fOff+8] = stroke?stroke[3]*opacity*tileStrokeOpacity:0
      featData[fOff+9] = strokeWidth; featData[fOff+10] = flags
      // ECEF DSFUN: pos_h.xyz at 11-13, pos_l.xyz at 14-16, abs_lon at 17, abs_lat at 18, shape_id at 19
      featData[fOff+11] = pt.exH; featData[fOff+12] = pt.eyH; featData[fOff+13] = pt.ezH
      featData[fOff+14] = pt.exL; featData[fOff+15] = pt.eyL; featData[fOff+16] = pt.ezL
      featData[fOff+17] = pt.absLon; featData[fOff+18] = pt.absLat
      featData[fOff+19] = 0 // shape_id (circle default for tile points)
      // Absolute Mercator DSFUN at 20-23 — precise flat-Mercator position so
      // the flat-Merc VS no longer reprojects the lossy abs_lon/abs_lat.
      featData[fOff+20] = pt.mxH; featData[fOff+21] = pt.mxL
      featData[fOff+22] = pt.myH; featData[fOff+23] = pt.myL
    }

    // Defer destroy of the previous frame's buffers — see
    // retiredTilePointBuffers comment. Drained at the start of the
    // next frame via beginFrame() once the prior submit has
    // completed.
    if (this.tilePointBuffer) this.retiredTilePointBuffers.push(this.tilePointBuffer)
    if (this.tilePointIndexBuffer) this.retiredTilePointBuffers.push(this.tilePointIndexBuffer)
    if (this.tilePointFeatBuffer) this.retiredTilePointBuffers.push(this.tilePointFeatBuffer)

    // VERTEX|COPY_DST / INDEX|COPY_DST / STORAGE|COPY_DST, byte-identical via
    // bufUsage(usage, writable:true); writeBuffer = queue.writeBuffer.
    this.tilePointBuffer = this.rhi.createBuffer({ size: verts.byteLength, usage: 'vertex', writable: true, label: 'tile-point-vertices' })
    this.rhi.writeBuffer(this.tilePointBuffer, 0, verts)
    this.tilePointIndexBuffer = this.rhi.createBuffer({ size: indices.byteLength, usage: 'index', writable: true, label: 'tile-point-indices' })
    this.rhi.writeBuffer(this.tilePointIndexBuffer, 0, indices)
    this.tilePointFeatBuffer = this.rhi.createBuffer({ size: Math.max(featData.byteLength, 16), usage: 'storage', writable: true, label: 'tile-point-features' })
    this.rhi.writeBuffer(this.tilePointFeatBuffer, 0, featData)

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const uf = this.uniformData
    writePointFrameUniform(uf, frame, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight, tileTranslateX, tileTranslateY, show.circleBlur ?? 0, show.circlePitchScaleMap ?? false)
    this.rhi.writeBuffer(this.uniformBuffer, 0, uf)

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
      uniform: this.uniformBuffer, feat: this.tilePointFeatBuffer!,
      shape: shapeBuf ?? this.emptyStorageBuf(),
      seg: segBuf ?? this.emptyStorageBuf(),
      vertex: this.tilePointBuffer!, index: this.tilePointIndexBuffer!,
      indexCount: totalN * 6, variant: tileIsTranslucent ? 1 : 0,
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
    circleTranslateX?: number,
    circleTranslateY?: number,
    circleBlur?: number,
    strokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number> | null,
    circlePitchScaleMap?: boolean,
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
    const verts = this._frameArena.allocF32(points.length * 4 * POINT_FLOATS_PER_VERT) // 4 verts/quad
    const indices = this._frameArena.allocU32(points.length * 6)

    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)
    for (let i = 0; i < points.length; i++) {
      const base = i * 4 * POINT_FLOATS_PER_VERT // 4 verts/quad
      const { lon, lat } = points[i]
      for (let q = 0; q < 4; q++) {
        const off = base + q * POINT_FLOATS_PER_VERT
        verts[off + POINT_CENTER_FLOAT]     = lon
        verts[off + POINT_CENTER_FLOAT + 1] = lat
        u32View[off + POINT_QUADID_FLOAT] = q  // quad_id as uint32 (4-byte element, same slot)
        verts[off + POINT_FEATID_FLOAT] = i    // feat_id as float32
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
    // absolute Mercator DSFUN tail at 20-23 for precise flat-Mercator position)
    const STRIDE = 24
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
      // [11..18] = ECEF DSFUN (pos_h.xyz, pos_l.xyz, abs_lon, abs_lat) — written per-frame in render()
      featData[off + 19] = shapeId ?? 0
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
    const vertexBuffer = this.rhi.createBuffer({ size: verts.byteLength, usage: 'vertex', writable: true, label: 'point-vertices' })
    this.rhi.writeBuffer(vertexBuffer, 0, verts)

    const indexBuffer = this.rhi.createBuffer({ size: indices.byteLength, usage: 'index', writable: true, label: 'point-indices' })
    this.rhi.writeBuffer(indexBuffer, 0, indices)

    const featureBuffer = this.rhi.createBuffer({ size: Math.max(featData.byteLength, 16), usage: 'storage', writable: true, label: 'point-features' })
    this.rhi.writeBuffer(featureBuffer, 0, featData)

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
    const STRIDE = 24
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
      if (shape.kind !== 'zoom-interpolated'
          && shape.kind !== 'time-interpolated'
          && shape.kind !== 'zoom-time') continue
      const r = resolveNumberShape(shape, cameraZoom, elapsedMs)
      // Zoom-only optimization — skip when the camera hasn't moved.
      if (!r.hasTime && Math.abs(layer.lastDynStrokeOpacityZoom - cameraZoom) < 0.001) continue
      const alpha = layer.baseStrokeAlphaSlot8 * Math.max(0, Math.min(1, r.value))
      for (let i = 0; i < layer.pointCount; i++) {
        layer.featData[i * STRIDE + 8] = alpha
      }
      layer.lastDynStrokeOpacityZoom = cameraZoom
    }
    // WS-1 — per-frame zoom-interp circle-translate. Resolves the x / y
    // shapes and writes the result into layer.circleTranslateX / Y — the
    // fields writePointFrameUniform bakes to NDC (uf 32/33) when render()
    // draws the layer next. Not feat_data: circle-translate is a frame
    // uniform, not a per-vertex attribute. A separate loop (not folded
    // into the size loop) because a layer may author a translate shape
    // without a size shape.
    for (const layer of this.layers) {
      const sx = layer.circleTranslateXShape
      const sy = layer.circleTranslateYShape
      const animatedX = sx !== null
        && (sx.kind === 'zoom-interpolated' || sx.kind === 'time-interpolated' || sx.kind === 'zoom-time')
      const animatedY = sy !== null
        && (sy.kind === 'zoom-interpolated' || sy.kind === 'time-interpolated' || sy.kind === 'zoom-time')
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
    const uf = this.uniformData

    const DEG2RAD = Math.PI / 180
    const R_MERC = 6378137 // web-Mercator sphere radius (matches the tiler packer)

    const STRIDE = 24
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
      const u32Verts = new Uint32Array(expandedVerts.buffer, expandedVerts.byteOffset, expandedVerts.length)

      // Pre-compute each instance's view-forward depth so we can write
      // the index buffer in back-to-front order. Only translucent layers
      // actually need this (opaque depth-test handles occlusion); for
      // opaque we skip the sort and keep feature-index order.
      const depths = layer.isTranslucent ? this._frameArena.allocF32(totalPoints) : null
      const order = layer.isTranslucent ? this._frameArena.allocU32(totalPoints) : null

      for (let w = 0; w < COPIES.length; w++) {
        const basePoint = w * N

        for (let i = 0; i < N; i++) {
          const lon = layer.lons[i]
          const lat = layer.lats[i]

          // ECEF DSFUN: absolute ECEF with hi/lo split around origin.
          const ecef = lonLatToECEF(lon, lat)
          const exH = Math.fround(ecef[0]); const exL = ecef[0] - exH
          const eyH = Math.fround(ecef[1]); const eyL = ecef[1] - eyH
          const ezH = Math.fround(ecef[2]); const ezL = ecef[2] - ezH

          // Copy style data from original (slots 0-10)
          const srcOff = i * STRIDE
          const globalIdx = basePoint + i
          const dstOff = globalIdx * STRIDE
          expandedFeat.set(layer.featData.subarray(srcOff, srcOff + 11), dstOff)
          // ECEF DSFUN at slots 11-16, abs_lon/lat at 17-18, shape_id at 19
          expandedFeat[dstOff + 11] = exH; expandedFeat[dstOff + 12] = eyH; expandedFeat[dstOff + 13] = ezH
          expandedFeat[dstOff + 14] = exL; expandedFeat[dstOff + 15] = eyL; expandedFeat[dstOff + 16] = ezL
          expandedFeat[dstOff + 17] = lon; expandedFeat[dstOff + 18] = lat
          expandedFeat[dstOff + 19] = layer.featData[srcOff + 19] // shape_id
          // Absolute Mercator DSFUN (20-23) — precise flat-Mercator position.
          // For world copies (projType 0) apply a per-copy longitude offset
          // of wo*360° in Mercator metres so the point appears in every visible
          // world repeat.  The ECEF/abs_lon branches above are copy-independent
          // (absolute 3D position) and are left unchanged.
          const wo = COPIES[w]
          const mx = worldCopyMercX(lon, wo)
          const myClamp = Math.max(-85.051129, Math.min(85.051129, lat))
          const my = Math.log(Math.tan(Math.PI / 4 + myClamp * DEG2RAD / 2)) * R_MERC
          const mxH = Math.fround(mx); const myH = Math.fround(my)
          expandedFeat[dstOff + 20] = mxH; expandedFeat[dstOff + 21] = Math.fround(mx - mxH)
          expandedFeat[dstOff + 22] = myH; expandedFeat[dstOff + 23] = Math.fround(my - myH)

          // Build quad vertices
          const vBase = globalIdx * 4 * 4
          for (let q = 0; q < 4; q++) {
            const off = vBase + q * 4
            expandedVerts[off + 0] = 0
            expandedVerts[off + 1] = 0
            u32Verts[off + 2] = q
            expandedVerts[off + 3] = globalIdx
          }

          // Depth sort key: use ECEF z-component as a proxy for back-to-front.
          // (more negative ez_h = further from viewer in most projections)
          if (depths && order) {
            depths[globalIdx] = exH * fwdX + eyH * fwdY
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

      // Reuse or recreate GPU buffers sized for 3× points. VERTEX|COPY_DST /
      // INDEX|COPY_DST / STORAGE|COPY_DST, byte-identical via bufUsage(usage,
      // writable:true); destroyBuffer = GPUBuffer.destroy().
      if (!layer._expandedVertBuf || layer._expandedSize !== totalPoints) {
        if (layer._expandedVertBuf) this.rhi.destroyBuffer(layer._expandedVertBuf)
        if (layer._expandedIdxBuf) this.rhi.destroyBuffer(layer._expandedIdxBuf)
        if (layer._expandedFeatBuf) this.rhi.destroyBuffer(layer._expandedFeatBuf)
        layer._expandedVertBuf = this.rhi.createBuffer({ size: expandedVerts.byteLength, usage: 'vertex', writable: true, label: 'point-expanded-vertices' })
        layer._expandedIdxBuf = this.rhi.createBuffer({ size: expandedIdx.byteLength, usage: 'index', writable: true, label: 'point-expanded-indices' })
        layer._expandedFeatBuf = this.rhi.createBuffer({ size: Math.max(expandedFeat.byteLength, 16), usage: 'storage', writable: true, label: 'point-expanded-features' })
        layer._expandedSize = totalPoints
      }

      this.rhi.writeBuffer(layer._expandedVertBuf!, 0, expandedVerts)
      this.rhi.writeBuffer(layer._expandedIdxBuf!, 0, expandedIdx)
      this.rhi.writeBuffer(layer._expandedFeatBuf!, 0, expandedFeat)
      return totalPoints
    }

    const drawLayer = (layer: PointLayer, variant: number, totalPoints: number) => {
      // Write per-layer uniform (circle_params may differ between layers).
      writePointFrameUniform(uf, frame, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight, layer.circleTranslateX, layer.circleTranslateY, layer.circleBlur, layer.circlePitchScaleMap)
      this.rhi.writeBuffer(this.uniformBuffer, 0, uf)
      // Through the RHI Material seam (P1: the sole path), same as the tile-point draw.
      // ShapeRegistry shape/seg are RhiBuffer (step 3c) → passed directly; the empty
      // fallback is a point-owned RhiBuffer.
      const shapeBuf = this.shapeRegistry?.shapeBuffer
      const segBuf = this.shapeRegistry?.segmentBuffer
      this.ensurePointDraper()
      this._pointDraper!.draw(wrapWebGpuPass(pass), {
        uniform: this.uniformBuffer, feat: layer._expandedFeatBuf!,
        shape: shapeBuf ?? this.emptyStorageBuf(),
        seg: segBuf ?? this.emptyStorageBuf(),
        vertex: layer._expandedVertBuf!, index: layer._expandedIdxBuf!,
        indexCount: totalPoints * 6, variant,
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
