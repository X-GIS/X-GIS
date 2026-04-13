// ═══ SDF Point Renderer ═══
// Renders Point/MultiPoint features as resolution-independent circles
// using Signed Distance Field math in the fragment shader.
// Single draw call for all points via per-feature storage buffer.

import type { Camera } from './camera'
import { BLEND_ALPHA, STENCIL_DISABLED, MSAA_4X } from './gpu-shared'

// ═══ WGSL Shader ═══

const POINT_SHADER = /* wgsl */ `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;
const STRIDE: u32 = 13u;

struct Uniforms {
  mvp: mat4x4<f32>,
  proj_params: vec4<f32>,   // x=projType, y=centerLon, z=centerLat
  tile_rtc: vec4<f32>,      // xy = -project(center), zw = (0,0)
  viewport: vec4<f32>,      // xy = canvas width/height, z = meters_per_pixel
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> feat_data: array<f32>;

struct PointOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) feat_id: u32,
}

@vertex
fn vs_point(
  @location(0) center: vec2<f32>,
  @location(1) quad_id: u32,
  @location(2) feat_id: f32,
) -> PointOut {
  let offsets = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );

  let fid = u32(feat_id);
  let raw_radius = feat_data[fid * STRIDE + 0u];
  let size_mode = u32(feat_data[fid * STRIDE + 10u]) >> 4u;

  // Unit conversion: 0=px, 1=m, 2=km, 3=deg
  var radius_px: f32;
  if (size_mode == 1u) {
    radius_px = raw_radius / u.viewport.z;          // meters → pixels
  } else if (size_mode == 2u) {
    radius_px = raw_radius * 1000.0 / u.viewport.z; // km → pixels
  } else if (size_mode == 3u) {
    radius_px = raw_radius * 111320.0 / u.viewport.z; // deg → pixels (equator approx)
  } else {
    radius_px = raw_radius;                          // px: as-is
  }

  // RTC: center is pre-computed as (mercX - cameraMercX, mercY - cameraMercY)
  // stored in feat_data by CPU in f64 precision, passed as small f32 offsets
  let rtc_x = feat_data[fid * STRIDE + 11u];
  let rtc_y = feat_data[fid * STRIDE + 12u];
  let center_clip = u.mvp * vec4f(rtc_x, rtc_y, 0.0, 1.0);

  // Expand quad: offset in NDC pixels
  let px_to_ndc = vec2f(2.0 / u.viewport.x, 2.0 / u.viewport.y);
  radius_px = max(radius_px, 1.0); // minimum 1px
  // Add padding for stroke + AA
  let expand = radius_px + 2.0;
  let offset_ndc = offsets[quad_id] * expand * px_to_ndc;

  var out: PointOut;
  out.position = center_clip + vec4f(offset_ndc * center_clip.w, 0.0, 0.0);
  out.uv = offsets[quad_id] * expand / max(radius_px, 1.0);
  out.feat_id = fid;
  return out;
}

@fragment
fn fs_point(in: PointOut) -> @location(0) vec4f {
  let fid = in.feat_id;
  let dist = length(in.uv);
  let aa = fwidth(dist) * 1.5;

  // Read per-feature style
  let fill_color = vec4f(
    feat_data[fid * STRIDE + 1u],
    feat_data[fid * STRIDE + 2u],
    feat_data[fid * STRIDE + 3u],
    feat_data[fid * STRIDE + 4u]
  );
  let stroke_color = vec4f(
    feat_data[fid * STRIDE + 5u],
    feat_data[fid * STRIDE + 6u],
    feat_data[fid * STRIDE + 7u],
    feat_data[fid * STRIDE + 8u]
  );
  let stroke_w = feat_data[fid * STRIDE + 9u];
  let flags = u32(feat_data[fid * STRIDE + 10u]);

  var color = vec4f(0.0);

  // Fill (bit 0)
  if ((flags & 1u) != 0u) {
    let fill_alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
    color = vec4f(fill_color.rgb, fill_color.a * fill_alpha);
  }

  // Stroke (bit 1)
  if ((flags & 2u) != 0u) {
    let inner = 1.0 - stroke_w;
    let stroke_alpha = smoothstep(inner - aa, inner + aa, dist)
                     * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist));
    color = mix(color, vec4f(stroke_color.rgb, stroke_color.a), stroke_alpha);
  }

  // Glow (bit 2)
  if ((flags & 4u) != 0u) {
    let glow = exp(-dist * dist * 2.0) * 0.4;
    color += vec4f(fill_color.rgb * glow, glow);
  }

  if (color.a < 0.005) { discard; }
  return color;
}
`

// ═══ Types ═══

interface PointLayer {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  featureBuffer: GPUBuffer
  featData: Float32Array        // CPU copy for RTC updates
  lons: Float64Array            // original longitudes (f64)
  lats: Float64Array            // original latitudes (f64)
  indexCount: number
  pointCount: number
  bindGroup: GPUBindGroup
}

// ═══ Renderer ═══

export class PointRenderer {
  private device: GPUDevice
  private pipeline: GPURenderPipeline
  private bindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: GPUBuffer
  private uniformData = new Float32Array(28) // mvp(16) + proj_params(4) + tile_rtc(4) + viewport(2) + pad(2)
  private layers: PointLayer[] = []

  constructor(ctx: { device: GPUDevice; format: GPUTextureFormat }) {
    this.device = ctx.device
    const { device } = ctx

    const shaderModule = device.createShaderModule({ code: POINT_SHADER, label: 'sdf-point-shader' })

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] })

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 16, // center(2×f32) + quad_id(u32) + feat_id(f32)
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'uint32' as GPUVertexFormat },
        { shaderLocation: 2, offset: 12, format: 'float32' as GPUVertexFormat },
      ],
    }

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_DISABLED,
      multisample: MSAA_4X,
      label: 'sdf-point-pipeline',
    })

    this.uniformBuffer = device.createBuffer({
      size: 128, // 28 floats × 4 = 112, padded to 128
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.vertexBuffer.destroy()
      layer.indexBuffer.destroy()
      layer.featureBuffer.destroy()
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
  private tilePointBindGroup: GPUBindGroup | null = null

  /** Accumulate a point from a visible tile (pre-computed RTC) */
  addTilePoint(rtcX: number, rtcY: number, featId: number): void {
    this.tilePoints.push({ rtcX, rtcY, featId })
  }

  /** Flush accumulated tile points as a single draw call */
  flushTilePoints(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    show: { fill?: string | null; stroke?: string | null; strokeWidth?: number; size?: number | null; opacity?: number },
  ): void {
    if (this.tilePoints.length === 0) return
    const N = this.tilePoints.length

    // Parse show colors
    const fillHex = show.fill
    const strokeHex = show.stroke
    const fill = fillHex ? this.parseHex(fillHex) : null
    const stroke = strokeHex ? this.parseHex(strokeHex) : null
    const opacity = show.opacity ?? 1.0
    const radiusPx = show.size ?? 6
    const strokeWidth = (show.strokeWidth ?? 1) / Math.max(radiusPx, 1)

    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2

    // Build quad vertices + feat_data
    const STRIDE = 13
    const verts = new Float32Array(N * 4 * 4)
    const indices = new Uint32Array(N * 6)
    const featData = new Float32Array(N * STRIDE)
    const u32View = new Uint32Array(verts.buffer)

    for (let i = 0; i < N; i++) {
      const pt = this.tilePoints[i]
      const base = i * 4 * 4

      for (let q = 0; q < 4; q++) {
        const off = base + q * 4
        verts[off + 0] = 0     // center placeholder (not used — RTC in feat_data)
        verts[off + 1] = 0
        u32View[off + 2] = q
        verts[off + 3] = i
      }

      const iBase = i * 6, vBase = i * 4
      indices[iBase] = vBase; indices[iBase + 1] = vBase + 1; indices[iBase + 2] = vBase + 2
      indices[iBase + 3] = vBase; indices[iBase + 4] = vBase + 2; indices[iBase + 5] = vBase + 3

      const fOff = i * STRIDE
      featData[fOff + 0] = radiusPx
      featData[fOff + 1] = fill ? fill[0] : 0
      featData[fOff + 2] = fill ? fill[1] : 0
      featData[fOff + 3] = fill ? fill[2] : 0
      featData[fOff + 4] = fill ? fill[3] * opacity : 0
      featData[fOff + 5] = stroke ? stroke[0] : 0
      featData[fOff + 6] = stroke ? stroke[1] : 0
      featData[fOff + 7] = stroke ? stroke[2] : 0
      featData[fOff + 8] = stroke ? stroke[3] * opacity : 0
      featData[fOff + 9] = strokeWidth
      featData[fOff + 10] = flags
      featData[fOff + 11] = pt.rtcX  // pre-computed RTC (f64 precision)
      featData[fOff + 12] = pt.rtcY
    }

    // Upload (reuse or recreate buffers)
    this.tilePointBuffer?.destroy()
    this.tilePointIndexBuffer?.destroy()
    this.tilePointFeatBuffer?.destroy()

    this.tilePointBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(this.tilePointBuffer, 0, verts)
    this.tilePointIndexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(this.tilePointIndexBuffer, 0, indices)
    this.tilePointFeatBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(this.tilePointFeatBuffer, 0, featData)

    this.tilePointBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.tilePointFeatBuffer } },
      ],
    })

    // Update uniforms (viewport + mpp)
    const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)
    const uf = this.uniformData
    uf.set(mvp, 0)
    uf[16] = 0; uf[17] = projCenterLon; uf[18] = projCenterLat; uf[19] = 0
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, camera.zoom)
    uf[24] = canvasWidth; uf[25] = canvasHeight; uf[26] = metersPerPixel; uf[27] = 0
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Draw
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.tilePointBindGroup)
    pass.setVertexBuffer(0, this.tilePointBuffer)
    pass.setIndexBuffer(this.tilePointIndexBuffer, 'uint32')
    pass.drawIndexed(N * 6)

    // Clear for next frame
    this.tilePoints = []
  }

  private parseHex(hex: string): [number, number, number, number] {
    let r = 0, g = 0, b = 0, a = 1
    if (hex.length === 4) { r = parseInt(hex[1]+hex[1],16)/255; g = parseInt(hex[2]+hex[2],16)/255; b = parseInt(hex[3]+hex[3],16)/255 }
    else if (hex.length === 7) { r = parseInt(hex.slice(1,3),16)/255; g = parseInt(hex.slice(3,5),16)/255; b = parseInt(hex.slice(5,7),16)/255 }
    else if (hex.length === 9) { r = parseInt(hex.slice(1,3),16)/255; g = parseInt(hex.slice(3,5),16)/255; b = parseInt(hex.slice(5,7),16)/255; a = parseInt(hex.slice(7,9),16)/255 }
    return [r, g, b, a]
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
  ): void {
    const points: { lon: number; lat: number }[] = []

    for (const f of features) {
      if (!f.geometry) continue
      if (f.geometry.type === 'Point') {
        points.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })
      } else if (f.geometry.type === 'MultiPoint') {
        for (const coord of (f.geometry as { coordinates: number[][] }).coordinates) {
          points.push({ lon: coord[0], lat: coord[1] })
        }
      }
    }

    if (points.length === 0) return

    // Build quad vertices: 4 vertices per point
    const verts = new Float32Array(points.length * 4 * 4) // 4 verts × 4 floats
    const indices = new Uint32Array(points.length * 6)

    const u32View = new Uint32Array(verts.buffer)
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
    const STRIDE = 13
    const featData = new Float32Array(points.length * STRIDE)
    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2
    // Size mode in upper 4 bits: 0=px, 1=m, 2=km, 3=deg
    const unitMap: Record<string, number> = { m: 1, km: 2, deg: 3 }
    const sizeMode = sizeUnit ? (unitMap[sizeUnit] ?? 0) : 0
    flags |= (sizeMode << 4)

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
      featData[off + 9] = strokeWidth / Math.max(radiusPx, 1)
      featData[off + 10] = flags
      // [11] and [12] = RTC x/y, written per-frame in render()
    }

    // Store original coordinates in f64 for per-frame RTC computation
    const lons = new Float64Array(points.length)
    const lats = new Float64Array(points.length)
    for (let i = 0; i < points.length; i++) {
      lons[i] = points[i].lon
      lats[i] = points[i].lat
    }

    const vertexBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(vertexBuffer, 0, verts)

    const indexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(indexBuffer, 0, indices)

    const featureBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(featureBuffer, 0, featData)

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: featureBuffer } },
      ],
    })

    this.layers.push({
      vertexBuffer, indexBuffer, featureBuffer,
      featData, lons, lats,
      indexCount: indices.length,
      pointCount: points.length,
      bindGroup,
    })

    console.log(`[X-GIS] SDF point layer: ${points.length} points`)
  }

  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    if (this.layers.length === 0) return

    const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)
    const uf = this.uniformData

    // MVP matrix
    uf.set(mvp, 0)
    // proj_params
    uf[16] = 0 // Mercator
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
    // viewport: xy = size, z = meters_per_pixel
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, camera.zoom)
    uf[24] = canvasWidth
    uf[25] = canvasHeight
    uf[26] = metersPerPixel
    uf[27] = 0

    // tile_rtc no longer needed in uniform (RTC computed per-point in CPU)
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Camera center in Mercator (f64 precision)
    const camMercX = projCenterLon * DEG2RAD * R
    const camClampedLat = Math.max(-85.051129, Math.min(85.051129, projCenterLat))
    const camMercY = Math.log(Math.tan(Math.PI / 4 + camClampedLat * DEG2RAD / 2)) * R

    for (const layer of this.layers) {
      // Per-frame: compute RTC offsets in f64, write to feat_data as small f32
      const STRIDE = 13
      for (let i = 0; i < layer.pointCount; i++) {
        const lon = layer.lons[i]
        const lat = layer.lats[i]
        const mercX = lon * DEG2RAD * R
        const clampLat = Math.max(-85.051129, Math.min(85.051129, lat))
        const mercY = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R
        layer.featData[i * STRIDE + 11] = mercX - camMercX  // f64 subtraction → f32 (small value)
        layer.featData[i * STRIDE + 12] = mercY - camMercY
      }
      this.device.queue.writeBuffer(layer.featureBuffer, 0, layer.featData)

      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, layer.bindGroup)
      pass.setVertexBuffer(0, layer.vertexBuffer)
      pass.setIndexBuffer(layer.indexBuffer, 'uint32')
      pass.drawIndexed(layer.indexCount)
    }
  }
}
