// ═══ Heatmap Renderer (Phase R) ═══
//
// Owns the GPU resources for the `heatmap` layer's ACCUMULATION pass — the
// first of the 3-pass pipeline (accum → blur → compose). It mirrors the SDF
// PointRenderer's GeoJSON-source data path: `addLayer` stores per-point
// lon/lat + radius + weight; each frame `renderAccum` re-projects every point
// (ECEF DSFUN + absolute-Mercator DSFUN tail, identical math to PointRenderer
// so a heatmap and a circle layer over the same source line up) into the
// per-feature storage buffer the accum VS reads, and draws one additive
// Gaussian splat quad per point into the offscreen R16Float density target.
//
// The renderer ALSO bakes each layer's `heatmap-color` ramp into a 256×1
// RGBA8 LUT texture (sampled by the compose pass) and exposes the layer's
// intensity / opacity for the compose uniform. The blur + compose pipelines
// live in pipeline-factory (model on ensureOverdrawCompose); this renderer
// owns only the accum pipeline (vertex + per-feature storage, like
// PointRenderer) and the per-layer GPU buffers + ramp LUT.
//
// SCOPE: GeoJSON-source / direct-layer points only (the map.ts Point/
// MultiPoint fork). Tile-sourced heatmaps (addTilePoint/flushTilePoints) are
// a deferred follow-up.

import type { Camera } from '../camera'
import { lonLatToECEF } from '@xgis/shared'
import { activeBody } from '@xgis/shared'
import { getSampleCount } from '@xgis/engine'
import { FrameArena } from '@xgis/engine'
import type {
  RhiBuffer,
  RhiBindGroup,
  RhiDevice,
  RhiRenderPass,
  RhiSampler,
  RhiScreenPassDevice,
  RhiTexture,
  RhiTextureView,
} from '@xgis/engine'
import { wrapWebGpuPass, wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import {
  HeatmapDraper,
  HeatmapAccumTwinDraper,
  HeatmapBlurDraper,
  HeatmapComposeDraper,
} from './material/heatmap-material'
import type { HeatmapTargets } from './heatmap-targets'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { heatmapAccumU as HEATMAP_U } from '../shaders/dsl/heatmap-accum'
import { globeEyeUniform } from './globe-eye-uniform'
import { cameraAnchorDsfun } from './camera-anchor-dsfun'
import type { GeoJSONGeometry } from '@xgis/data'

// Typed pack target for the heatmap-accum 'Uniforms' struct (#733 P2): layout from
// wgslLayout(U.struct) — handle-only, module-free — and write() typed by the same
// field record the WGSL is emitted from, so offsets cannot drift and a missing
// field (the #600 globe_eye class) does not compile. LAZY memo (ctor/frame time),
// same discipline as the reflect()-based slots it replaces.
let _heatmapBlock: UniformBlockOf<typeof HEATMAP_U> | null = null
function heatmapBlock(): UniformBlockOf<typeof HEATMAP_U> {
  return (_heatmapBlock ??= uniformBlock(HEATMAP_U))
}

/** A baked heatmap-color ramp stop — offset in [0,1] (heatmap-density) and a
 *  normalised RGBA colour. The renderer interpolates between stops to fill
 *  the 256×1 LUT. */
export interface HeatmapColorStop {
  offset: number
  rgba: [number, number, number, number]
}

/** Per-layer heatmap state. */
interface HeatmapLayer {
  lons: Float64Array
  lats: Float64Array
  /** heatmap-radius in CSS px (constant; zoom-interp resolved at addLayer). */
  radiusPx: number
  /** Per-point weight (heatmap-weight × 1). */
  weights: Float32Array
  pointCount: number
  /** heatmap-intensity (per-zoom resolved at addLayer). */
  intensity: number
  /** heatmap-opacity (layer alpha). */
  opacity: number
  /** The baked 256×4 RGBA8 LUT bytes — the single ramp authority. Both backends
   *  build their colour texture from these (native rampTexture / twin RHI ramp),
   *  so the LUT is device-free at addLayer time (the forced-WebGL2 stub device
   *  throws on any access, #834). */
  rampBytes: Uint8Array
  /** 256×1 RGBA8 colour ramp LUT for this layer (native/WebGPU). Built LAZILY by
   *  getLayers() on the WebGPU frame path — never in addLayer, so a heatmap style
   *  boots on the forced-WebGL2 twin without touching the stub device. */
  rampTexture?: GPUTexture
  /** Compose params uniform (intensity, opacity) — one PER layer (native/WebGPU).
   *  Built LAZILY by getLayers() (same reason as rampTexture). */
  paramsBuf?: GPUBuffer
  // Per-layer GPU buffers (created lazily on first renderAccum, resized as
  // point count changes). Routed through the RHI seam (§4 batch-seam migration):
  // Rhi* handles, byte-identical to the raw VERTEX|COPY_DST / INDEX|COPY_DST /
  // STORAGE|COPY_DST buffers they replace.
  _vertBuf?: RhiBuffer
  _idxBuf?: RhiBuffer
  _featBuf?: RhiBuffer
  _bindGroup?: RhiBindGroup
  _capacity?: number
  // Forced-WebGL2 twin per-layer resources (#1060), lazily built by renderRhi.
  // The accum bind group is against the RHI-native accum layout (not the native
  // wrapper); the ramp LUT + params re-originate from rampBytes / intensity /
  // opacity because the native rampTexture/paramsBuf are proxy-device stubs here.
  _rhiAccumBG?: RhiBindGroup
  _rhiRampTex?: RhiTexture
  _rhiRampView?: RhiTextureView
  _rhiParamsBuf?: RhiBuffer
}

// Per-feature feat_data stride — matches the point renderer's pack so the
// accum VS reuses the same ECEF / Mercator DSFUN slots.
const STRIDE = 24

/** Default Mapbox heatmap-color ramp (the spec default `interpolate` over
 *  heatmap-density). Transparent at 0 so empty areas don't tint the map. */
export const DEFAULT_HEATMAP_RAMP: readonly HeatmapColorStop[] = [
  { offset: 0.0, rgba: [0, 0, 1, 0] }, // rgba(0,0,255,0)
  { offset: 0.1, rgba: [65 / 255, 105 / 255, 225 / 255, 1] }, // royalblue
  { offset: 0.3, rgba: [0, 1, 1, 1] }, // cyan
  { offset: 0.5, rgba: [0, 1, 0, 1] }, // lime
  { offset: 0.7, rgba: [1, 1, 0, 1] }, // yellow
  { offset: 1.0, rgba: [1, 0, 0, 1] }, // red
]

/** Pack the heatmap accum frame uniform into the typed block — one write() per
 *  frame, every field named, completeness compile-time (#733 P2; a packer that
 *  omits globe_eye — the #600 class — does not compile). Identical convention to
 *  the point frame uniform minus circle_params: viewport = (w, h, meters/px, 0);
 *  cam_ecef_h/l = camera anchor split DSFUN (2D Mercator centre in .xy on the
 *  flat path, getECEFCenter on globe/3D); globe_eye all-zero off the globe
 *  (flat/disc cull arms ignore it).
 *  (exported for the byte-equality gate — heatmap-frame-uniform.test.ts) */
export function writeHeatmapFrameUniform(
  block: UniformBlockOf<typeof HEATMAP_U>,
  frame: { matrix: Float32Array; eye?: readonly [number, number, number] },
  camera: Camera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): void {
  // #964 — the viewport.z "meters/px" lane reads the single effective-mpp
  // authority (the capped scale the frozen low-zoom flat MVP actually renders at),
  // NOT the uncapped WORLD_MERC/TILE_PX/2^zoom, mirroring the point frame uniform
  // (#739). Above z* effectiveMpp === rawMpp exactly (byte-identical); globe/ECEF
  // returns raw unchanged (its cos-lat cap is a separate concern, #964 Part 2).
  const metersPerPixel = camera.effectiveMpp(projType, canvasHeight, dpr)
  // Camera anchor split DSFUN into hi/lo lanes (shared with the point frame
  // uniform, #1006). Flat Mercator (projType 0) anchors on the 2D Mercator centre
  // in .xy (z = 0); globe/3D on getECEFCenter.
  const { hi: camH, lo: camL } = cameraAnchorDsfun(camera, projType)
  const ge = globeEyeUniform(frame.eye)
  block.write({
    mvp: frame.matrix,
    proj_params: [projType, projCenterLon, projCenterLat, 0],
    viewport: [canvasWidth, canvasHeight, metersPerPixel, 0],
    cam_ecef_h: [camH[0], camH[1], camH[2], 0],
    cam_ecef_l: [camL[0], camL[1], camL[2], 0],
    globe_eye: [ge[0], ge[1], ge[2], ge[3]],
  })
}

export class HeatmapRenderer {
  private device: GPUDevice
  /** The RHI seam (§4 batch-seam migration). One instance, reused for the accum
   *  set (uniform + per-layer vert/idx/feat buffers + accum bind group) and the
   *  HeatmapDraper. On WebGPU `createBuffer === device.createBuffer`,
   *  `createBindGroup === device.createBindGroup`, `destroyBuffer === GPUBuffer.destroy()`,
   *  so the GPU command stream is unchanged. */
  private rhi: RhiDevice
  private uniformBuffer: RhiBuffer
  private frameBlock = heatmapBlock() // typed std140 pack target (mvp/proj/viewport/cam_h/cam_l/globe_eye, #600)
  private readonly _frameArena = new FrameArena(64 * 1024)
  private layers: HeatmapLayer[] = []
  /** Native WebGPU resources, created LAZILY at first use (#834 device
   *  retirement S1). Every consumer is on the WebGPU frame path (the heatmap
   *  pass getters, the accum bind group, the HeatmapDraper layout), so the
   *  constructor no longer touches `ctx.device` — a prerequisite for the
   *  forced-WebGL2 boot dropping its no-op device Proxy. blurDirH/V are the
   *  blur direction uniforms (two 16-byte buffers so one encoder can bind
   *  both without a mid-frame overwrite); rampSampler filters the ramp LUT. */
  private _native: {
    bindGroupLayout: GPUBindGroupLayout
    blurDirH: GPUBuffer
    blurDirV: GPUBuffer
    rampSampler: GPUSampler
  } | null = null

  /** Screen colour format — threaded to the twin compose draper's colour target
   *  (nominal on WebGL2's default framebuffer, but the descriptor requires it). */
  private readonly format: string

  constructor(ctx: { device: GPUDevice; rhi: RhiDevice; format: string }) {
    this.device = ctx.device
    this.rhi = ctx.rhi
    this.format = ctx.format

    // Accum uniform — UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    // Backend-neutral (RHI), so it stays in the constructor.
    this.uniformBuffer = this.rhi.createBuffer({
      size: this.frameBlock.byteLength, // reflected std140 size (144 = 36 f32 × 4, #600 globe_eye)
      usage: 'uniform',
      writable: true,
    })
  }

  private native(): NonNullable<HeatmapRenderer['_native']> {
    if (this._native) return this._native
    const device = this.device
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'heatmap-accum-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    // The accum draw goes through the RHI Material seam (HeatmapDraper, which owns the
    // additive r16float single-sample pipeline); the shared bind-group layout feeds it.
    const blurDirH = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'heatmap-blur-dir-h',
    })
    const blurDirV = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'heatmap-blur-dir-v',
    })
    device.queue.writeBuffer(blurDirH, 0, new Float32Array([1, 0, 0, 0]))
    device.queue.writeBuffer(blurDirV, 0, new Float32Array([0, 1, 0, 0]))
    const rampSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      label: 'heatmap-ramp-sampler',
    })
    this._native = { bindGroupLayout, blurDirH, blurDirV, rampSampler }
    return this._native
  }

  /** Blur direction uniform buffers (H / V) — read by the heatmap pass. */
  getBlurDirBuffers(): { h: GPUBuffer; v: GPUBuffer } {
    const n = this.native()
    return { h: n.blurDirH, v: n.blurDirV }
  }

  /** Ramp sampler — read by the heatmap pass for the compose bind group. The
   *  per-layer compose-params buffer lives on each layer (getLayers()). */
  getRampSampler(): GPUSampler {
    return this.native().rampSampler
  }

  hasLayers(): boolean {
    return this.layers.length > 0
  }

  /** Bake a 256×4 RGBA8 colour LUT (linear interp between stops) — the single
   *  ramp authority, uploaded to the native texture (WebGPU) and, on the twin,
   *  the RHI ramp texture (both read the SAME bytes). */
  private buildRampBytes(stops: readonly HeatmapColorStop[]): Uint8Array {
    const W = 256
    const data = new Uint8Array(W * 4)
    const sorted = [...stops].sort((a, b) => a.offset - b.offset)
    for (let i = 0; i < W; i++) {
      const t = i / (W - 1)
      let lo = sorted[0],
        hi = sorted[sorted.length - 1]
      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s].offset && t <= sorted[s + 1].offset) {
          lo = sorted[s]
          hi = sorted[s + 1]
          break
        }
      }
      const span = hi.offset - lo.offset
      const f = span > 1e-6 ? (t - lo.offset) / span : 0
      for (let c = 0; c < 4; c++) {
        const v = lo.rgba[c] + (hi.rgba[c] - lo.rgba[c]) * f
        data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)))
      }
    }
    return data
  }

  /** Build a native 256×1 RGBA8 colour LUT texture from baked LUT bytes (WebGPU
   *  only; touches this.device, so it runs LAZILY on the WebGPU frame path). */
  private buildRampTexture(rampBytes: Uint8Array): GPUTexture {
    const W = 256
    const tex = this.device.createTexture({
      size: { width: W, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'heatmap-ramp-lut',
    })
    this.device.queue.writeTexture(
      { texture: tex },
      rampBytes,
      { bytesPerRow: W * 4, rowsPerImage: 1 },
      { width: W, height: 1 },
    )
    return tex
  }

  /** Add a heatmap layer from GeoJSON Point/MultiPoint features.
   *  @param features GeoJSON features (Point/MultiPoint)
   *  @param radiusPx heatmap-radius in CSS px (resolved at the camera zoom)
   *  @param weight   heatmap-weight global multiplier (per-feature weight × this)
   *  @param intensity heatmap-intensity (resolved at the camera zoom)
   *  @param opacity  heatmap-opacity (layer alpha)
   *  @param ramp     heatmap-color ramp stops (defaults to DEFAULT_HEATMAP_RAMP)
   *  @param perFeatureWeights optional per-feature weight overrides
   */
  addLayer(
    features: {
      geometry: GeoJSONGeometry | null
      properties?: Record<string, unknown>
    }[],
    radiusPx: number,
    weight: number,
    intensity: number,
    opacity: number,
    ramp: readonly HeatmapColorStop[] = DEFAULT_HEATMAP_RAMP,
    perFeatureWeights?: number[] | null,
  ): void {
    const points: { lon: number; lat: number; w: number }[] = []
    let fi = 0
    for (const f of features) {
      if (!f.geometry) {
        fi++
        continue
      }
      const w = (perFeatureWeights ? perFeatureWeights[fi] : 1) * weight
      if (f.geometry.type === 'Point') {
        points.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], w })
      } else if (f.geometry.type === 'MultiPoint') {
        for (const coord of f.geometry.coordinates) {
          points.push({ lon: coord[0], lat: coord[1], w })
        }
      }
      fi++
    }
    if (points.length === 0) return

    const lons = new Float64Array(points.length)
    const lats = new Float64Array(points.length)
    const weights = new Float32Array(points.length)
    for (let i = 0; i < points.length; i++) {
      lons[i] = points[i].lon
      lats[i] = points[i].lat
      weights[i] = points[i].w
    }

    const lyIntensity = Math.max(0, intensity)
    const lyOpacity = Math.max(0, Math.min(1, opacity))
    // Device-free: the ramp LUT bytes + intensity/opacity are the authority; the
    // per-backend GPU resources (native rampTexture/paramsBuf, twin RHI ramp) are
    // built lazily at first draw so addLayer never touches the stub device (#834).
    this.layers.push({
      lons,
      lats,
      weights,
      pointCount: points.length,
      radiusPx: Math.max(1, radiusPx),
      intensity: lyIntensity,
      opacity: lyOpacity,
      rampBytes: this.buildRampBytes(ramp),
    })

    console.log(`[X-GIS] heatmap layer: ${points.length} points`)
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      // Native ramp/params are lazily built on the WebGPU path only — `?.` guards
      // the twin (they stay undefined there).
      layer.rampTexture?.destroy()
      layer.paramsBuf?.destroy()
      // Accum buffers route through the RHI seam; ramp/params stay raw (separate set).
      if (layer._vertBuf) this.rhi.destroyBuffer(layer._vertBuf)
      if (layer._idxBuf) this.rhi.destroyBuffer(layer._idxBuf)
      if (layer._featBuf) this.rhi.destroyBuffer(layer._featBuf)
      // Forced-WebGL2 twin per-layer resources (#1060).
      if (layer._rhiRampTex) this.rhi.destroyTexture(layer._rhiRampTex)
      if (layer._rhiParamsBuf) this.rhi.destroyBuffer(layer._rhiParamsBuf)
    }
    this.layers = []
  }

  /** Per-layer ramp LUT + compose-params buffer — read by the WebGPU heatmap pass
   *  to drive the compose. Each heatmap layer is accum→blur→composed independently
   *  with its OWN params (intensity/opacity), so a multi-heatmap style composes
   *  each layer correctly. Builds the native GPU resources LAZILY here (first
   *  WebGPU frame) so addLayer stays device-free — this getter is the WebGPU path
   *  (the twin reads this.layers directly via renderRhi). */
  getLayers(): readonly { rampTexture: GPUTexture; paramsBuf: GPUBuffer }[] {
    for (const layer of this.layers) {
      if (!layer.rampTexture) layer.rampTexture = this.buildRampTexture(layer.rampBytes)
      if (!layer.paramsBuf) {
        const buf = this.device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: 'heatmap-compose-params',
        })
        this.device.queue.writeBuffer(
          buf,
          0,
          new Float32Array([layer.intensity, layer.opacity, 0, 0]),
        )
        layer.paramsBuf = buf
      }
    }
    return this.layers as readonly { rampTexture: GPUTexture; paramsBuf: GPUBuffer }[]
  }

  /** Write the shared per-frame accum frame uniform (mvp / proj_params /
   *  viewport / camera anchor). Called ONCE per frame by the heatmap pass
   *  before the per-layer draws; the uniform is layer-independent. */
  updateFrameUniform(
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    writeHeatmapFrameUniform(
      this.frameBlock,
      frame,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
      dpr,
    )
    this.rhi.writeBuffer(this.uniformBuffer, 0, this.frameBlock.buffer)
  }

  /** Pack + upload ONE heatmap layer's per-point quad + feat_data buffers with
   *  the ECEF / Mercator DSFUN expansion (identical to PointRenderer). The SINGLE
   *  pack authority: backend-neutral, it (re)allocates only the vert/idx/feat RHI
   *  buffers (both backends draw the same geometry) — the per-backend accum bind
   *  group is built lazily by the draw entry points. Returns the index count
   *  (N×6), or 0 for an empty layer. `updateFrameUniform` MUST have run this frame. */
  private packLayerBuffers(layerIndex: number): number {
    const layer = this.layers[layerIndex]
    if (!layer) return 0
    const DEG2RAD = Math.PI / 180
    const R_MERC = activeBody().sphereR
    const N = layer.pointCount
    this._frameArena.beginFrame()
    const verts = this._frameArena.allocF32(N * 4 * 4)
    const indices = this._frameArena.allocU32(N * 6)
    const featData = this._frameArena.allocF32(N * STRIDE)
    const u32View = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)

    for (let i = 0; i < N; i++) {
      const lon = layer.lons[i]
      const lat = layer.lats[i]
      // Quad vertices.
      const vBase = i * 4 * 4
      for (let q = 0; q < 4; q++) {
        const off = vBase + q * 4
        verts[off] = 0
        verts[off + 1] = 0
        u32View[off + 2] = q
        verts[off + 3] = i
      }
      const iBase = i * 6,
        vIdx = i * 4
      indices[iBase] = vIdx
      indices[iBase + 1] = vIdx + 1
      indices[iBase + 2] = vIdx + 2
      indices[iBase + 3] = vIdx
      indices[iBase + 4] = vIdx + 2
      indices[iBase + 5] = vIdx + 3

      const fOff = i * STRIDE
      featData[fOff + 0] = layer.radiusPx // slot 0: radius_px
      featData[fOff + 1] = layer.weights[i] // slot 1: weight
      // ECEF DSFUN centre (slots 11..16) — identical math to PointRenderer.
      const ecef = lonLatToECEF(lon, lat)
      const exH = Math.fround(ecef[0])
      const eyH = Math.fround(ecef[1])
      const ezH = Math.fround(ecef[2])
      featData[fOff + 11] = exH
      featData[fOff + 12] = eyH
      featData[fOff + 13] = ezH
      featData[fOff + 14] = ecef[0] - exH
      featData[fOff + 15] = ecef[1] - eyH
      featData[fOff + 16] = ecef[2] - ezH
      featData[fOff + 17] = lon
      featData[fOff + 18] = lat
      // Absolute Mercator DSFUN tail (slots 20..23).
      const mx = lon * DEG2RAD * R_MERC
      const myClamp = Math.max(-85.051129, Math.min(85.051129, lat))
      const my = Math.log(Math.tan(Math.PI / 4 + (myClamp * DEG2RAD) / 2)) * R_MERC
      const mxH = Math.fround(mx)
      const myH = Math.fround(my)
      featData[fOff + 20] = mxH
      featData[fOff + 21] = Math.fround(mx - mxH)
      featData[fOff + 22] = myH
      featData[fOff + 23] = Math.fround(my - myH)
    }

    // (Re)allocate per-layer GPU buffers when missing or point count changed. Routed
    // through the RHI seam (§4): 'vertex'/'index'/'storage' + writable:true map 1:1 to
    // VERTEX|COPY_DST / INDEX|COPY_DST / STORAGE|COPY_DST — byte-identical GPU resources.
    if (!layer._vertBuf || layer._capacity !== N) {
      if (layer._vertBuf) this.rhi.destroyBuffer(layer._vertBuf)
      if (layer._idxBuf) this.rhi.destroyBuffer(layer._idxBuf)
      if (layer._featBuf) this.rhi.destroyBuffer(layer._featBuf)
      layer._vertBuf = this.rhi.createBuffer({
        size: verts.byteLength,
        usage: 'vertex',
        writable: true,
        label: 'heatmap-vertices',
      })
      layer._idxBuf = this.rhi.createBuffer({
        size: indices.byteLength,
        usage: 'index',
        writable: true,
        label: 'heatmap-indices',
      })
      layer._featBuf = this.rhi.createBuffer({
        size: Math.max(featData.byteLength, 16),
        usage: 'storage',
        writable: true,
        label: 'heatmap-features',
      })
      // The feat buffer was reallocated — both backends' cached accum bind groups
      // referenced the OLD buffer; drop them so the draw entry points rebuild fresh.
      layer._bindGroup = undefined
      layer._rhiAccumBG = undefined
      layer._capacity = N
    }
    this.rhi.writeBuffer(layer._vertBuf!, 0, verts)
    this.rhi.writeBuffer(layer._idxBuf!, 0, indices)
    this.rhi.writeBuffer(layer._featBuf!, 0, featData)
    return N * 6
  }

  /** WebGPU accum draw: pack this layer, then splat additively into the bound
   *  accum render pass through the RHI Material seam. The accum target is
   *  r16float; this native-pass path is the WebGPU authority (the twin uses
   *  drawLayerAccumRhi). One draw call. */
  drawLayerAccum(pass: GPURenderPassEncoder, layerIndex: number): void {
    const indexCount = this.packLayerBuffers(layerIndex)
    const layer = this.layers[layerIndex]
    if (!layer || indexCount === 0) return
    if (!layer._bindGroup) {
      layer._bindGroup = this.rhi.createBindGroup(
        wrapWebGpuBindGroupLayout(this.native().bindGroupLayout),
        [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: layer._featBuf! } },
        ],
      )
    }
    this.ensureHeatmapDraper()
    this._heatmapDraper!.draw(wrapWebGpuPass(pass), {
      bindGroup: layer._bindGroup,
      vertBuf: layer._vertBuf!,
      idxBuf: layer._idxBuf!,
      indexCount,
    })
  }

  private _heatmapDraper?: HeatmapDraper
  private ensureHeatmapDraper(): void {
    if (this._heatmapDraper) return
    this._heatmapDraper = new HeatmapDraper(this.rhi, this.native().bindGroupLayout)
  }

  // ═══ Forced-WebGL2 twin 3-pass render (#1060) ═══
  //
  // The WebGPU heatmap pass (heatmap-pass.ts) runs the accum→blur→compose
  // pipeline through native pipelines + a GPUCommandEncoder. The twin frame has
  // no native device, so the whole pipeline re-originates through the RHI seam:
  // RHI r16float targets (HeatmapTargets.ensureRhi), RHI drapers carrying the
  // same shader DSL emitted as GLSL, and RHI offscreen passes. Capability-gated
  // by the CALLER on rhi.caps.floatBlendTargets — a device without
  // EXT_color_buffer_float / EXT_float_blend fail-closes (no draw, no error).
  private _twin: {
    accumDraper: HeatmapAccumTwinDraper
    blurDraper: HeatmapBlurDraper
    composeDraper: HeatmapComposeDraper
    dirH: RhiBuffer
    dirV: RhiBuffer
    rampSampler: RhiSampler
  } | null = null

  private twin(): NonNullable<HeatmapRenderer['_twin']> {
    if (this._twin) return this._twin
    const dirH = this.rhi.createBuffer({ size: 16, usage: 'uniform', writable: true })
    const dirV = this.rhi.createBuffer({ size: 16, usage: 'uniform', writable: true })
    this.rhi.writeBuffer(dirH, 0, new Float32Array([1, 0, 0, 0]))
    this.rhi.writeBuffer(dirV, 0, new Float32Array([0, 1, 0, 0]))
    this._twin = {
      accumDraper: new HeatmapAccumTwinDraper(this.rhi),
      blurDraper: new HeatmapBlurDraper(this.rhi),
      composeDraper: new HeatmapComposeDraper(this.rhi, this.format),
      dirH,
      dirV,
      rampSampler: this.rhi.createSampler({ mag: 'linear', min: 'linear' }),
    }
    return this._twin
  }

  /** Twin accum draw: pack this layer, then splat additively into the bound RHI
   *  offscreen accum pass. Builds the RHI-native accum bind group (uniform +
   *  storage; the storage lowers to a data texture on WebGL2) lazily. */
  private drawLayerAccumRhi(pass: RhiRenderPass, layerIndex: number): void {
    const indexCount = this.packLayerBuffers(layerIndex)
    const layer = this.layers[layerIndex]
    if (!layer || indexCount === 0) return
    const tw = this.twin()
    if (!layer._rhiAccumBG) {
      layer._rhiAccumBG = this.rhi.createBindGroup(tw.accumDraper.layout(), [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: layer._featBuf! } },
      ])
    }
    tw.accumDraper.draw(pass, {
      bindGroup: layer._rhiAccumBG,
      vertBuf: layer._vertBuf!,
      idxBuf: layer._idxBuf!,
      indexCount,
    })
  }

  /** Lazily build this layer's RHI ramp LUT texture + compose-params uniform
   *  from the baked rampBytes / intensity / opacity (the native rampTexture +
   *  paramsBuf are proxy-device stubs on the twin). */
  private ensureLayerComposeRhi(layerIndex: number): {
    rampView: RhiTextureView
    paramsBuf: RhiBuffer
  } {
    const layer = this.layers[layerIndex]
    if (!layer._rhiRampTex || !layer._rhiRampView) {
      layer._rhiRampTex = this.rhi.createTexture({
        width: 256,
        height: 1,
        format: 'rgba8unorm',
        usage: ['sample', 'copy-dst'],
        label: 'heatmap-ramp-lut-rhi',
      })
      this.rhi.writeTexture(layer._rhiRampTex, layer.rampBytes, 256 * 4, 256, 1)
      layer._rhiRampView = this.rhi.createView(layer._rhiRampTex)
    }
    if (!layer._rhiParamsBuf) {
      layer._rhiParamsBuf = this.rhi.createBuffer({ size: 16, usage: 'uniform', writable: true })
      this.rhi.writeBuffer(
        layer._rhiParamsBuf,
        0,
        new Float32Array([layer.intensity, layer.opacity, 0, 0]),
      )
    }
    return { rampView: layer._rhiRampView, paramsBuf: layer._rhiParamsBuf }
  }

  /** Run the full 3-pass heatmap pipeline on the forced-WebGL2 twin, compositing
   *  onto the given screen pass. Each LAYER is accum→blur→composed independently
   *  (its own radius / weight / ramp / intensity), the accum target cleared per
   *  layer. The caller has already gated on rhi.caps.floatBlendTargets. */
  renderRhi(
    rhi: RhiScreenPassDevice,
    screenPass: RhiRenderPass,
    targets: HeatmapTargets,
    camera: Camera,
    projType: number,
    centerLon: number,
    centerLat: number,
    w: number,
    h: number,
    dpr: number,
  ): void {
    if (this.layers.length === 0) return
    targets.ensureRhi(this.rhi, w, h)
    const accumView = targets.accumViewRhi
    const blurView = targets.blurViewRhi
    if (!accumView || !blurView) return
    const tw = this.twin()
    // Shared per-frame accum uniform (layer-independent) — written once.
    this.updateFrameUniform(camera, projType, centerLon, centerLat, w, h, dpr)

    for (let li = 0; li < this.layers.length; li++) {
      // ── Pass 1: ACCUM ── clear accum, additively splat this layer.
      const ap = rhi.beginOffscreenPass({
        label: 'heatmap-accum-rhi',
        colorAttachments: [
          { view: accumView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      })
      this.drawLayerAccumRhi(ap, li)
      ap.end()

      // ── Pass 2a: BLUR horizontal (accum → blur) ──
      const bh = rhi.beginOffscreenPass({
        label: 'heatmap-blur-h-rhi',
        colorAttachments: [
          { view: blurView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      })
      tw.blurDraper.draw(bh, accumView, tw.dirH)
      bh.end()

      // ── Pass 2b: BLUR vertical (blur → accum) ──
      const bv = rhi.beginOffscreenPass({
        label: 'heatmap-blur-v-rhi',
        colorAttachments: [
          { view: accumView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      })
      tw.blurDraper.draw(bv, blurView, tw.dirV)
      bv.end()

      // ── Pass 3: COMPOSE ── sample blurred density, alpha-blend onto the screen.
      const { rampView, paramsBuf } = this.ensureLayerComposeRhi(li)
      tw.composeDraper.draw(screenPass, accumView, rampView, tw.rampSampler, paramsBuf)
    }
  }

  /** Rebuild the accum pipeline for a quality change. Heatmap accum is always
   *  single-sample (the density target is single-sample r16float), so MSAA
   *  changes don't affect it — this is a no-op kept for call-site symmetry
   *  with PointRenderer.rebuildForQuality. */
  rebuildForQuality(): void {
    // Accum target sampleCount is fixed at 1; nothing to rebuild.
    void getSampleCount
  }
}
