// ═══ X-GIS Map Renderer — WebGPU ═══

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { MeshData, LineMeshData } from '../loader/geojson'
import { generateGraticule } from './graticule'

function createGraticuleData(step: number) { return generateGraticule(step) }

// ═══ Shader Source ═══

const POLYGON_SHADER = /* wgsl */ `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;

struct Uniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  // projection params: x=type(0=merc,1=equi,2=natearth,3=ortho), y=centerLon, z=centerLat, w=unused
  proj_params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

// ── GPU Projections ──

fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = clamp(lat_deg, -85.05, 85.05);
  let x = lon_deg * DEG2RAD * EARTH_R;
  let y = log(tan(PI / 4.0 + lat * DEG2RAD / 2.0)) * EARTH_R;
  return vec2<f32>(x, y);
}

fn proj_equirectangular(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  return vec2<f32>(lon_deg * DEG2RAD * EARTH_R, lat_deg * DEG2RAD * EARTH_R);
}

// Natural Earth (simplified LUT via polynomial approximation)
fn proj_natural_earth(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = lat_deg * DEG2RAD;
  let lat2 = lat * lat;
  let lat4 = lat2 * lat2;
  let lat6 = lat2 * lat4;
  // Polynomial coefficients for Natural Earth
  let x_scale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6;
  let y_val = lat * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)));
  let x = lon_deg * DEG2RAD * x_scale * EARTH_R;
  let y = y_val * EARTH_R;
  return vec2<f32>(x, y);
}

fn proj_orthographic(lon_deg: f32, lat_deg: f32, center_lon: f32, center_lat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD;
  let phi = lat_deg * DEG2RAD;
  let lam0 = center_lon * DEG2RAD;
  let phi0 = center_lat * DEG2RAD;
  let x = EARTH_R * cos(phi) * sin(lam - lam0);
  let y = EARTH_R * (cos(phi0) * sin(phi) - sin(phi0) * cos(phi) * cos(lam - lam0));
  return vec2<f32>(x, y);
}

// Azimuthal Equidistant — 진짜 중심 기준 최소 왜곡
// 중심에서 거리와 방향이 정확. 중심 왜곡 0.
fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;

  let cos_c = sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
  let c = acos(clamp(cos_c, -1.0, 1.0));

  if (c < 0.0001) { return vec2<f32>(0.0, 0.0); } // at center

  let k = c / sin(c);
  let x = EARTH_R * k * cos(phi) * sin(lam - l0);
  let y = EARTH_R * k * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0));
  return vec2<f32>(x, y);
}

// Oblique Mercator — 중심 기준 등각 (Mercator 느낌 + 중심 왜곡 0)
// 1) 좌표를 중심점 기준으로 회전 (중심 → 적도/본초자오선)
// 2) 회전된 좌표에 일반 Mercator 적용
fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let d_lam = lam - l0;

  // Oblique rotation: rotate coordinate system so (clon,clat) → (0,0)
  // After rotation, center point has phi'=0, lam'=0
  // The "B" value in Snyder's formulation
  let B = cos(phi) * sin(d_lam);
  let lam_rot = atan2(
    cos(phi) * sin(d_lam),
    cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(d_lam)
  );
  let phi_rot = asin(clamp(
    sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(d_lam),
    -1.0, 1.0
  ));

  // Now center has phi_rot ≈ PI/2 (it went to north pole)
  // We want center at equator, so subtract PI/2 from rotated latitude
  let phi_shifted = phi_rot - PI / 2.0;

  // Apply standard Mercator to shifted coords
  let x = EARTH_R * lam_rot;
  let y_lat = clamp(phi_shifted, -1.5, 1.5);  // clamp to avoid log(tan) explosion
  let y = EARTH_R * log(tan(PI / 4.0 + y_lat / 2.0));

  return vec2<f32>(x, y);
}

// Stereographic — 중심 기준 등각 (형태 보존)
fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;

  let cos_c = sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
  let k = 2.0 / (1.0 + cos_c);

  // cos_c < -0.9 means near antipode → clip
  if (cos_c < -0.9) { return vec2<f32>(1e15, 1e15); }

  let x = EARTH_R * k * cos(phi) * sin(lam - l0);
  let y = EARTH_R * k * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0));
  return vec2<f32>(x, y);
}

fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  return sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
}

// proj_type: 0=merc, 1=equirect, 2=natearth, 3=ortho, 4=azimuthal_equidist, 5=stereographic, 6=oblique_mercator
fn project(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let t = u.proj_params.x;
  let clon = u.proj_params.y;
  let clat = u.proj_params.z;

  if (t < 0.5) { return proj_mercator(lon_deg, lat_deg); }
  else if (t < 1.5) { return proj_equirectangular(lon_deg, lat_deg); }
  else if (t < 2.5) { return proj_natural_earth(lon_deg, lat_deg); }
  else if (t < 3.5) { return proj_orthographic(lon_deg, lat_deg, clon, clat); }
  else if (t < 4.5) { return proj_azimuthal_equidistant(lon_deg, lat_deg, clon, clat); }
  else if (t < 5.5) { return proj_stereographic(lon_deg, lat_deg, clon, clat); }
  else { return proj_oblique_mercator(lon_deg, lat_deg, clon, clat); }
}

fn needs_backface_cull(lon_deg: f32, lat_deg: f32) -> f32 {
  let t = u.proj_params.x;
  let clon = u.proj_params.y;
  let clat = u.proj_params.z;

  // All globe/center-based projections: cull back hemisphere
  // 3=orthographic, 4=azimuthal_equidistant, 5=stereographic
  if (t > 2.5) {
    let cc = center_cos_c(lon_deg, lat_deg, clon, clat);
    // Orthographic: strict hemisphere (cos_c < 0)
    if (t < 3.5) { return cc; }
    // Azimuthal Equidistant: allow most of globe but clip near antipode
    if (t < 4.5) { return select(-1.0, 1.0, cc > -0.85); }
    // Stereographic: clip near antipode
    return select(-1.0, 1.0, cc > -0.8);
  }
  return 1.0; // flat projections: no culling
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) cos_c: f32,   // for orthographic back-face culling
}

@vertex
fn vs_main(@location(0) lonlat: vec2<f32>) -> VertexOutput {
  let center_lon = u.proj_params.y;
  let center_lat = u.proj_params.z;

  // RTC: Project vertex AND center, then subtract
  // → coordinates are small (relative to center) → no f32 precision loss
  let vertex_projected = project(lonlat.x, lonlat.y);
  let center_projected = project(center_lon, center_lat);
  let rtc = vertex_projected - center_projected;

  var out: VertexOutput;
  out.position = u.mvp * vec4<f32>(rtc, 0.0, 1.0);

  // Back-face culling for globe projections (orthographic, stereographic)
  out.cos_c = needs_backface_cull(lonlat.x, lonlat.y);
  return out;
}

@fragment
fn fs_fill(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.cos_c < 0.0) { discard; }
  return u.fill_color;
}

@fragment
fn fs_stroke(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.cos_c < 0.0) { discard; }
  return u.stroke_color;
}
`

// ═══ Color parsing ═══

function parseColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  if (hex.length === 4) {
    // #RGB
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 7) {
    // #RRGGBB
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
  } else if (hex.length === 9) {
    // #RRGGBBAA
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
    a = parseInt(hex.substring(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

// ═══ Show command (parsed from AST) ═══

export interface ShowCommand {
  targetName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  projection: string
  visible: boolean
  opacity: number
  size?: number | null
  zoomOpacityStops?: { zoom: number; value: number }[] | null
  zoomSizeStops?: { zoom: number; value: number }[] | null
  shaderVariant?: { key: string; preamble: string; fillExpr: string; strokeExpr: string; needsFeatureBuffer: boolean; featureFields: string[]; uniformFields: string[] } | null
}

/**
 * Dynamic property store — X-GIS 속성을 런타임에 변경 가능.
 * 컴파일된 기본값 + 클라이언트 오버라이드.
 */
export class StyleProperties {
  private defaults = new Map<string, unknown>()
  private overrides = new Map<string, unknown>()

  setDefault(key: string, value: unknown): void {
    this.defaults.set(key, value)
  }

  set(key: string, value: unknown): void {
    this.overrides.set(key, value)
  }

  get(key: string): unknown {
    return this.overrides.get(key) ?? this.defaults.get(key)
  }

  getColor(key: string): [number, number, number, number] | null {
    const v = this.get(key)
    if (typeof v === 'string') return parseColor(v)
    if (v === null || v === undefined) return null
    return v as [number, number, number, number]
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.get(key)
    if (typeof v === 'number') return v
    return fallback
  }

  getBool(key: string, fallback = true): boolean {
    const v = this.get(key)
    if (typeof v === 'boolean') return v
    return fallback
  }

  reset(key: string): void {
    this.overrides.delete(key)
  }

  resetAll(): void {
    this.overrides.clear()
  }

  /** List all property names */
  keys(): string[] {
    return [...new Set([...this.defaults.keys(), ...this.overrides.keys()])]
  }
}

// ═══ Render Layer ═══

interface RenderLayer {
  show: ShowCommand
  props: StyleProperties
  polygonVertexBuffer: GPUBuffer | null
  polygonIndexBuffer: GPUBuffer | null
  polygonIndexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  zoomOpacityStops: { zoom: number; value: number }[] | null
  zoomSizeStops: { zoom: number; value: number }[] | null
}

/** Linearly interpolate between sorted zoom stops */
function interpolateZoom(stops: { zoom: number; value: number }[], zoom: number): number {
  if (stops.length === 0) return 1.0
  if (zoom <= stops[0].zoom) return stops[0].value
  if (zoom >= stops[stops.length - 1].zoom) return stops[stops.length - 1].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const t = (zoom - stops[i].zoom) / (stops[i + 1].zoom - stops[i].zoom)
      return stops[i].value + t * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

// ═══ MapRenderer ═══

export class MapRenderer {
  private ctx: GPUContext
  private fillPipeline!: GPURenderPipeline
  private strokePipeline!: GPURenderPipeline
  private linePipeline!: GPURenderPipeline
  private uniformBuffer!: GPUBuffer
  private bindGroupLayout!: GPUBindGroupLayout
  private bindGroup!: GPUBindGroup
  private layers: RenderLayer[] = []
  private graticuleBuffer: GPUBuffer | null = null
  private graticuleVertexCount = 0

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    this.initPipelines()
    this.initGraticule()
  }

  private initPipelines(): void {
    const { device, format } = this.ctx

    const shaderModule = device.createShaderModule({
      code: POLYGON_SHADER,
      label: 'xgis-shader',
    })

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    })

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    })

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8, // 2 x f32
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
    }

    // Fill pipeline (triangles)
    this.fillPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_fill', targets: [{ format, blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      }}] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      label: 'fill-pipeline',
    })

    // Line pipeline (line-list)
    this.linePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets: [{ format, blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      }}] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      label: 'line-pipeline',
    })

    // Uniform buffer (MVP + colors + strokeWidth = 64 + 16 + 16 + 4 = padded to 112)
    this.uniformBuffer = device.createBuffer({
      size: 128, // 4x4 matrix(64) + fill(16) + stroke(16) + strokeWidth(4) + padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniforms',
    })

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    })
  }

  /** Register data + show command as a render layer */
  addLayer(show: ShowCommand, polygons: MeshData, lines: LineMeshData): void {
    const { device } = this.ctx
    // Create dynamic property store with compiled defaults
    const props = new StyleProperties()
    props.setDefault('fill', show.fill)
    props.setDefault('stroke', show.stroke)
    props.setDefault('strokeWidth', show.strokeWidth)
    props.setDefault('visible', show.visible ?? true)
    props.setDefault('opacity', show.opacity ?? 1.0)

    const layer: RenderLayer = {
      show,
      props,
      polygonVertexBuffer: null,
      polygonIndexBuffer: null,
      polygonIndexCount: 0,
      lineVertexBuffer: null,
      lineIndexBuffer: null,
      lineIndexCount: 0,
      zoomOpacityStops: show.zoomOpacityStops ?? null,
      zoomSizeStops: show.zoomSizeStops ?? null,
    }

    // Upload polygon mesh
    if (polygons.indices.length > 0) {
      layer.polygonVertexBuffer = device.createBuffer({
        size: polygons.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-poly-vtx`,
      })
      device.queue.writeBuffer(layer.polygonVertexBuffer, 0, polygons.vertices)

      layer.polygonIndexBuffer = device.createBuffer({
        size: polygons.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-poly-idx`,
      })
      device.queue.writeBuffer(layer.polygonIndexBuffer, 0, polygons.indices)
      layer.polygonIndexCount = polygons.indices.length
    }

    // Upload line mesh
    if (lines.indices.length > 0) {
      layer.lineVertexBuffer = device.createBuffer({
        size: lines.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-line-vtx`,
      })
      device.queue.writeBuffer(layer.lineVertexBuffer, 0, lines.vertices)

      layer.lineIndexBuffer = device.createBuffer({
        size: lines.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-line-idx`,
      })
      device.queue.writeBuffer(layer.lineIndexBuffer, 0, lines.indices)
      layer.lineIndexCount = lines.indices.length
    }

    this.layers.push(layer)
  }

  private initGraticule(): void {
    const grat = createGraticuleData(15)
    this.graticuleBuffer = this.ctx.device.createBuffer({
      size: grat.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'graticule',
    })
    this.ctx.device.queue.writeBuffer(this.graticuleBuffer, 0, grat.vertices)
    this.graticuleVertexCount = grat.indexCount
  }

  /** Remove all layers (for re-projection) */
  getLayer(name: string): RenderLayer | undefined {
    return this.layers.find((l) => l.show.targetName === name)
  }

  listProperties(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const layer of this.layers) {
      result[layer.show.targetName] = layer.props.keys()
    }
    return result
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.polygonVertexBuffer?.destroy()
      layer.polygonIndexBuffer?.destroy()
      layer.lineVertexBuffer?.destroy()
      layer.lineIndexBuffer?.destroy()
    }
    this.layers = []
  }

  /** Render all layers into an existing render pass (RTC projection) */
  renderToPass(pass: GPURenderPassEncoder, camera: Camera, projType = 0, projCenterLon = 0, projCenterLat = 20): void {
    const { device, canvas } = this.ctx
    // RTC: no translation in MVP, projection center is at (0,0)
    const mvp = camera.getRTCMatrix(canvas.width, canvas.height)

    for (const layer of this.layers) {
      // Read from dynamic properties (supports runtime override)
      if (!layer.props.getBool('visible')) continue

      // Zoom-interpolated values override defaults
      const opacity = layer.zoomOpacityStops
        ? interpolateZoom(layer.zoomOpacityStops, camera.zoom)
        : layer.props.getNumber('opacity', 1.0)
      const fillRaw = layer.props.getColor('fill')
      const strokeRaw = layer.props.getColor('stroke')
      const fillColor = fillRaw ? [fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * opacity] : [0, 0, 0, 0]
      const strokeColor = strokeRaw ? [strokeRaw[0], strokeRaw[1], strokeRaw[2], strokeRaw[3] * opacity] : [0, 0, 0, 0]

      const uniformData = new ArrayBuffer(128)
      new Float32Array(uniformData, 0, 16).set(mvp)
      new Float32Array(uniformData, 64, 4).set(fillColor as number[])
      new Float32Array(uniformData, 80, 4).set(strokeColor as number[])
      new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
      device.queue.writeBuffer(this.uniformBuffer, 0, uniformData)

      // Draw filled polygons
      if (fillRaw && layer.polygonVertexBuffer && layer.polygonIndexBuffer) {
        pass.setPipeline(this.fillPipeline)
        pass.setBindGroup(0, this.bindGroup)
        pass.setVertexBuffer(0, layer.polygonVertexBuffer)
        pass.setIndexBuffer(layer.polygonIndexBuffer, 'uint32')
        pass.drawIndexed(layer.polygonIndexCount)
      }

      // Draw line strokes
      if (strokeRaw && layer.lineVertexBuffer && layer.lineIndexBuffer) {
        pass.setPipeline(this.linePipeline)
        pass.setBindGroup(0, this.bindGroup)
        pass.setVertexBuffer(0, layer.lineVertexBuffer)
        pass.setIndexBuffer(layer.lineIndexBuffer, 'uint32')
        pass.drawIndexed(layer.lineIndexCount)
      }

      // Draw polygon outlines (stroke on polygons)
      // For MVP: render polygon edges as lines
      if (layer.show.stroke && layer.polygonVertexBuffer && layer.polygonIndexBuffer) {
        // We reuse polygon vertices but need line topology
        // For simplicity in MVP, we skip polygon outlines (only line features get stroked)
        // Full implementation would extract edges from triangulated polygons
      }
    }

    // Draw graticule grid lines
    if (this.graticuleBuffer) {
      const gratUniform = new ArrayBuffer(128)
      new Float32Array(gratUniform, 0, 16).set(mvp)
      new Float32Array(gratUniform, 64, 4).set([1, 1, 1, 0.15]) // white, low alpha
      new Float32Array(gratUniform, 80, 4).set([1, 1, 1, 0.15])
      new Float32Array(gratUniform, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
      device.queue.writeBuffer(this.uniformBuffer, 0, gratUniform)

      pass.setPipeline(this.linePipeline)
      pass.setBindGroup(0, this.bindGroup)
      pass.setVertexBuffer(0, this.graticuleBuffer)
      pass.draw(this.graticuleVertexCount)
    }

    // pass.end() and submit() are handled by caller
  }
}
