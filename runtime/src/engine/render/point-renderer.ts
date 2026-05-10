// ═══ SDF Point Renderer ═══
// Renders Point/MultiPoint features as resolution-independent circles
// using Signed Distance Field math in the fragment shader.
// Single draw call for all points via per-feature storage buffer.

import type { Camera } from '../projection/camera'
import { BLEND_ALPHA, DEPTH_TEST_WRITE, WORLD_MERC, worldCopiesFor } from '../gpu/gpu-shared'
import { getSampleCount } from '../gpu/gpu'
import { WGSL_LOG_DEPTH_FNS } from '../shaders/log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from '../shaders/projection'
import type { ShapeRegistry } from '../text/sdf-shape'
import { parseHexColor } from '../feature-helpers'

// ═══ WGSL Shader ═══

const POINT_SHADER = /* wgsl */ `
${WGSL_PROJECTION_CONSTS}
const STRIDE: u32 = 14u;
${WGSL_LOG_DEPTH_FNS}

struct Uniforms {
  mvp: mat4x4<f32>,
  proj_params: vec4<f32>,   // x=projType, y=centerLon, z=centerLat
  tile_rtc: vec4<f32>,      // xy = -project(center), zw = (0,0)
  viewport: vec4<f32>,      // xy = canvas w/h, z = meters_per_pixel, w = log_depth_fc
}

// Shape SDF storage buffers
struct ShapeDesc {
  seg_start: u32,
  seg_count: u32,
  bbox_min_x: f32,
  bbox_min_y: f32,
  bbox_max_x: f32,
  bbox_max_y: f32,
  _pad0: f32,
  _pad1: f32,
}

struct Segment {
  kind: u32,        // 0=line, 1=quadratic, 2=cubic
  color_idx: u32,
  flags: u32,
  _pad: u32,
  p0: vec2f,
  p1: vec2f,
  p2: vec2f,
  p3: vec2f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> feat_data: array<f32>;
@group(0) @binding(2) var<storage, read> shapes: array<ShapeDesc>;
@group(0) @binding(3) var<storage, read> segments: array<Segment>;

${WGSL_PROJECTION_FNS}

// Reconstruct camera-relative position in the CURRENT projection's
// coordinate frame from the point's pre-computed (mercX - cameraMercX,
// mercY - cameraMercY) Mercator-meter offset stored in feat_data.
//
// Mercator (proj_params.x < 0.5): the offset is already what we want.
// Non-Mercator: add camera Mercator back to get absolute Mercator, convert
// to lon/lat, project through the dispatch, subtract projected camera.
fn reproject_point(rtc_merc: vec2<f32>) -> vec2<f32> {
  if (u.proj_params.x < 0.5) { return rtc_merc; }
  let cam_lat = clamp(u.proj_params.z, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  let cam_merc_x = u.proj_params.y * DEG2RAD * EARTH_R;
  let cam_merc_y = log(tan(PI / 4.0 + cam_lat * DEG2RAD / 2.0)) * EARTH_R;
  let abs_merc_x = rtc_merc.x + cam_merc_x;
  let abs_merc_y = rtc_merc.y + cam_merc_y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  let proj_xy = project(abs_lon, abs_lat, u.proj_params);
  let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
  return proj_xy - center_xy;
}

// Backface signal at a point's center. Same lon/lat reconstruction as
// reproject_point's non-Mercator branch, dispatched through
// needs_backface_cull. Cheap for flat projections — that helper
// returns +1 immediately when proj_params.x < 2.5.
fn point_cos_c(rtc_merc: vec2<f32>) -> f32 {
  let cam_lat = clamp(u.proj_params.z, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  let cam_merc_x = u.proj_params.y * DEG2RAD * EARTH_R;
  let cam_merc_y = log(tan(PI / 4.0 + cam_lat * DEG2RAD / 2.0)) * EARTH_R;
  let abs_merc_x = rtc_merc.x + cam_merc_x;
  let abs_merc_y = rtc_merc.y + cam_merc_y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  return needs_backface_cull(abs_lon, abs_lat, u.proj_params);
}

// ── SDF distance functions ──

fn dist_to_line(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let len2 = dot(ab, ab);
  if (len2 < 1e-10) { return length(p - a); }
  let t = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
  return length(p - a - ab * t);
}

fn dist_to_quadratic(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  var best_d: f32 = 1e10;
  let STEPS = 16u;
  for (var i = 0u; i <= STEPS; i++) {
    let t = f32(i) / f32(STEPS);
    let ab = mix(a, b, t);
    let bc = mix(b, c, t);
    let q = mix(ab, bc, t);
    best_d = min(best_d, length(p - q));
  }
  return best_d;
}

fn dist_to_cubic(p: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> f32 {
  var best_d: f32 = 1e10;
  let STEPS = 24u;
  for (var i = 0u; i <= STEPS; i++) {
    let t = f32(i) / f32(STEPS);
    let ab = mix(a, b, t); let bc = mix(b, c, t); let cd = mix(c, d, t);
    let abc = mix(ab, bc, t); let bcd = mix(bc, cd, t);
    let q = mix(abc, bcd, t);
    best_d = min(best_d, length(p - q));
  }
  return best_d;
}

// Winding number contribution from a line segment (horizontal ray cast)
fn winding_line(p: vec2f, a: vec2f, b: vec2f) -> i32 {
  if (a.y <= p.y) {
    if (b.y > p.y) {
      let cross_val = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (cross_val > 0.0) { return 1; }
    }
  } else {
    if (b.y <= p.y) {
      let cross_val = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (cross_val < 0.0) { return -1; }
    }
  }
  return 0;
}

fn sdf_shape(uv_in: vec2f, shape_id: u32) -> f32 {
  // Flip Y: NDC Y-up → SVG/path Y-down convention
  let uv = vec2f(uv_in.x, -uv_in.y);
  let s = shapes[shape_id];

  // AABB early-out
  if (uv.x < s.bbox_min_x || uv.x > s.bbox_max_x ||
      uv.y < s.bbox_min_y || uv.y > s.bbox_max_y) {
    return 2.0;
  }

  var min_dist: f32 = 1e10;
  var winding: i32 = 0;
  let end = min(s.seg_start + s.seg_count, s.seg_start + 32u);

  for (var i = s.seg_start; i < end; i++) {
    let seg = segments[i];
    switch seg.kind {
      case 0u: {
        min_dist = min(min_dist, dist_to_line(uv, seg.p0, seg.p1));
        winding += winding_line(uv, seg.p0, seg.p1);
      }
      case 1u: {
        min_dist = min(min_dist, dist_to_quadratic(uv, seg.p0, seg.p1, seg.p2));
        // Approximate winding with chord
        winding += winding_line(uv, seg.p0, seg.p2);
      }
      case 2u: {
        min_dist = min(min_dist, dist_to_cubic(uv, seg.p0, seg.p1, seg.p2, seg.p3));
        // Approximate winding with chord
        winding += winding_line(uv, seg.p0, seg.p3);
      }
      default: {}
    }
  }

  // Map: dist=1.0 at boundary (matching circle convention)
  // Inside: dist < 1.0, Outside: dist > 1.0
  if (winding != 0) {
    return 1.0 - min_dist;  // inside: smaller dist = more inside = lower value
  } else {
    return 1.0 + min_dist;  // outside: further from edge = higher value
  }
}

struct PointOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) feat_id: u32,
  @location(2) @interpolate(flat) radius_px: f32,
  // view_w = pre-division clip-space w of the point center. All four
  // quad corners share one depth so interpolation isn't an issue, but
  // we still want the log-depth value in a varying so fs_point can write
  // frag_depth uniformly.
  @location(3) view_w: f32,
  // Backface signal for globe projections (orthographic / azimuthal /
  // stereographic). All four quad corners share one center, so this is
  // flat-interpolated via the shared value — fragments either all
  // render or all discard. +1 for flat projections (no-op).
  @location(4) @interpolate(flat) cos_c: f32,
}

struct PointFragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
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

  // Unit conversion: 0=px, 1=m, 2=km, 3=deg, 4=nm
  var radius_px: f32;
  if (size_mode == 1u) {
    radius_px = raw_radius / u.viewport.z;           // meters → pixels
  } else if (size_mode == 2u) {
    radius_px = raw_radius * 1000.0 / u.viewport.z;  // km → pixels
  } else if (size_mode == 3u) {
    radius_px = raw_radius * 111320.0 / u.viewport.z; // deg → pixels (equator approx)
  } else if (size_mode == 4u) {
    radius_px = raw_radius * 1852.0 / u.viewport.z;  // nautical miles → pixels
  } else {
    radius_px = raw_radius;                           // px: as-is
  }

  // RTC: center is pre-computed as (mercX - cameraMercX, mercY - cameraMercY)
  // stored in feat_data by CPU in f64 precision, passed as small f32 offsets.
  // For non-Mercator projections we re-project through reproject_point so the
  // point lands on the globe (or other projection) instead of the Mercator plane.
  let rtc_merc = vec2<f32>(feat_data[fid * STRIDE + 11u], feat_data[fid * STRIDE + 12u]);
  let pos = reproject_point(rtc_merc);
  let rtc_x = pos.x;
  let rtc_y = pos.y;
  let center_clip = u.mvp * vec4f(rtc_x, rtc_y, 0.0, 1.0);

  let is_flat = (u32(feat_data[fid * STRIDE + 10u]) & 8u) != 0u;  // bit 3 = flat
  radius_px = max(radius_px, 1.0);
  let expand = radius_px + 2.0;

  var out: PointOut;
  // Use the center's w for log-depth so every corner of the quad shares
  // the same depth value (point markers occupy near-zero depth range).
  let fc = u.viewport.w;
  out.view_w = center_clip.w;

  if (is_flat) {
    // FLAT: expand in world-space, then transform via MVP.
    // Anchor shift (bits 8-9): 0=center, 1=bottom, 2=top. Unlike the
    // billboard branch (which shifts in NDC / screen-space), flat quads
    // rotate with the map, so anchor applies along the world +Y axis.
    // On a north-up, no-pitch camera this coincides with screen-up, so
    // anchor-bottom still means "sprite extends upward from the ground
    // point" (pin metaphor). With bearing rotation the anchor direction
    // visually rotates with the map — consistent with the flat paradigm.
    let anchor_mode = (u32(feat_data[fid * STRIDE + 10u]) >> 8u) & 3u;
    var y_shift = 0.0;
    if (anchor_mode == 1u) { y_shift = 1.0; }        // bottom: quad +Y
    else if (anchor_mode == 2u) { y_shift = -1.0; }  // top: quad -Y
    let world_expand = expand * u.viewport.z;  // px → meters (viewport.z = mpp)
    let wo = vec2f(
      offsets[quad_id].x * world_expand,
      (offsets[quad_id].y + y_shift) * world_expand,
    );
    let flat_clip = u.mvp * vec4f(rtc_x + wo.x, rtc_y + wo.y, 0.0, 1.0);
    out.position = apply_log_depth(flat_clip, fc);
    out.uv = offsets[quad_id];
  } else {
    // BILLBOARD: expand in screen-space (NDC), perspective-corrected.
    // Anchor shift (bits 8-9): 0=center, 1=bottom, 2=top.
    // Bottom anchor lifts the quad up by one full quad extent in px so
    // its bottom edge sits on the projected ground point (pin style).
    let anchor_mode = (u32(feat_data[fid * STRIDE + 10u]) >> 8u) & 3u;
    var y_shift_px = 0.0;
    if (anchor_mode == 1u) { y_shift_px = expand; }        // bottom
    else if (anchor_mode == 2u) { y_shift_px = -expand; }  // top
    let px_to_ndc = vec2f(2.0 / u.viewport.x, 2.0 / u.viewport.y);
    let offset_px = vec2f(
      offsets[quad_id].x * expand,
      offsets[quad_id].y * expand + y_shift_px,
    );
    let offset_ndc = offset_px * px_to_ndc;
    let billboard_clip = center_clip + vec4f(offset_ndc * center_clip.w, 0.0, 0.0);
    out.position = apply_log_depth(billboard_clip, fc);
    // UV stays centered so the SDF shape renders unchanged — only the
    // on-screen placement is shifted.
    out.uv = offsets[quad_id] * expand / max(radius_px, 1.0);
  }
  out.feat_id = fid;
  out.radius_px = radius_px;
  out.cos_c = point_cos_c(rtc_merc);
  return out;
}

@fragment
fn fs_point(in: PointOut) -> PointFragmentOutput {
  // Backface cull for globe projections — same pattern as polygon
  // (renderer.ts) and line (line-renderer.ts) shaders. cos_c is +1
  // for flat projections so the discard is a no-op there.
  if (in.cos_c < 0.0) { discard; }
  let fid = in.feat_id;
  let shape_id = u32(feat_data[fid * STRIDE + 13u]);

  // Compute AA from UV (always smooth) — not from SDF dist which has AABB discontinuities
  let aa = fwidth(length(in.uv)) * 1.5;

  var dist: f32;
  if (shape_id == 0u) {
    dist = length(in.uv);  // analytical circle (fast path)
  } else {
    dist = sdf_shape(in.uv, shape_id - 1u);
  }

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
  let stroke_w_px = feat_data[fid * STRIDE + 9u];
  let flags = u32(feat_data[fid * STRIDE + 10u]);

  // Convert stroke width from px to UV space using actual rendered radius
  let stroke_w = stroke_w_px / max(in.radius_px, 1.0);

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
  var out: PointFragmentOutput;
  out.color = color;
  out.depth = compute_log_frag_depth(in.view_w, u.viewport.w);
  return out;
}
`

// ═══ Types ═══

interface PointLayer {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  featureBuffer: GPUBuffer
  featData: Float32Array
  lons: Float64Array
  lats: Float64Array
  indexCount: number
  pointCount: number
  bindGroup: GPUBindGroup
  /** Flat layers lie on the ground plane and draw without depth write so
   *  overlapping circles blend cleanly without z-fighting from coplanar
   *  fragments. Billboards keep depth write so near markers occlude far. */
  isFlat: boolean
  /** Translucent billboards skip depth write so they don't occlude opaque
   *  geometry drawn behind them in later layers (classic transparency +
   *  depth ordering). A layer is translucent when opacity, fill.a, or
   *  stroke.a (all multiplied together) drops below 1. */
  isTranslucent: boolean
  /** Zoom stops for dynamic size — present only when a layer was built
   *  with `z5:size-N z15:size-M` style utilities. Interpolated each frame
   *  against camera.zoom and written back into featData[i*STRIDE+0]. */
  zoomSizeStops: { zoom: number; value: number }[] | null
  /** Last zoom value the dynamic size was uploaded for, used to skip
   *  redundant queue.writeBuffer calls when the camera is idle. */
  lastDynZoom: number
  // Expanded buffers for 3× world copies (created on first render)
  _expandedVertBuf?: GPUBuffer
  _expandedIdxBuf?: GPUBuffer
  _expandedFeatBuf?: GPUBuffer
  _expandedBindGroup?: GPUBindGroup
  _expandedSize?: number
}

// ═══ Renderer ═══

export class PointRenderer {
  private device: GPUDevice
  private pipeline: GPURenderPipeline            // billboard: depth test + write + bias
  private pipelineTranslucent: GPURenderPipeline // billboard: depth test only, no write (transparency)
  private pipelineFlat: GPURenderPipeline        // flat: depth test only, no write (avoids coplanar z-fight)
  private bindGroupLayout: GPUBindGroupLayout
  private pipelineLayout: GPUPipelineLayout | null = null
  private format: GPUTextureFormat = 'bgra8unorm'
  // Vertex buffer layout — cached so rebuildForQuality can reuse without
  // recomputing the stride/attribute map.
  private vertexBufferLayout: GPUVertexBufferLayout | null = null
  private uniformBuffer: GPUBuffer
  private uniformData = new Float32Array(28) // mvp(16) + proj_params(4) + tile_rtc(4) + viewport(2) + pad(2)
  private layers: PointLayer[] = []
  private shapeRegistry: ShapeRegistry | null = null

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  constructor(ctx: { device: GPUDevice; format: GPUTextureFormat }) {
    this.device = ctx.device
    const { device } = ctx

    const shaderModule = device.createShaderModule({ code: POINT_SHADER, label: 'sdf-point-shader' })

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    this.format = ctx.format
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] })
    const pipelineLayout = this.pipelineLayout

    this.vertexBufferLayout = {
      arrayStride: 16, // center(2×f32) + quad_id(u32) + feat_id(f32)
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8, format: 'uint32' as GPUVertexFormat },
        { shaderLocation: 2, offset: 12, format: 'float32' as GPUVertexFormat },
      ],
    }
    const vertexBufferLayout = this.vertexBufferLayout

    // Polygon offset (depth bias) pulls point markers slightly toward the
    // camera so they never z-fight with ground polygons, line strokes, or
    // each other. Negative bias = closer in WebGPU's [0,1] depth range.
    // `depthBiasSlopeScale: -1` makes the offset proportional to surface
    // slope so the effect is roughly constant in screen space regardless
    // of pitch. Values chosen empirically — large enough to dominate any
    // realistic coplanar tie at 24-bit depth precision.
    const pointDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthBias: -10,
      depthBiasSlopeScale: -1,
      depthBiasClamp: 0,
    }

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: pointDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline',
    })

    // Translucent billboard pipeline — same as `pipeline` (depth bias, test
    // less-equal) but does NOT write depth. Translucent halos, glows, and
    // any fill/stroke with effective alpha < 1 use this so the depth buffer
    // only retains values from opaque fragments. Without this, a halo drawn
    // first writes depth across its large area and causes opaque pins of
    // other points drawn later to fail the depth test under pitch+rotation.
    const translucentDepthStencil: GPUDepthStencilState = {
      ...pointDepthStencil,
      depthWriteEnabled: false,
    }
    this.pipelineTranslucent = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: translucentDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline-translucent',
    })

    // Flat pipeline — depth read but NO write. Flat circles (e.g. coverage
    // overlays lying on the ground plane) have identical clip-space Z at
    // any overlapping fragment, so writing depth produces a coplanar tie
    // that flickers as z-fighting. Painter's order + alpha blending is the
    // correct composition for these. Depth test is kept at less-equal so
    // future opaque 3D geometry (not present today) can still occlude them.
    const flatDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthWriteEnabled: false,
    }
    this.pipelineFlat = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: ctx.format, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: flatDepthStencil,
      multisample: { count: getSampleCount() },
      label: 'sdf-point-pipeline-flat',
    })

    this.uniformBuffer = device.createBuffer({
      size: 128, // 28 floats × 4 = 112, padded to 128
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  /** Rebuild the 3 point pipelines with the current QUALITY.msaa.
   *  Points don't participate in GPU picking today (their render pass has
   *  only one color attachment), so `isPickEnabled()` is ignored here —
   *  only MSAA changes require the rebuild. Safe to call mid-session. */
  rebuildForQuality(): void {
    if (!this.pipelineLayout || !this.vertexBufferLayout) return
    const device = this.device
    const shaderModule = device.createShaderModule({ code: POINT_SHADER, label: 'sdf-point-shader-rebuilt' })
    const msaa = { count: getSampleCount() }
    const vb = this.vertexBufferLayout
    const pl = this.pipelineLayout
    const fmt = this.format
    const pointDepthStencil: GPUDepthStencilState = {
      ...DEPTH_TEST_WRITE,
      depthBias: -10, depthBiasSlopeScale: -1, depthBiasClamp: 0,
    }
    this.pipeline = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: pointDepthStencil,
      multisample: msaa,
      label: 'sdf-point-pipeline',
    })
    this.pipelineTranslucent = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { ...pointDepthStencil, depthWriteEnabled: false },
      multisample: msaa,
      label: 'sdf-point-pipeline-translucent',
    })
    this.pipelineFlat = device.createRenderPipeline({
      layout: pl,
      vertex: { module: shaderModule, entryPoint: 'vs_point', buffers: [vb] },
      fragment: { module: shaderModule, entryPoint: 'fs_point', targets: [{ format: fmt, blend: BLEND_ALPHA }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { ...DEPTH_TEST_WRITE, depthWriteEnabled: false },
      multisample: msaa,
      label: 'sdf-point-pipeline-flat',
    })
  }

  /** Create a bind group with uniform + feat_data + shape buffers */
  private makeBindGroup(featBuffer: GPUBuffer): GPUBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer
    const segBuf = this.shapeRegistry?.segmentBuffer
    // Fallback: tiny empty buffers if no registry
    const emptyBuf = this._emptyStorageBuf ??= this.device.createBuffer({
      size: 64, usage: GPUBufferUsage.STORAGE, label: 'empty-shape-buf',
    })
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: featBuffer } },
        { binding: 2, resource: { buffer: shapeBuf ?? emptyBuf } },
        { binding: 3, resource: { buffer: segBuf ?? emptyBuf } },
      ],
    })
  }
  private _emptyStorageBuf: GPUBuffer | null = null

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.vertexBuffer.destroy()
      layer.indexBuffer.destroy()
      layer.featureBuffer.destroy()
      layer._expandedVertBuf?.destroy()
      layer._expandedIdxBuf?.destroy()
      layer._expandedFeatBuf?.destroy()
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
  /** Buffers retired this frame because renderTilePoints rebuilt
   *  its tile-point geometry. Destroyed at the START of the NEXT
   *  frame so any in-flight queue.submit() that bound them via
   *  tilePointBindGroup completes first. Mirrors the
   *  retiredUniformRings pattern in vector-tile-renderer.ts:
   *  WebGPU spec keeps the GPU-side memory alive after destroy()
   *  for already-submitted work, but it's illegal to ENQUEUE new
   *  commands referencing a destroyed buffer. With multi-source
   *  layered demos (4 VTRs each calling renderTilePoints per
   *  frame), the rapid destroy+recreate inside renderTilePoints
   *  hit "Buffer used in submit while destroyed" validation
   *  errors when the prior frame's command encoder still
   *  referenced the same bind group. */
  private retiredTilePointBuffers: GPUBuffer[] = []
  private tilePointBindGroup: GPUBindGroup | null = null

  /** Drain retired-buffer queue from the previous frame. Safe by
   *  this point because the previous frame's queue.submit() has
   *  already returned (it's synchronous in JS) and the GPU keeps
   *  destroyed buffers' memory alive until that work completes.
   *  MapRenderer should call this once per frame before any
   *  renderTilePoints / renderPoints call. */
  beginFrame(): void {
    if (this.retiredTilePointBuffers.length === 0) return
    for (const b of this.retiredTilePointBuffers) b.destroy()
    this.retiredTilePointBuffers.length = 0
  }

  /** Accumulate a point from a visible tile (pre-computed RTC) */
  addTilePoint(rtcX: number, rtcY: number, featId: number): void {
    this.tilePoints.push({ rtcX, rtcY, featId })
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
    show: { fill?: string | null; stroke?: string | null; strokeWidth?: number; size?: number | null; opacity?: number },
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

    let flags = 0
    if (fill) flags |= 1
    if (stroke) flags |= 2

    // Build expanded buffers (one per world copy). Mercator wraps; other
    // projections collapse to a single world (worldCopiesFor()).
    const STRIDE = 14
    // WORLD_MERC imported from gpu-shared
    const COPIES = worldCopiesFor(projType)
    const totalN = N * COPIES.length

    const verts = new Float32Array(totalN * 4 * 4)
    const indices = new Uint32Array(totalN * 6)
    const featData = new Float32Array(totalN * STRIDE)
    const u32View = new Uint32Array(verts.buffer)

    for (let w = 0; w < COPIES.length; w++) {
      const worldOff = COPIES[w] * WORLD_MERC
      for (let i = 0; i < N; i++) {
        const pt = this.tilePoints[i]
        const gi = w * N + i

        const base = gi * 4 * 4
        for (let q = 0; q < 4; q++) {
          const off = base + q * 4
          verts[off] = 0; verts[off + 1] = 0; u32View[off + 2] = q; verts[off + 3] = gi
        }

        const iBase = gi * 6, vBase = gi * 4
        indices[iBase] = vBase; indices[iBase+1] = vBase+1; indices[iBase+2] = vBase+2
        indices[iBase+3] = vBase; indices[iBase+4] = vBase+2; indices[iBase+5] = vBase+3

        const fOff = gi * STRIDE
        featData[fOff+0] = radiusPx
        featData[fOff+1] = fill?fill[0]:0; featData[fOff+2] = fill?fill[1]:0
        featData[fOff+3] = fill?fill[2]:0; featData[fOff+4] = fill?fill[3]*opacity:0
        featData[fOff+5] = stroke?stroke[0]:0; featData[fOff+6] = stroke?stroke[1]:0
        featData[fOff+7] = stroke?stroke[2]:0; featData[fOff+8] = stroke?stroke[3]*opacity:0
        featData[fOff+9] = strokeWidth; featData[fOff+10] = flags
        featData[fOff+11] = pt.rtcX + worldOff
        featData[fOff+12] = pt.rtcY
        featData[fOff+13] = 0 // shape_id (circle default for tile points)
      }
    }

    // Defer destroy of the previous frame's buffers — see
    // retiredTilePointBuffers comment. Drained at the start of the
    // next frame via beginFrame() once the prior submit has
    // completed.
    if (this.tilePointBuffer) this.retiredTilePointBuffers.push(this.tilePointBuffer)
    if (this.tilePointIndexBuffer) this.retiredTilePointBuffers.push(this.tilePointIndexBuffer)
    if (this.tilePointFeatBuffer) this.retiredTilePointBuffers.push(this.tilePointFeatBuffer)

    this.tilePointBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'tile-point-vertices' })
    this.device.queue.writeBuffer(this.tilePointBuffer, 0, verts)
    this.tilePointIndexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'tile-point-indices' })
    this.device.queue.writeBuffer(this.tilePointIndexBuffer, 0, indices)
    this.tilePointFeatBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'tile-point-features' })
    this.device.queue.writeBuffer(this.tilePointFeatBuffer, 0, featData)

    this.tilePointBindGroup = this.makeBindGroup(this.tilePointFeatBuffer)

    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const uf = this.uniformData
    uf.set(frame.matrix, 0)
    uf[16] = projType; uf[17] = projCenterLon; uf[18] = projCenterLat; uf[19] = 0
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, camera.zoom)
    // viewport.w = log_depth_fc so fs_point can write @builtin(frag_depth)
    uf[24] = canvasWidth; uf[25] = canvasHeight; uf[26] = metersPerPixel; uf[27] = frame.logDepthFc
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Pick the translucent (no depth write) pipeline when the effective
    // alpha drops below 1 so halos/glows rendered from tile sources don't
    // occlude opaque points or layers drawn into the same depth buffer.
    // Matches the classification used in addLayer().
    const EPS = 0.999
    const fillA = fill ? fill[3] * opacity : 1
    const strokeA = stroke ? stroke[3] * opacity : 1
    const tileIsTranslucent = opacity < EPS || fillA < EPS || strokeA < EPS

    // Single draw call for all 3 world copies
    pass.setPipeline(tileIsTranslucent ? this.pipelineTranslucent : this.pipeline)
    pass.setBindGroup(0, this.tilePointBindGroup)
    pass.setVertexBuffer(0, this.tilePointBuffer)
    pass.setIndexBuffer(this.tilePointIndexBuffer, 'uint32')
    pass.drawIndexed(totalN * 6)

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
    zoomSizeStops?: { zoom: number; value: number }[] | null,
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
    const STRIDE = 14
    const featData = new Float32Array(points.length * STRIDE)
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
      // [11] and [12] = RTC x/y, written per-frame in render()
      featData[off + 13] = shapeId ?? 0
    }

    // Store original coordinates in f64 for per-frame RTC computation
    const lons = new Float64Array(points.length)
    const lats = new Float64Array(points.length)
    for (let i = 0; i < points.length; i++) {
      lons[i] = points[i].lon
      lats[i] = points[i].lat
    }

    const vertexBuffer = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'point-vertices' })
    this.device.queue.writeBuffer(vertexBuffer, 0, verts)

    const indexBuffer = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'point-indices' })
    this.device.queue.writeBuffer(indexBuffer, 0, indices)

    const featureBuffer = this.device.createBuffer({ size: Math.max(featData.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'point-features' })
    this.device.queue.writeBuffer(featureBuffer, 0, featData)

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
      zoomSizeStops: zoomSizeStops ?? null,
      lastDynZoom: Number.NaN,
    })

    console.log(`[X-GIS] SDF point layer: ${points.length} points`)
  }

  /** Re-evaluate zoom-interpolated point sizes against the current
   *  camera zoom and patch layer.featData in place. Caller invokes
   *  this once per frame before render(). No-op for layers without
   *  zoomSizeStops. render() copies from layer.featData into the
   *  per-world expanded buffer each frame, so the patched values
   *  propagate naturally — no need to touch the expanded buffer. */
  updateDynamicSizes(cameraZoom: number, interpolate: (stops: { zoom: number; value: number }[], zoom: number) => number): void {
    const STRIDE = 14
    for (const layer of this.layers) {
      const stops = layer.zoomSizeStops
      if (!stops || stops.length === 0) continue
      if (Math.abs(layer.lastDynZoom - cameraZoom) < 0.001) continue

      const size = interpolate(stops, cameraZoom)
      for (let i = 0; i < layer.pointCount; i++) {
        layer.featData[i * STRIDE + 0] = size
      }
      layer.lastDynZoom = cameraZoom
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

    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const uf = this.uniformData

    // MVP matrix
    uf.set(frame.matrix, 0)
    // proj_params: shader's reproject_point branches on projType
    uf[16] = projType
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
    // viewport: xy = size, z = meters_per_pixel, w = log_depth_fc
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, camera.zoom)
    uf[24] = canvasWidth
    uf[25] = canvasHeight
    uf[26] = metersPerPixel
    uf[27] = frame.logDepthFc

    // tile_rtc no longer needed in uniform (RTC computed per-point in CPU)
    uf[20] = 0; uf[21] = 0; uf[22] = 0; uf[23] = 0

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uf)

    // Camera center in Mercator (f64 precision)
    const camMercX = projCenterLon * DEG2RAD * R
    const camClampedLat = Math.max(-85.051129, Math.min(85.051129, projCenterLat))
    const camMercY = Math.log(Math.tan(Math.PI / 4 + camClampedLat * DEG2RAD / 2)) * R

    // WORLD_MERC imported from gpu-shared
    const STRIDE = 14
    // World-copy enumeration depends on projection — Mercator wraps,
    // others collapse to a single world. See worldCopiesFor().
    const COPIES = worldCopiesFor(projType)

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
      const expandedFeat = new Float32Array(totalPoints * STRIDE)
      const expandedVerts = new Float32Array(totalPoints * 4 * 4)
      const expandedIdx = new Uint32Array(totalPoints * 6)
      const u32Verts = new Uint32Array(expandedVerts.buffer)

      // Pre-compute each instance's view-forward depth so we can write
      // the index buffer in back-to-front order. Only translucent layers
      // actually need this (opaque depth-test handles occlusion); for
      // opaque we skip the sort and keep feature-index order.
      const depths = layer.isTranslucent ? new Float32Array(totalPoints) : null
      const order = layer.isTranslucent ? new Uint32Array(totalPoints) : null

      for (let w = 0; w < COPIES.length; w++) {
        const worldOff = COPIES[w] * WORLD_MERC
        const basePoint = w * N

        for (let i = 0; i < N; i++) {
          const lon = layer.lons[i]
          const lat = layer.lats[i]
          const mercX = lon * DEG2RAD * R
          const clampLat = Math.max(-85.051129, Math.min(85.051129, lat))
          const mercY = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R

          const dx = mercX - camMercX + worldOff
          const dy = mercY - camMercY

          // Copy style data from original
          const srcOff = i * STRIDE
          const dstOff = (basePoint + i) * STRIDE
          expandedFeat.set(layer.featData.subarray(srcOff, srcOff + 11), dstOff)
          expandedFeat[dstOff + 13] = layer.featData[srcOff + 13] // shape_id
          expandedFeat[dstOff + 11] = dx
          expandedFeat[dstOff + 12] = dy

          // Build quad vertices
          const globalIdx = basePoint + i
          const vBase = globalIdx * 4 * 4
          for (let q = 0; q < 4; q++) {
            const off = vBase + q * 4
            expandedVerts[off + 0] = 0 // placeholder (RTC in feat_data)
            expandedVerts[off + 1] = 0
            u32Verts[off + 2] = q
            expandedVerts[off + 3] = globalIdx // feat_id indexes into expanded buffer
          }

          if (depths && order) {
            depths[globalIdx] = dx * fwdX + dy * fwdY
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

      // Reuse or recreate GPU buffers sized for 3× points
      if (!layer._expandedVertBuf || layer._expandedSize !== totalPoints) {
        layer._expandedVertBuf?.destroy()
        layer._expandedIdxBuf?.destroy()
        layer._expandedFeatBuf?.destroy()
        layer._expandedVertBuf = this.device.createBuffer({ size: expandedVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'point-expanded-vertices' })
        layer._expandedIdxBuf = this.device.createBuffer({ size: expandedIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, label: 'point-expanded-indices' })
        layer._expandedFeatBuf = this.device.createBuffer({ size: Math.max(expandedFeat.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'point-expanded-features' })
        layer._expandedBindGroup = this.makeBindGroup(layer._expandedFeatBuf)
        layer._expandedSize = totalPoints
      }

      this.device.queue.writeBuffer(layer._expandedVertBuf!, 0, expandedVerts)
      this.device.queue.writeBuffer(layer._expandedIdxBuf!, 0, expandedIdx)
      this.device.queue.writeBuffer(layer._expandedFeatBuf!, 0, expandedFeat)
      return totalPoints
    }

    const drawLayer = (layer: PointLayer, pipeline: GPURenderPipeline, totalPoints: number) => {
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, layer._expandedBindGroup!)
      pass.setVertexBuffer(0, layer._expandedVertBuf!)
      pass.setIndexBuffer(layer._expandedIdxBuf!, 'uint32')
      pass.drawIndexed(totalPoints * 6)
    }

    // Upload every layer's buffers first (cheap; writes don't depend on
    // phase order), then run two draw phases.
    const totals = this.layers.map(uploadLayer)

    // Phase 1 — opaque billboards write depth so they correctly occlude
    // other opaque geometry regardless of declaration order.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (layer.isFlat || layer.isTranslucent) continue
      drawLayer(layer, this.pipeline, totals[i])
    }

    // Phase 2 — translucent billboards + flat layers blend on top without
    // writing depth. Declaration order is preserved within this phase so
    // authors still get painter's-order control for overlapping halos.
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]
      if (!layer.isFlat && !layer.isTranslucent) continue
      const pipeline = layer.isFlat ? this.pipelineFlat : this.pipelineTranslucent
      drawLayer(layer, pipeline, totals[i])
    }
  }
}
