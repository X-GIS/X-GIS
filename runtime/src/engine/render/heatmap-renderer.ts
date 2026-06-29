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

import type { Camera } from '../projection/camera'
import { lonLatToECEF } from '../projection/ecef'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { getSampleCount } from '../gpu/gpu'
import { FrameArena } from '../gpu/frame-arena'
import { WebGpuDevice, wrapWebGpuPass } from './rhi/rhi-webgpu'
import { HeatmapDraper } from './material/heatmap-material'
import { heatmapUniformSlots, heatmapUniformBytes } from './heatmap-uniform-slots'
import { writeProjectionCull } from './frame-projection-uniform'

// f32 slots of the heatmap-accum 'Uniforms' struct, from reflect() (NOT hand-coded magic
// offsets — those drift from heatmap-accum.ts). The `uf[...]` packer writes at HS.<field>.
// LAZY memoising Proxy: heatmapUniformSlots() reflects a module that needs configureProjections()
// (run later in init), so the reflect() is deferred to the first HS.<field> read (a render).
let _hsSlots: Readonly<Record<string, number>> | null = null
const HS = new Proxy({} as Record<string, number>, {
  get: (_t, k: string) => (_hsSlots ??= heatmapUniformSlots().slot)[k],
})

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
  // point count changes).
  _vertBuf?: GPUBuffer
  _idxBuf?: GPUBuffer
  _featBuf?: GPUBuffer
  _bindGroup?: GPUBindGroup
  _capacity?: number
}

// Per-feature feat_data stride — matches the point renderer's pack so the
// accum VS reuses the same ECEF / Mercator DSFUN slots.
const STRIDE = 24

/** Default Mapbox heatmap-color ramp (the spec default `interpolate` over
 *  heatmap-density). Transparent at 0 so empty areas don't tint the map. */
export const DEFAULT_HEATMAP_RAMP: readonly HeatmapColorStop[] = [
  { offset: 0.0, rgba: [0, 0, 1, 0] },        // rgba(0,0,255,0)
  { offset: 0.1, rgba: [65 / 255, 105 / 255, 225 / 255, 1] },  // royalblue
  { offset: 0.3, rgba: [0, 1, 1, 1] },        // cyan
  { offset: 0.5, rgba: [0, 1, 0, 1] },        // lime
  { offset: 0.7, rgba: [1, 1, 0, 1] },        // yellow
  { offset: 1.0, rgba: [1, 0, 0, 1] },        // red
]

/** Pack the heatmap accum frame uniform (32 f32 slots):
 *  mvp 0..15, proj_params 16..19, viewport 20..23, cam_ecef_h 24..27,
 *  cam_ecef_l 28..31. Identical convention to the point frame uniform's
 *  leading block (minus circle_params). The flat-Mercator path writes the
 *  2D camera centre (DSFUN hi/lo) into cam_ecef_h.xy / cam_ecef_l.xy. */
function writeHeatmapFrameUniform(
  uf: Float32Array,
  // #600 — frame.eye is the absolute sphere-ECEF camera position (globe/ECEF
  // branch only) for the globe(7) eye-horizon cull.
  frame: { matrix: Float32Array; eye?: readonly [number, number, number] },
  camera: Camera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  uf.set(frame.matrix, HS.mvp)
  // proj_params + globe_eye written TOGETHER (coupled so a missing globe_eye —
  // the #600 leak class — is unrepresentable). frame.eye is set only on the
  // globe/ECEF branch → globe_eye all-zero on flat (flat/disc cull arms ignore it).
  writeProjectionCull(uf, HS.proj_params, HS.globe_eye, projType, projCenterLon, projCenterLat, frame.eye, 0)
  const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, camera.zoom)
  uf[HS.viewport] = canvasWidth; uf[HS.viewport + 1] = canvasHeight; uf[HS.viewport + 2] = metersPerPixel; uf[HS.viewport + 3] = 0
  if (projType === 0) {
    const cmx = camera.centerX, cmy = camera.centerY
    const cmxH = Math.fround(cmx), cmyH = Math.fround(cmy)
    uf[HS.cam_ecef_h] = cmxH; uf[HS.cam_ecef_h + 1] = cmyH; uf[HS.cam_ecef_h + 2] = 0; uf[HS.cam_ecef_h + 3] = 0
    uf[HS.cam_ecef_l] = cmx - cmxH; uf[HS.cam_ecef_l + 1] = cmy - cmyH; uf[HS.cam_ecef_l + 2] = 0; uf[HS.cam_ecef_l + 3] = 0
  } else {
    const camC = camera.getECEFCenter()
    const cxH = Math.fround(camC[0]); const cyH = Math.fround(camC[1]); const czH = Math.fround(camC[2])
    uf[HS.cam_ecef_h] = cxH; uf[HS.cam_ecef_h + 1] = cyH; uf[HS.cam_ecef_h + 2] = czH; uf[HS.cam_ecef_h + 3] = 0
    uf[HS.cam_ecef_l] = camC[0] - cxH; uf[HS.cam_ecef_l + 1] = camC[1] - cyH; uf[HS.cam_ecef_l + 2] = camC[2] - czH; uf[HS.cam_ecef_l + 3] = 0
  }
  // (proj_params + globe_eye written together above via writeProjectionCull.)
}

export class HeatmapRenderer {
  private device: GPUDevice
  private bindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: GPUBuffer
  private uniformData = new Float32Array(heatmapUniformSlots().slots) // reflect-derived (= mvp16+proj4+viewport4+cam_h4+cam_l4+globe_eye4 = 36, #600)
  private readonly _frameArena = new FrameArena(64 * 1024)
  private layers: HeatmapLayer[] = []
  /** Blur direction uniforms (allocated once; the heatmap pass picks H/V).
   *  Two 16-byte buffers so a single command encoder can bind both without
   *  a mid-frame writeBuffer overwriting the other pass's direction. */
  private blurDirH: GPUBuffer
  private blurDirV: GPUBuffer
  /** Linear sampler for the ramp LUT (filtering). */
  private rampSampler: GPUSampler

  constructor(ctx: { device: GPUDevice }) {
    this.device = ctx.device
    const { device } = ctx

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'heatmap-accum-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    // The accum draw goes through the RHI Material seam (HeatmapDraper, which owns the
    // additive r16float single-sample pipeline); the shared bind-group layout feeds it.

    this.uniformBuffer = device.createBuffer({
      size: heatmapUniformBytes(), // reflect-derived (was 144 = 36 f32 × 4, #600 globe_eye)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Blur direction uniforms (vec4: x,y = texel step direction). Written
    // once at construction — the pass never mutates them per-frame.
    this.blurDirH = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'heatmap-blur-dir-h' })
    this.blurDirV = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'heatmap-blur-dir-v' })
    device.queue.writeBuffer(this.blurDirH, 0, new Float32Array([1, 0, 0, 0]))
    device.queue.writeBuffer(this.blurDirV, 0, new Float32Array([0, 1, 0, 0]))

    this.rampSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', label: 'heatmap-ramp-sampler' })
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
      let lo = sorted[0], hi = sorted[sorted.length - 1]
      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s].offset && t <= sorted[s + 1].offset) {
          lo = sorted[s]; hi = sorted[s + 1]; break
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
    features: { geometry: { type: string; coordinates: number[] }; properties?: Record<string, unknown> }[],
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
      if (!f.geometry) { fi++; continue }
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
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'heatmap-compose-params',
    })
    this.device.queue.writeBuffer(paramsBuf, 0, new Float32Array([lyIntensity, lyOpacity, 0, 0]))

    this.layers.push({
      lons, lats, weights,
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
      layer._vertBuf?.destroy()
      layer._idxBuf?.destroy()
      layer._featBuf?.destroy()
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
    const uf = this.uniformData
    writeHeatmapFrameUniform(uf, frame, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)
  }

  /** Draw ONE heatmap layer's Gaussian splats additively into the bound accum
   *  render pass. Uploads per-point feat_data with the ECEF / Mercator DSFUN
   *  expansion (identical to PointRenderer) each frame. One draw call.
   *  `updateFrameUniform` MUST have run this frame. */
  drawLayerAccum(pass: GPURenderPassEncoder, layerIndex: number): void {
    const layer = this.layers[layerIndex]
    if (!layer) return
    const DEG2RAD = Math.PI / 180
    const R_MERC = 6378137
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
        verts[off] = 0; verts[off + 1] = 0; u32View[off + 2] = q; verts[off + 3] = i
      }
      const iBase = i * 6, vIdx = i * 4
      indices[iBase] = vIdx; indices[iBase + 1] = vIdx + 1; indices[iBase + 2] = vIdx + 2
      indices[iBase + 3] = vIdx; indices[iBase + 4] = vIdx + 2; indices[iBase + 5] = vIdx + 3

      const fOff = i * STRIDE
      featData[fOff + 0] = layer.radiusPx     // slot 0: radius_px
      featData[fOff + 1] = layer.weights[i]   // slot 1: weight
      // ECEF DSFUN centre (slots 11..16) — identical math to PointRenderer.
      const ecef = lonLatToECEF(lon, lat)
      const exH = Math.fround(ecef[0]); const eyH = Math.fround(ecef[1]); const ezH = Math.fround(ecef[2])
      featData[fOff + 11] = exH; featData[fOff + 12] = eyH; featData[fOff + 13] = ezH
      featData[fOff + 14] = ecef[0] - exH; featData[fOff + 15] = ecef[1] - eyH; featData[fOff + 16] = ecef[2] - ezH
      featData[fOff + 17] = lon; featData[fOff + 18] = lat
      // Absolute Mercator DSFUN tail (slots 20..23).
      const mx = lon * DEG2RAD * R_MERC
      const myClamp = Math.max(-85.051129, Math.min(85.051129, lat))
      const my = Math.log(Math.tan(Math.PI / 4 + myClamp * DEG2RAD / 2)) * R_MERC
      const mxH = Math.fround(mx); const myH = Math.fround(my)
      featData[fOff + 20] = mxH; featData[fOff + 21] = Math.fround(mx - mxH)
      featData[fOff + 22] = myH; featData[fOff + 23] = Math.fround(my - myH)
    }

    // (Re)allocate per-layer GPU buffers when missing or point count changed.
    if (!layer._vertBuf || layer._capacity !== N) {
      layer._vertBuf?.destroy()
      layer._idxBuf?.destroy()
      layer._featBuf?.destroy()
      layer._vertBuf = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'heatmap-vertices' })
      layer._idxBuf = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'heatmap-indices' })
      layer._featBuf = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'heatmap-features' })
      layer._bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: layer._featBuf } },
        ],
      })
      layer._capacity = N
    }
    this.device.queue.writeBuffer(layer._vertBuf!, 0, verts)
    this.device.queue.writeBuffer(layer._idxBuf!, 0, indices)
    this.device.queue.writeBuffer(layer._featBuf!, 0, featData)

    // The accum draw goes through the RHI Material seam (P1: the sole path). The accum
    // target is r16float — WebGL2 fail-closes on it, so this is WebGPU-only by construction.
    this.ensureHeatmapDraper()
    this._heatmapDraper!.draw(wrapWebGpuPass(pass), {
      bindGroup: layer._bindGroup!, vertBuf: layer._vertBuf!, idxBuf: layer._idxBuf!, indexCount: N * 6,
    })
  }

  private _heatmapDraper?: HeatmapDraper
  private ensureHeatmapDraper(): void {
    if (this._heatmapDraper) return
    this._heatmapDraper = new HeatmapDraper(new WebGpuDevice(this.device), this.bindGroupLayout)
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
