// ═══ X-GIS Map Renderer — WebGPU ═══

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { MeshData, LineMeshData } from '../loader/geojson'
import { generateGraticule } from './graticule'
import { BLEND_ALPHA, STENCIL_WRITE, STENCIL_TEST, MSAA_4X, WORLD_COPIES, WORLD_MERC } from './gpu-shared'

// generateGraticule(zoom) now handles zoom-adaptive steps internally

// ═══ Shader Source ═══

const POLYGON_SHADER = /* wgsl */ `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;

struct Uniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  // projection params: x=type, y=centerLon_hi, z=centerLat_hi, w=unused
  proj_params: vec4<f32>,
  // Per-tile RTC: x,y = projected offset (meters), z = tile_west, w = tile_south (for backface cull)
  tile_rtc: vec4<f32>,
  // Per-frame extra: x=opacity (zoom-interpolated)
  opacity: f32,
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

const MERCATOR_LAT_LIMIT: f32 = 85.051129;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) cos_c: f32,
  @location(1) @interpolate(flat) feat_id: u32,
  @location(2) abs_lat: f32,
}

@vertex
fn vs_main(@location(0) local_pos: vec2<f32>, @location(1) feature_id: f32) -> VertexOutput {
  // Precision-safe RTC:
  // local_pos = lon/lat relative to tile origin (small values, precise in f32)
  // tile_rtc.xy = project(tile_origin) - project(camera_center), computed on CPU in f64
  // Result: project locally (small numbers only) + add precomputed offset

  // Project the local offset based on projection type
  let local_x = local_pos.x * DEG2RAD * EARTH_R;
  let abs_lat = local_pos.y + u.tile_rtc.w;
  let abs_lat_clamped = clamp(abs_lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);

  var local_y: f32;
  if (u.proj_params.x < 0.5) {
    // Mercator Y delta — stable reformulation.
    //
    // The naive form log(tan(abs_lat)) - log(tan(origin)) suffers from
    // catastrophic cancellation when both logs evaluate close together
    // (small dy). For a z=5 tile rendered at camera.zoom=22 this produced
    // ~1 m of visible jitter. Using atanh + sum-to-product avoids the
    // cancellation entirely: the numerator is computed directly from the
    // small dy without forming two large, near-equal intermediates.
    //
    //   merc_y_delta = R * atanh((sin(abs_lat) - sin(origin)) /
    //                            (1 - sin(abs_lat) * sin(origin)))
    //                = R * atanh((2 * cos(mid) * sin(dy/2)) / (1 - s_abs * s_origin))
    //
    // with atanh(z) = 0.5 * log((1+z)/(1-z)).
    let origin_rad = clamp(u.tile_rtc.w, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT) * DEG2RAD;
    let dy_rad = local_pos.y * DEG2RAD;
    let half_dy = dy_rad * 0.5;
    let mid_rad = origin_rad + half_dy;
    let s_origin = sin(origin_rad);
    let s_abs = sin(clamp(abs_lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT) * DEG2RAD);
    let num = 2.0 * cos(mid_rad) * sin(half_dy);
    let denom = max(1.0 - s_abs * s_origin, 1e-9);
    let z = num / denom;
    local_y = 0.5 * log((1.0 + z) / max(1.0 - z, 1e-9)) * EARTH_R;
  } else {
    // Equirectangular / other: linear Y
    local_y = local_pos.y * DEG2RAD * EARTH_R;
  }

  // tile_rtc.xy = project(tile_origin) - project(center), computed on CPU in f64
  let rtc = vec2<f32>(local_x + u.tile_rtc.x, local_y + u.tile_rtc.y);

  let abs_lon = local_pos.x + u.tile_rtc.z;

  var out: VertexOutput;
  out.position = u.mvp * vec4<f32>(rtc, 0.0, 1.0);
  out.cos_c = needs_backface_cull(abs_lon, abs_lat);
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  return out;
}

// ── Fragment shaders (replaceable by ShaderVariant) ──
// FILL_EXPR and STROKE_EXPR are replaced by buildShader() when a variant exists

@fragment
fn fs_fill(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.cos_c < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  return u.fill_color;
}

@fragment
fn fs_stroke(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.cos_c < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // feat_id > 0 = major grid line (brighter), 0 = minor (dimmer)
  let alpha_scale = select(0.4, 1.0, input.feat_id > 0u);
  return vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);
}
`

// Fragment markers for template replacement
const FILL_RETURN_MARKER = 'return u.fill_color;'
const STROKE_RETURN_MARKER = 'return u.stroke_color;'

export interface ShaderVariantInfo {
  key: string
  preamble: string
  fillExpr: string
  strokeExpr: string
  needsFeatureBuffer: boolean
  featureFields: string[]
  uniformFields: string[]
}

export interface CachedPipeline {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback: GPURenderPipeline
  linePipelineFallback: GPURenderPipeline
}

/**
 * Build a specialized WGSL shader by injecting variant's preamble and expressions.
 */
function buildShader(variant?: ShaderVariantInfo | null): string {
  if (!variant || (!variant.preamble && !variant.needsFeatureBuffer)) return POLYGON_SHADER

  let shader = POLYGON_SHADER
  const insertPoint = '@group(0) @binding(0) var<uniform> u: Uniforms;'

  // Insert storage buffer declaration for per-feature data
  let insertions = ''
  if (variant.needsFeatureBuffer) {
    insertions += '\n@group(0) @binding(1) var<storage, read> feat_data: array<f32>;\n'
  }

  // Insert preamble (const declarations)
  if (variant.preamble) {
    insertions += '\n// ── Specialized constants ──\n' + variant.preamble + '\n'
  }

  if (insertions) {
    shader = shader.replace(insertPoint, insertPoint + insertions)
  }

  // Replace fragment return expressions (feat_data indexing is inlined in expressions)
  if (variant.fillExpr && variant.fillExpr !== 'u.fill_color') {
    const matchCode = (variant as any).fillPreamble ? `${(variant as any).fillPreamble}  ` : ''
    shader = shader.replace(FILL_RETURN_MARKER, `${matchCode}return ${variant.fillExpr};`)
  }
  if (variant.strokeExpr && variant.strokeExpr !== 'u.stroke_color') {
    shader = shader.replace(STROKE_RETURN_MARKER, `return ${variant.strokeExpr};`)
  }

  return shader
}

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
  shaderVariant?: { key: string; preamble: string; fillExpr: string; strokeExpr: string; fillPreamble?: string; needsFeatureBuffer: boolean; featureFields: string[]; uniformFields: string[] } | null
  filterExpr?: { ast: unknown } | null  // AST expression for per-feature filtering
  geometryExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  sizeUnit?: string | null
  billboard?: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape?: string | null
  shapeDefs?: { name: string; paths: string[] }[]
  // Line styling (Phase 2+)
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  dashArray?: number[]
  dashOffset?: number
  patterns?: {
    shape: string
    spacing: number
    spacingUnit?: 'm' | 'px' | 'km' | 'nm'
    size: number
    sizeUnit?: 'm' | 'px' | 'km' | 'nm'
    offset?: number
    offsetUnit?: 'm' | 'px' | 'km' | 'nm'
    startOffset?: number
    anchor?: 'repeat' | 'start' | 'end' | 'center'
  }[]
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
  // Per-layer specialized pipelines (null = use shared default)
  fillPipeline: GPURenderPipeline | null
  linePipeline: GPURenderPipeline | null
  // Per-feature data
  featureDataBuffer: GPUBuffer | null
  perLayerBindGroup: GPUBindGroup | null
}

/** Linearly interpolate between sorted zoom stops */
export function interpolateZoom(stops: { zoom: number; value: number }[], zoom: number): number {
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
  // Cached per-frame allocation (avoid GC pressure in render loop)
  private uniformDataBuf = new ArrayBuffer(144)
  // Dynamic-offset uniform ring (see docs: multi-layer uniform slots)
  private static readonly UNIFORM_SLOT = 256
  private static readonly UNIFORM_SIZE = 144
  private uniformRingCapacity = 256 // slots
  private uniformSlot = 0
  fillPipeline!: GPURenderPipeline
  linePipeline!: GPURenderPipeline
  // Stencil-test pipelines: only draw where stencil = 0 (not covered by children)
  fillPipelineFallback!: GPURenderPipeline
  linePipelineFallback!: GPURenderPipeline
  uniformBuffer!: GPUBuffer
  bindGroupLayout!: GPUBindGroupLayout
  featureBindGroupLayout!: GPUBindGroupLayout
  private bindGroup!: GPUBindGroup
  private layers: RenderLayer[] = []
  private graticuleBuffer: GPUBuffer | null = null
  private graticuleVertexCount = 0
  private lastGratZoom = -1

  /** Get rendering stats for all layers */
  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const layer of this.layers) {
      if (layer.polygonIndexCount > 0) {
        drawCalls++
        vertices += layer.polygonIndexCount
        triangles += Math.floor(layer.polygonIndexCount / 3)
      }
      if (layer.lineIndexCount > 0) {
        drawCalls++
        lines += Math.floor(layer.lineIndexCount / 2)
      }
    }
    if (this.graticuleVertexCount > 0) {
      drawCalls++
      lines += Math.floor(this.graticuleVertexCount / 2)
      vertices += this.graticuleVertexCount
    }
    return { drawCalls, vertices, triangles, lines }
  }

  // Shader variant cache: variant key → compiled pipeline set
  private shaderCache = new Map<string, CachedPipeline>()

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
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })

    this.featureBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    })

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 12, // polygon fill: 2×f32 (lon,lat) + 1×f32 (feat_id)
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'float32' as GPUVertexFormat },
      ],
    }
    // Line features carry an extra arc_start component (stride 16).
    // The shader reads only position + feat_id; arc_start is ignored here
    // (the SDF LineRenderer consumes it via a storage buffer).
    const lineVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 16,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'float32' as GPUVertexFormat },
      ],
    }

    // Fill pipeline (stencil write — current zoom tiles)
    this.fillPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_fill', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_WRITE, multisample: MSAA_4X,
      label: 'fill-pipeline',
    })

    // Line pipeline (stencil write)
    this.linePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: STENCIL_WRITE,
      multisample: MSAA_4X,
      label: 'line-pipeline',
    })

    // Fallback fill pipeline (stencil test — only where stencil=0)
    this.fillPipelineFallback = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_fill', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_TEST, multisample: MSAA_4X,
      label: 'fill-pipeline-fallback',
    })

    // Fallback line pipeline (stencil test)
    this.linePipelineFallback = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: STENCIL_TEST, multisample: MSAA_4X,
      label: 'line-pipeline-fallback',
    })

    // Uniform ring buffer: 256-byte slots, dynamic offsets per draw.
    // Guarantees that multi-layer draws don't overwrite each other's uniforms.
    this.uniformBuffer = device.createBuffer({
      size: this.uniformRingCapacity * MapRenderer.UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniform-ring',
    })

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } }],
    })
  }

  /** Reset the ring-buffer slot cursor. Call once per frame before any draws. */
  beginFrame(): void {
    this.uniformSlot = 0
  }

  private allocUniformSlot(): number {
    if (this.uniformSlot >= this.uniformRingCapacity) this.growUniformRing(this.uniformSlot + 1)
    return this.uniformSlot++ * MapRenderer.UNIFORM_SLOT
  }

  private growUniformRing(minSlots: number): void {
    const { device } = this.ctx
    let newCap = this.uniformRingCapacity
    while (newCap < minSlots) newCap *= 2
    this.uniformBuffer?.destroy()
    this.uniformRingCapacity = newCap
    this.uniformBuffer = device.createBuffer({
      size: newCap * MapRenderer.UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniform-ring',
    })
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } }],
    })
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
          ],
        })
      }
    }
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

    // Create per-layer specialized pipelines if shader variant exists
    const variant = show.shaderVariant as ShaderVariantInfo | null | undefined
    let layerFillPipeline: GPURenderPipeline | null = null
    let layerLinePipeline: GPURenderPipeline | null = null

    if (variant && (variant.preamble || variant.needsFeatureBuffer || variant.fillExpr !== 'u.fill_color')) {
      const cached = this.shaderCache.get(variant.key)
      if (cached) {
        layerFillPipeline = cached.fillPipeline
        layerLinePipeline = cached.linePipeline
      } else {
        const pipelines = this.createVariantPipelines(variant)
        layerFillPipeline = pipelines.fillPipeline
        layerLinePipeline = pipelines.linePipeline
        this.shaderCache.set(variant.key, pipelines)
        console.log(`[X-GIS] Specialized shader for layer "${show.targetName}" (key: ${variant.key})`)
      }
    }

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
      fillPipeline: layerFillPipeline,
      linePipeline: layerLinePipeline,
      featureDataBuffer: null,
      perLayerBindGroup: null,
    }

    // Build per-feature storage buffer if needed
    if (variant?.needsFeatureBuffer && polygons.features.length > 0) {
      const fieldCount = variant.featureFields.length
      if (fieldCount > 0) {
        const featureCount = polygons.features.length
        const data = new Float32Array(featureCount * fieldCount)
        // Build string→categoryID maps for string fields
        const catMaps = new Map<string, Map<string, number>>()
        for (const fieldName of variant.featureFields) {
          const uniqueVals = new Set<string>()
          for (const feat of polygons.features) {
            const v = feat.properties[fieldName]
            if (typeof v === 'string') uniqueVals.add(v)
          }
          if (uniqueVals.size > 0) {
            const sorted = [...uniqueVals].sort()
            const map = new Map<string, number>()
            sorted.forEach((v, i) => map.set(v, i))
            catMaps.set(fieldName, map)
          }
        }

        for (let i = 0; i < featureCount; i++) {
          const props = polygons.features[i].properties
          for (let j = 0; j < fieldCount; j++) {
            const fieldName = variant.featureFields[j]
            const val = props[fieldName]
            const catMap = catMaps.get(fieldName)
            if (catMap && typeof val === 'string') {
              data[i * fieldCount + j] = catMap.get(val) ?? 0
            } else {
              data[i * fieldCount + j] = typeof val === 'number' ? val : 0
            }
          }
        }

        layer.featureDataBuffer = device.createBuffer({
          size: Math.max(data.byteLength, 16), // min 16 bytes for WebGPU
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: `${show.targetName}-feat-data`,
        })
        device.queue.writeBuffer(layer.featureDataBuffer, 0, data)

        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
          ],
        })

        console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields for "${show.targetName}"`)
      }
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

  /** Get or create variant pipelines (public for vector tile renderer) */
  getOrCreateVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const cached = this.shaderCache.get(variant.key)
    if (cached) return cached
    const pipelines = this.createVariantPipelines(variant)
    this.shaderCache.set(variant.key, pipelines)
    return pipelines
  }

  /** Create specialized fill + line pipelines for a shader variant */
  private createVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const { device, format } = this.ctx
    const wgsl = buildShader(variant)

    const module = device.createShaderModule({
      code: wgsl,
      label: `shader-${variant.key}`,
    })

    // Use feature bind group layout if storage buffer is needed
    const layout = variant.needsFeatureBuffer ? this.featureBindGroupLayout : this.bindGroupLayout
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layout],
    })

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'float32' as GPUVertexFormat },
      ],
    }
    const lineVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 16,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'float32' as GPUVertexFormat },
      ],
    }

    const fillPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_fill', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_WRITE, multisample: MSAA_4X,
      label: `fill-${variant.key}`,
    })

    const linePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_stroke', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: STENCIL_WRITE, multisample: MSAA_4X,
      label: `line-${variant.key}`,
    })

    const fillPipelineFallback = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_fill', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_TEST, multisample: MSAA_4X,
      label: `fill-fallback-${variant.key}`,
    })

    const linePipelineFallback = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_stroke', targets: [{ format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: STENCIL_TEST, multisample: MSAA_4X,
      label: `line-fallback-${variant.key}`,
    })

    return { fillPipeline, linePipeline, fillPipelineFallback, linePipelineFallback }
  }

  private initGraticule(zoom = 2): void {
    const grat = generateGraticule(zoom)
    this.graticuleBuffer?.destroy()
    this.graticuleBuffer = this.ctx.device.createBuffer({
      size: grat.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'graticule',
    })
    this.ctx.device.queue.writeBuffer(this.graticuleBuffer, 0, grat.vertices)
    this.graticuleVertexCount = grat.indexCount
    this.lastGratZoom = zoom
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
      layer.featureDataBuffer?.destroy()
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

      const uniformData = this.uniformDataBuf
      new Float32Array(uniformData, 0, 16).set(mvp)
      new Float32Array(uniformData, 64, 4).set(fillColor as number[])
      new Float32Array(uniformData, 80, 4).set(strokeColor as number[])
      new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
      // Non-tiled: vertices are absolute lon/lat, so tile_origin = (0,0)
      // RTC offset = project(0,0) - project(center) ← but origin is 0, so just -project(center)
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const cx = projCenterLon * DEG2RAD * R
      const cy = projType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + Math.max(-85.051129, Math.min(85.051129, projCenterLat)) * DEG2RAD / 2)) * R  // Mercator
        : projCenterLat * DEG2RAD * R  // Equirectangular (linear)
      new Float32Array(uniformData, 112, 4).set([-cx, -cy, 0, 0]) // tile_rtc: offset, west=0, south=0
      new Float32Array(uniformData, 128, 1)[0] = opacity // zoom-interpolated opacity
      const slotOffset = this.allocUniformSlot()
      device.queue.writeBuffer(this.uniformBuffer, slotOffset, uniformData)

      // Select bind group: per-layer (with feature data) or shared
      const bindGroup = layer.perLayerBindGroup ?? this.bindGroup

      // Draw filled polygons (use per-layer pipeline if specialized)
      // Data-driven fill: fillRaw is null but shader variant provides the color
      const hasFill = fillRaw || layer.fillPipeline
      if (hasFill && layer.polygonVertexBuffer && layer.polygonIndexBuffer) {
        pass.setPipeline(layer.fillPipeline ?? this.fillPipeline)
        pass.setBindGroup(0, bindGroup, [slotOffset])
        pass.setVertexBuffer(0, layer.polygonVertexBuffer)
        pass.setIndexBuffer(layer.polygonIndexBuffer, 'uint32')
        pass.drawIndexed(layer.polygonIndexCount)
      }

      // Draw line strokes (use per-layer pipeline if specialized)
      if (strokeRaw && layer.lineVertexBuffer && layer.lineIndexBuffer) {
        pass.setPipeline(layer.linePipeline ?? this.linePipeline)
        pass.setBindGroup(0, bindGroup, [slotOffset])
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

    // Regenerate graticule if zoom level changed (adaptive spacing)
    const gratZoom = Math.round(camera.zoom)
    if (gratZoom !== this.lastGratZoom) {
      this.initGraticule(gratZoom)
    }

    // Draw graticule grid lines (primary world + copies)
    // Each world copy needs its own uniform buffer (WebGPU batches writeBuffer)
    if (this.graticuleBuffer) {
      const gDEG2RAD = Math.PI / 180
      const gR = 6378137
      const gcy = Math.log(Math.tan(Math.PI / 4 + Math.max(-85.051129, Math.min(85.051129, projCenterLat)) * gDEG2RAD / 2)) * gR
      // WORLD_MERC imported from gpu-shared

      pass.setPipeline(this.linePipeline)
      pass.setVertexBuffer(0, this.graticuleBuffer)

      const worldOffs = WORLD_COPIES

      for (let wi = 0; wi < worldOffs.length; wi++) {
        const gratData = new ArrayBuffer(144)
        new Float32Array(gratData, 0, 16).set(mvp)
        new Float32Array(gratData, 64, 4).set([1, 1, 1, 0.15])
        new Float32Array(gratData, 80, 4).set([1, 1, 1, 0.15])
        new Float32Array(gratData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
        const gcx = projCenterLon * gDEG2RAD * gR - worldOffs[wi] * WORLD_MERC
        new Float32Array(gratData, 112, 4).set([-gcx, -gcy, 0, 0])
        const gratOff = this.allocUniformSlot()
        device.queue.writeBuffer(this.uniformBuffer, gratOff, gratData)

        pass.setBindGroup(0, this.bindGroup, [gratOff])
        pass.draw(this.graticuleVertexCount)
      }
    }

    // pass.end() and submit() are handled by caller
  }
}
