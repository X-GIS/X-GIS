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

import type { Camera } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/engine'
import { WORLD_MERC, TILE_PX } from '@xgis/engine'
import { activeBody } from '@xgis/shared'
import { getSampleCount } from '@xgis/engine'
import { FrameArena } from '@xgis/rhi-webgpu'
import type { RhiBuffer, RhiBindGroup, RhiDevice } from '@xgis/engine'
import { wrapWebGpuPass, wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import { HeatmapDraper } from './material/heatmap-material'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { heatmapAccumU as HEATMAP_U } from '../shaders/dsl/heatmap-accum'
import { globeEyeUniform } from './globe-eye-uniform'

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
  /** 256×1 RGBA8 colour ramp LUT for this layer. */
  rampTexture: GPUTexture
  /** Compose params uniform (intensity, opacity) — one PER layer so multiple
   *  heatmap layers compose with their own params (a single shared buffer
   *  would read back only the last layer's write). Written once at addLayer;
   *  static thereafter, so no per-frame buffer writes. */
  paramsBuf: GPUBuffer
  // Per-layer GPU buffers (created lazily on first renderAccum, resized as
  // point count changes). Routed through the RHI seam (§4 batch-seam migration):
  // Rhi* handles, byte-identical to the raw VERTEX|COPY_DST / INDEX|COPY_DST /
  // STORAGE|COPY_DST buffers they replace.
  _vertBuf?: RhiBuffer
  _idxBuf?: RhiBuffer
  _featBuf?: RhiBuffer
  _bindGroup?: RhiBindGroup
  _capacity?: number
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
): void {
  const metersPerPixel = WORLD_MERC / TILE_PX / Math.pow(2, camera.zoom)
  let cHx: number, cHy: number, cHz: number, cLx: number, cLy: number, cLz: number
  if (projType === 0) {
    const cmx = camera.centerX,
      cmy = camera.centerY
    cHx = Math.fround(cmx)
    cHy = Math.fround(cmy)
    cHz = 0
    cLx = cmx - cHx
    cLy = cmy - cHy
    cLz = 0
  } else {
    const camC = camera.getECEFCenter()
    cHx = Math.fround(camC[0])
    cHy = Math.fround(camC[1])
    cHz = Math.fround(camC[2])
    cLx = camC[0] - cHx
    cLy = camC[1] - cHy
    cLz = camC[2] - cHz
  }
  const ge = globeEyeUniform(frame.eye)
  block.write({
    mvp: frame.matrix,
    proj_params: [projType, projCenterLon, projCenterLat, 0],
    viewport: [canvasWidth, canvasHeight, metersPerPixel, 0],
    cam_ecef_h: [cHx, cHy, cHz, 0],
    cam_ecef_l: [cLx, cLy, cLz, 0],
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
  private bindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: RhiBuffer
  private frameBlock = heatmapBlock() // typed std140 pack target (mvp/proj/viewport/cam_h/cam_l/globe_eye, #600)
  private readonly _frameArena = new FrameArena(64 * 1024)
  private layers: HeatmapLayer[] = []
  /** Blur direction uniforms (allocated once; the heatmap pass picks H/V).
   *  Two 16-byte buffers so a single command encoder can bind both without
   *  a mid-frame writeBuffer overwriting the other pass's direction. */
  private blurDirH: GPUBuffer
  private blurDirV: GPUBuffer
  /** Linear sampler for the ramp LUT (filtering). */
  private rampSampler: GPUSampler

  constructor(ctx: { device: GPUDevice; rhi: RhiDevice }) {
    this.device = ctx.device
    const { device } = ctx
    this.rhi = ctx.rhi

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'heatmap-accum-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    // The accum draw goes through the RHI Material seam (HeatmapDraper, which owns the
    // additive r16float single-sample pipeline); the shared bind-group layout feeds it.

    // Accum uniform — UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.uniformBuffer = this.rhi.createBuffer({
      size: this.frameBlock.byteLength, // reflected std140 size (144 = 36 f32 × 4, #600 globe_eye)
      usage: 'uniform',
      writable: true,
    })

    // Blur direction uniforms (vec4: x,y = texel step direction). Written
    // once at construction — the pass never mutates them per-frame.
    this.blurDirH = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'heatmap-blur-dir-h',
    })
    this.blurDirV = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'heatmap-blur-dir-v',
    })
    device.queue.writeBuffer(this.blurDirH, 0, new Float32Array([1, 0, 0, 0]))
    device.queue.writeBuffer(this.blurDirV, 0, new Float32Array([0, 1, 0, 0]))

    this.rampSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      label: 'heatmap-ramp-sampler',
    })
  }

  /** Blur direction uniform buffers (H / V) — read by the heatmap pass. */
  getBlurDirBuffers(): { h: GPUBuffer; v: GPUBuffer } {
    return { h: this.blurDirH, v: this.blurDirV }
  }

  /** Ramp sampler — read by the heatmap pass for the compose bind group. The
   *  per-layer compose-params buffer lives on each layer (getLayers()). */
  getRampSampler(): GPUSampler {
    return this.rampSampler
  }

  hasLayers(): boolean {
    return this.layers.length > 0
  }

  /** Build a 256×1 RGBA8 colour LUT from the ramp stops (linear interp). */
  private buildRampTexture(stops: readonly HeatmapColorStop[]): GPUTexture {
    const W = 256
    const data = new Uint8Array(W * 4)
    const sorted = [...stops].sort((a, b) => a.offset - b.offset)
    for (let i = 0; i < W; i++) {
      const t = i / (W - 1)
      // Find the bracketing stops.
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
    const tex = this.device.createTexture({
      size: { width: W, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'heatmap-ramp-lut',
    })
    this.device.queue.writeTexture(
      { texture: tex },
      data,
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
      geometry: { type: string; coordinates: number[] }
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
        for (const coord of (f.geometry as unknown as { coordinates: number[][] }).coordinates) {
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
    // Per-layer compose params (intensity, opacity) — static, written once.
    const paramsBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'heatmap-compose-params',
    })
    this.device.queue.writeBuffer(paramsBuf, 0, new Float32Array([lyIntensity, lyOpacity, 0, 0]))

    this.layers.push({
      lons,
      lats,
      weights,
      pointCount: points.length,
      radiusPx: Math.max(1, radiusPx),
      intensity: lyIntensity,
      opacity: lyOpacity,
      rampTexture: this.buildRampTexture(ramp),
      paramsBuf,
    })
    // eslint-disable-next-line no-console
    console.log(`[X-GIS] heatmap layer: ${points.length} points`)
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.rampTexture.destroy()
      layer.paramsBuf.destroy()
      // Accum buffers route through the RHI seam; ramp/params stay raw (separate set).
      if (layer._vertBuf) this.rhi.destroyBuffer(layer._vertBuf)
      if (layer._idxBuf) this.rhi.destroyBuffer(layer._idxBuf)
      if (layer._featBuf) this.rhi.destroyBuffer(layer._featBuf)
    }
    this.layers = []
  }

  /** Per-layer ramp LUT + compose-params buffer — read by the heatmap pass to
   *  drive the compose. Each heatmap layer is accum→blur→composed independently
   *  with its OWN params (intensity/opacity), so a multi-heatmap style composes
   *  each layer correctly. */
  getLayers(): readonly { rampTexture: GPUTexture; paramsBuf: GPUBuffer }[] {
    return this.layers
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
    )
    this.rhi.writeBuffer(this.uniformBuffer, 0, this.frameBlock.buffer)
  }

  /** Draw ONE heatmap layer's Gaussian splats additively into the bound accum
   *  render pass. Uploads per-point feat_data with the ECEF / Mercator DSFUN
   *  expansion (identical to PointRenderer) each frame. One draw call.
   *  `updateFrameUniform` MUST have run this frame. */
  drawLayerAccum(pass: GPURenderPassEncoder, layerIndex: number): void {
    const layer = this.layers[layerIndex]
    if (!layer) return
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
      layer._bindGroup = this.rhi.createBindGroup(wrapWebGpuBindGroupLayout(this.bindGroupLayout), [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: layer._featBuf } },
      ])
      layer._capacity = N
    }
    this.rhi.writeBuffer(layer._vertBuf!, 0, verts)
    this.rhi.writeBuffer(layer._idxBuf!, 0, indices)
    this.rhi.writeBuffer(layer._featBuf!, 0, featData)

    // The accum draw goes through the RHI Material seam (P1: the sole path). The accum
    // target is r16float — WebGL2 fail-closes on it, so this is WebGPU-only by construction.
    this.ensureHeatmapDraper()
    this._heatmapDraper!.draw(wrapWebGpuPass(pass), {
      bindGroup: layer._bindGroup!,
      vertBuf: layer._vertBuf!,
      idxBuf: layer._idxBuf!,
      indexCount: N * 6,
    })
  }

  private _heatmapDraper?: HeatmapDraper
  private ensureHeatmapDraper(): void {
    if (this._heatmapDraper) return
    this._heatmapDraper = new HeatmapDraper(this.rhi, this.bindGroupLayout)
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
