// ═══ GraticuleRenderer — lat/lon grid overlay ═══
//
// Extracted VERBATIM from MapRenderer (renderer.ts) — the graticule overlay
// is an orthogonal decoration that owns its own GPU-buffer lifecycle +
// zoom-bucket regeneration + WeakMap cache, and only borrows the layer
// path's `linePipeline` + base `bindGroup` + `UniformRing` per frame (passed
// in as call arguments — this collaborator holds NO MapRenderer
// back-reference).
//
// DO-NOT-SPLIT (renderer-decomposition-2026-06-09 §6 #1): the per-frame
// uniform write uses the SAME 240-byte std140 struct offsets as the layer
// path. The packed frame values (mvp / logDepthFc / proj_params / zoom) are
// PASSED IN; the offsets are NOT re-derived or changed.

import type { GPUContext } from '@xgis/rhi-webgpu'
import {
  uniformBlock,
  executeItems,
  Material,
  type UniformBlockOf,
  type RhiDevice,
  type RhiRenderPass,
  type RhiBuffer,
  type RhiBindGroup,
} from '@xgis/engine'
import { toVertexBufferLayout } from '@xgis/rhi-webgpu'
import { isGlobeProj, lonLatToMercator } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import { generateGraticule } from '../graticule'
import { visibleWorldCopiesFor, type VisibleWorldCopiesHost } from '../camera/camera-world-copies'
import { UniformRing } from './uniform-ring'
import { polygonU as POLYGON_U, emitPolygonWgsl, emitPolygonGlsl } from '../shaders/dsl/polygon'
import { polygonUniformBytes } from './polygon-uniform-slots'
import { buildGraticuleLineMaterial } from './material/polygon-fill-material'
import { LINE_FORMAT } from './line-vertex-format'
import { globeEyeUniform } from './globe-eye-uniform'

// Typed pack target for the shared polygon 'Uniforms' struct (#733 P2c) — layout
// from wgslLayout(U.struct), module-free, so constructing it never triggers the
// projection emit; write() is typed by the same field record the WGSL is emitted
// from (completeness compile-time — the #600 globe_eye class does not compile).
// LAZY memo (draw time), same discipline as the reflect() slots it replaces.
let _gratBlock: UniformBlockOf<typeof POLYGON_U> | null = null
function gratBlock(): UniformBlockOf<typeof POLYGON_U> {
  return (_gratBlock ??= uniformBlock(POLYGON_U))
}

/** globe_eye for the flat-display copies (#729): the flat / disc cull arms
 *  ignore it, so it stays all-zero — only the globe(7) ECEF pass packs a live
 *  eye (globeEyeUniform(frame.eye)). */
const NO_GLOBE_EYE: readonly [number, number, number, number] = [0, 0, 0, 0]

/** Per-frame data the graticule draw needs from the coordinator. The
 *  graticule reuses the SAME 240-byte uniform struct offsets as the layer
 *  path — these are the packed values written at those offsets, never
 *  re-derived here. */
export interface GraticuleFrame {
  /** ECEF-MVP (frame.matrix) — written at byte 0. */
  mvp: Float32Array | number[]
  /** frame.logDepthFc — written at byte 140 (offset 128, slot 3). */
  logDepthFc: number
  /** proj_params.x — written at byte 96. */
  projType: number
  /** proj_params.y — written at byte 100. */
  projCenterLon: number
  /** proj_params.z — written at byte 104. */
  projCenterLat: number
  /** camera.zoom — drives zoom-bucket regeneration. */
  zoom: number
  /** #600 — absolute sphere-ECEF camera position (frame.eye) for the globe(7)
   *  eye-horizon cull, written into the globe_eye slot. Undefined off the globe
   *  (flat/disc cull arms ignore it). */
  eye?: readonly [number, number, number]
}

/** Minimal camera surface the graticule draw reads (#729). Extends the
 *  world-copy router host with the display-projection MVP selector so the flat
 *  path picks the flat 2D-plane MVP (`getViewForProjection` routes flat 0-6 →
 *  the Mercator-metre matrix, globe/tilted → the ECEF matrix). Structurally
 *  satisfied by `Camera`; a stub satisfies it in tests. Only `.matrix` +
 *  `.logDepthFc` are read, so the return shape is intentionally narrow. */
export interface GraticuleCamera extends VisibleWorldCopiesHost {
  getViewForProjection(
    projType: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): { matrix: Float32Array | number[]; logDepthFc: number }
}

export class GraticuleRenderer {
  // Polygon Uniforms struct byte size is read LAZILY at draw time via
  // polygonUniformBytes() (memoised) — see drawGraticule below. It is derived
  // from reflect() so it tracks the struct automatically (the borrowed
  // linePipeline's shader references u up to the last field, so the bound range
  // must cover the full struct size; RTC fields + light_dir_ecef stay zero —
  // graticule lines never extrude).
  // MUST stay lazy: polygonUniformBytes() → polygonUniformSlots() →
  // reflect(buildPolygonModule) EMITS the projection fns, which throws until
  // configureProjections() has run (post-GPU-init). A `static readonly` field
  // evaluates at class-definition (import) time — before configureProjections —
  // and crashed the entire map init ("configureProjections() must be called
  // before any projection emit"); the map never left "Initializing…".

  private graticuleBuffer: GPUBuffer | null = null
  private graticuleVertexCount = 0
  private lastGratZoom = -1
  /** Toggle for the lat/lon grid overlay. Default OFF — the graticule
   *  was a dev/debug aid that shipped enabled; basemap-quality output
   *  should opt in. XGISMap exposes `setGraticuleEnabled()` so the
   *  host app + URL flags can flip it without rebuilding renderers. */
  private graticuleEnabled = false
  /** GPU-buffer cache mirroring graticule.ts's CPU-data cache.
   *  Keyed by GraticuleData IDENTITY — the underlying generator
   *  returns the same object for the same zoom bucket, so a Map
   *  keyed by reference avoids recomputing a bucket key here.
   *
   *  10 ms / call on Bright zoom animations (createBuffer +
   *  writeBuffer + destroy) fired exactly on LOD-boundary frames,
   *  doubling the worst-frame hitch. With this cache, re-entry into
   *  a previously-seen bucket is a pointer swap (~0 ms). */
  private graticuleBufferCache = new WeakMap<object, { buf: GPUBuffer; count: number }>()

  constructor(private readonly ctx: GPUContext) {}

  /** Toggle the lat/lon grid overlay at runtime. Default off. */
  setEnabled(on: boolean): void {
    this.graticuleEnabled = on
    // Eager WebGPU-buffer prime so the first frame after enabling draws without a
    // zoom-bucket stall. Skipped on the forced-WebGL2 twin: `ctx.device` is a fail-
    // loud proxy there (no native GPUDevice), so the RHI buffer is built lazily in
    // renderFrameRhi instead (#1062).
    if (on && !this.graticuleBuffer && this.ctx.rhi?.backend !== 'webgl2')
      this.initGraticule(this.lastGratZoom >= 0 ? this.lastGratZoom : 2)
  }

  /** Read the current graticule on/off state. */
  isEnabled(): boolean {
    return this.graticuleEnabled
  }

  /** Current graticule index/vertex count (for getDrawStats). */
  vertexCount(): number {
    return this.graticuleVertexCount
  }

  private initGraticule(zoom = 2): void {
    const grat = generateGraticule(zoom)
    // Same GraticuleData reference → same bucket as last call →
    // GPU buffer is already correct, no need to destroy/create/upload.
    const cached = this.graticuleBufferCache.get(grat)
    if (cached) {
      this.graticuleBuffer = cached.buf
      this.graticuleVertexCount = cached.count
      this.lastGratZoom = zoom
      return
    }
    // Don't destroy the previous buffer — it's still referenced by
    // a cached entry for its own bucket. The WeakMap holds references
    // alive while their bucket is reachable; when graticule.ts's
    // bucket cache evicts (currently never), the GraticuleData object
    // becomes unreachable and the WeakMap entry GCs along with the
    // GPUBuffer.
    const buf = this.ctx.device.createBuffer({
      size: grat.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'graticule',
    })
    this.ctx.device.queue.writeBuffer(buf, 0, grat.vertices)
    this.graticuleBufferCache.set(grat, { buf, count: grat.indexCount })
    this.graticuleBuffer = buf
    this.graticuleVertexCount = grat.indexCount
    this.lastGratZoom = zoom
  }

  /**
   * Draw the graticule grid (or no-op when disabled). Called by MapRenderer
   * at the SAME point in renderToPass — after the layer draws — with the
   * borrowed `linePipeline` + base `bindGroup` + `UniformRing` + the packed
   * frame data. The buffer is regenerated only on a zoom-bucket change.
   */
  renderFrame(
    pass: GPURenderPassEncoder,
    linePipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    ring: UniformRing,
    frame: GraticuleFrame,
    camera: GraticuleCamera,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    // Regenerate graticule if zoom level changed (adaptive spacing).
    // Skip entirely when disabled so the GPU buffer + writeBuffer
    // churn stays out of the hot path for default-off basemaps.
    if (this.graticuleEnabled) {
      const gratZoom = Math.round(frame.zoom)
      if (gratZoom !== this.lastGratZoom) {
        this.initGraticule(gratZoom)
      }
    }
    if (!this.graticuleEnabled || !this.graticuleBuffer) return

    pass.setPipeline(linePipeline)
    pass.setVertexBuffer(0, this.graticuleBuffer)
    for (const c of this.copyParams(frame, camera, canvasWidth, canvasHeight, dpr)) {
      this.drawCopy(
        pass,
        bindGroup,
        ring,
        frame,
        c.mvp,
        c.logDepthFc,
        c.camH,
        c.camL,
        c.tileOriginMercX,
        c.globeEye,
      )
    }
  }

  /** Compute the per-world-copy uniform-pack parameters for this frame — the
   *  SINGLE authority for the graticule's globe/flat fan-out, shared by the WebGPU
   *  (renderFrame) and forced-WebGL2 (renderFrameRhi) draws. Only the per-copy MVP,
   *  DSFUN camera anchor, tile_origin_merc, log-depth factor, and globe_eye vary;
   *  each backend then packs + draws through its own pipeline plumbing (#1062). */
  private copyParams(
    frame: GraticuleFrame,
    camera: GraticuleCamera,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): GraticuleCopyParam[] {
    // #729 — world-copy fan-out routed through the single projType authority
    // (visibleWorldCopiesFor), so the single-pass ECEF path is the SPECIAL case,
    // not the default the ECEF migration wrongly made it (the 'cam_h unused —
    // ECEF path' assumption is false for flat display).
    if (camera.globeMode || isGlobeProj(frame.projType)) {
      // ECEF fast path (globe 7 / tilted-azimuthal): graticule vertices are
      // absolute ECEF, world-copy-independent on the sphere. One draw against
      // the ECEF-MVP with RTC anchor (0,0,0) — cam_h/cam_l unused by vs_main's
      // 3D arm — and globe_eye from frame.eye (#600).
      return [
        {
          mvp: frame.mvp,
          logDepthFc: frame.logDepthFc,
          camH: [0, 0],
          camL: [0, 0],
          tileOriginMercX: 0,
          globeEye: globeEyeUniform(frame.eye),
        },
      ]
    }

    // Flat display (projType 0-6): fan the grid across the SAME world copies the
    // fills occupy. getViewForProjection routes flat 0-6 to the flat 2D-plane
    // Mercator-metre MVP. Per copy `wo`, the camera-relative Mercator anchor is
    // DSFUN-split from (camMerc − wo·worldWidth) and tile_origin_merc = wo·
    // worldWidth. In vs_main the Mercator arm folds the copy shift through
    // cam_h/cam_l (its worldOffM cancels tile_origin_merc), while the periodic
    // arm (1/2/6) selects the copy through tile_origin_merc → ref_lon in
    // flat_rel/project_geom — one uniform pack fans out both arms. The fround
    // hi/lo split mirrors the VTR / renderer.ts DSFUN pattern so the grid
    // coincides with the fills by construction.
    // Enumerate copies BEFORE grabbing the MVP: for Mercator the router runs
    // getVisibleWorldCopies, which rebuilds the camera's shared rtcMatrix buffer
    // — so getViewForProjection (which returns a REFERENCE to that buffer) must
    // come last, leaving the live flat MVP untouched through the draw loop.
    const copies = visibleWorldCopiesFor(frame.projType, camera, canvasWidth, canvasHeight, dpr)
    const view = camera.getViewForProjection(frame.projType, canvasWidth, canvasHeight, dpr)
    const [camMercX, camMercY] = lonLatToMercator(frame.projCenterLon, frame.projCenterLat)
    const worldWidth = 2 * Math.PI * activeBody().sphereR
    const camHy = Math.fround(camMercY)
    const camLy = Math.fround(camMercY - camHy)
    const out: GraticuleCopyParam[] = []
    for (const wo of copies) {
      const camX = camMercX - wo * worldWidth
      const camHx = Math.fround(camX)
      const camLx = Math.fround(camX - camHx)
      out.push({
        mvp: view.matrix,
        logDepthFc: view.logDepthFc,
        camH: [camHx, camHy],
        camL: [camLx, camLy],
        tileOriginMercX: wo * worldWidth,
        globeEye: NO_GLOBE_EYE,
      })
    }
    return out
  }

  /** Draw the graticule grid on the forced-WebGL2 twin (#1062). RHI sibling of
   *  renderFrame: the SAME zoom-bucket cache + copyParams fan-out + polygon
   *  Uniforms pack, but the geometry lives in an RhiBuffer, the uniforms in an
   *  RHI UniformRing, and the draw routes through the graticule line Material
   *  (vs_main / fs_stroke, line-list topology) — the RHI twin of the WebGPU
   *  `linePipeline` the overlay borrows. Resources are built through the injected
   *  RHI device (this.ctx.rhi); WebGL2 is immediate-mode, so every staged slot is
   *  flushed before the batched draw. */
  renderFrameRhi(
    pass: RhiRenderPass,
    frame: GraticuleFrame,
    camera: GraticuleCamera,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    const rhi = this.ctx.rhi
    if (this.graticuleEnabled) {
      const gratZoom = Math.round(frame.zoom)
      if (gratZoom !== this.lastGratZoomRhi) this.initGraticuleRhi(rhi, gratZoom)
    }
    if (!this.graticuleEnabled || !this.graticuleRhiBuffer) return

    const material = this.ensureLineMatRhi()
    const ring = this.ensureRhiRing(rhi)
    ring.resetSlot()
    const params = this.copyParams(frame, camera, canvasWidth, canvasHeight, dpr)
    // Allocate + stage every copy's slot BEFORE building the bind group, so a
    // ring grow (rare — initial capacity comfortably exceeds the world-copy count)
    // is already resolved when rhiBindGroup reads the live ring buffer.
    const offsets = params.map((c) => {
      const off = ring.allocSlot()
      ring.stageSlot(
        off,
        this.packCopy(frame, c.mvp, c.logDepthFc, c.camH, c.camL, c.tileOriginMercX, c.globeEye),
      )
      return off
    })
    const bindGroup = this.rhiBindGroup(rhi, material)
    ring.flush()
    executeItems(
      material,
      pass,
      offsets.map((off) => ({
        variant: 0,
        bindGroups: [bindGroup],
        dynamicOffsets: [[off]],
        vertex: this.graticuleRhiBuffer!,
        count: this.graticuleRhiVertexCount,
        indexed: false,
      })),
    )
  }

  /** Pack the shared polygon 'Uniforms' struct for ONE graticule copy + draw it.
   *  Extracted (#729) so the ECEF fast path and the per-copy flat fan-out share
   *  the #733 full-struct pack (every field named, completeness compile-time —
   *  the #600 globe_eye class does not compile). The only per-copy variation is
   *  the MVP, the DSFUN camera anchor (cam_h/cam_l), tile_origin_merc, the
   *  log-depth factor, and globe_eye; RTC/extrude/light fields stay zero
   *  (graticule lines never extrude), pick_id = 0 (decorative, never pickable),
   *  clip_bounds = the "no clip" sentinel (same rationale as the polygon path). */
  private drawCopy(
    pass: GPURenderPassEncoder,
    bindGroup: GPUBindGroup,
    ring: UniformRing,
    frame: GraticuleFrame,
    mvp: Float32Array | number[],
    logDepthFc: number,
    camH: readonly [number, number],
    camL: readonly [number, number],
    tileOriginMercX: number,
    globeEye: readonly [number, number, number, number],
  ): void {
    const buf = this.packCopy(frame, mvp, logDepthFc, camH, camL, tileOriginMercX, globeEye)
    const gratOff = ring.allocSlot()
    ring.stageSlot(gratOff, buf)
    pass.setBindGroup(0, bindGroup, [gratOff])
    pass.draw(this.graticuleVertexCount)
  }

  /** Write the shared polygon 'Uniforms' struct for ONE copy and return the packed
   *  buffer. Backend-neutral (both drawCopy and renderFrameRhi stage its bytes into
   *  their ring) — the memoised gratBlock is overwritten per call, but stageSlot
   *  snapshots it immediately, so successive packs never alias. */
  private packCopy(
    frame: GraticuleFrame,
    mvp: Float32Array | number[],
    logDepthFc: number,
    camH: readonly [number, number],
    camL: readonly [number, number],
    tileOriginMercX: number,
    globeEye: readonly [number, number, number, number],
  ): ArrayBuffer {
    const B = gratBlock()
    B.write({
      mvp,
      fill_color: [1, 1, 1, 0.15], // white @ 15% (minor grid line colour)
      stroke_color: [1, 1, 1, 0.15],
      proj_params: [frame.projType, frame.projCenterLon, frame.projCenterLat, 0],
      cam_h: [camH[0], camH[1]],
      cam_l: [camL[0], camL[1]],
      tile_origin_merc: [tileOriginMercX, 0],
      opacity: 1,
      log_depth_fc: logDepthFc,
      pick_id: 0,
      layer_depth_offset: 0,
      tile_extent_m: 0,
      extrude_height_m: 0,
      clip_bounds: [-1e30, 0, 0, 0],
      zoom: 0,
      extrude_base_m: 0,
      fill_translate_x: 0,
      fill_translate_y: 0,
      tile_dequant_scale: 0,
      tile_dequant_half: 0,
      light_color_packed: 0,
      pattern_active: 0,
      cam_ecef_off_h: [0, 0, 0, 0],
      cam_ecef_off_l: [0, 0, 0, 0],
      light_dir_ecef: [0, 0, 0, 0],
      globe_eye: [globeEye[0], globeEye[1], globeEye[2], globeEye[3]],
    })
    return B.buffer
  }

  // ── Forced-WebGL2 twin state (#1062) — parallel to the WebGPU buffer/ring above.
  // The zoom-bucket CPU cache (graticule.ts, keyed by GraticuleData identity) is
  // shared; only the GPU handle differs (RhiBuffer vs GPUBuffer), so the twin keeps
  // its own RhiBuffer cache + UniformRing + bind group.
  private graticuleRhiBuffer: RhiBuffer | null = null
  private graticuleRhiVertexCount = 0
  private lastGratZoomRhi = -1
  private graticuleRhiBufferCache = new WeakMap<object, { buf: RhiBuffer; count: number }>()
  private _rhiRing: UniformRing | null = null
  private _rhiBindGroup: { buf: RhiBuffer; bg: RhiBindGroup } | null = null
  private _lineMatRhi: Material | null = null

  /** The graticule line Material (built lazily ONCE — the emit throws until
   *  configureProjections() has run, so it MUST NOT be a ctor/field initializer,
   *  same discipline as polygonUniformBytes()). Single colour target, binding-0
   *  Uniforms only (fs_stroke samples no texture), line-list topology. */
  private ensureLineMatRhi(): Material {
    if (this._lineMatRhi) return this._lineMatRhi
    this._lineMatRhi = buildGraticuleLineMaterial({
      rhi: this.ctx.rhi,
      shader: emitPolygonWgsl(null, false),
      vsCode: emitPolygonGlsl(null, false, 'vertex', 'vs_main'),
      fsCode: emitPolygonGlsl(null, false, 'fragment', 'fs_stroke'),
      format: this.ctx.format,
      sampleCount: 1,
      rhiGroups: [[{ binding: 0, kind: 'uniform', dynamic: true, name: 'Uniforms' }]],
      vertexLayout: toVertexBufferLayout(LINE_FORMAT),
      pickEnabled: false,
    })
    return this._lineMatRhi
  }

  /** RHI twin of initGraticule: build/cache the graticule geometry as an RhiBuffer
   *  for the current zoom bucket (same GraticuleData-identity cache discipline). */
  private initGraticuleRhi(rhi: RhiDevice, zoom = 2): void {
    const grat = generateGraticule(zoom)
    const cached = this.graticuleRhiBufferCache.get(grat)
    if (cached) {
      this.graticuleRhiBuffer = cached.buf
      this.graticuleRhiVertexCount = cached.count
      this.lastGratZoomRhi = zoom
      return
    }
    const buf = rhi.createBuffer({
      size: grat.vertices.byteLength,
      usage: 'vertex',
      label: 'graticule',
    })
    rhi.writeBuffer(buf, 0, grat.vertices)
    this.graticuleRhiBufferCache.set(grat, { buf, count: grat.indexCount })
    this.graticuleRhiBuffer = buf
    this.graticuleRhiVertexCount = grat.indexCount
    this.lastGratZoomRhi = zoom
  }

  private ensureRhiRing(rhi: RhiDevice): UniformRing {
    if (!this._rhiRing) {
      this._rhiRing = new UniformRing(
        rhi,
        gratBlock().std140Stride(),
        64,
        'graticule-uniform-ring',
        () => {
          this._rhiBindGroup = null
        },
      )
      this._rhiRing.ensure()
    }
    return this._rhiRing
  }

  /** RHI bind group over the ring buffer (dynamic offset @0). Cached per ring-buffer
   *  identity — a ring grow swaps rhiBuffer (and nulls the cache via onGrow), so this
   *  rebuilds automatically. */
  private rhiBindGroup(rhi: RhiDevice, material: Material): RhiBindGroup {
    const buf = this._rhiRing!.rhiBuffer!
    if (this._rhiBindGroup?.buf === buf) return this._rhiBindGroup.bg
    const bg = rhi.createBindGroup(material.layout(0), [
      { binding: 0, resource: { buffer: buf, offset: 0, size: polygonUniformBytes() } },
    ])
    this._rhiBindGroup = { buf, bg }
    return bg
  }
}

/** Per-world-copy uniform-pack parameters computed once per frame by copyParams and
 *  consumed by each backend's draw. */
interface GraticuleCopyParam {
  mvp: Float32Array | number[]
  logDepthFc: number
  camH: readonly [number, number]
  camL: readonly [number, number]
  tileOriginMercX: number
  globeEye: readonly [number, number, number, number]
}
