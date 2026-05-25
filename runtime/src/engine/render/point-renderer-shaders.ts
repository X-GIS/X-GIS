// ═══ SDF Point Renderer — WGSL ═══
// Extracted verbatim from point-renderer.ts. Byte-identical string move.

import { WGSL_LOG_DEPTH_FNS } from '../shaders/log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from '../shaders/projection'

// ═══ WGSL Shader ═══

export const POINT_SHADER = /* wgsl */ `
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
// Recover absolute (lon, lat) in degrees from a point's camera-relative
// Mercator-meter offset (rtc_merc = absMerc - cameraMerc). Add camera
// Mercator back, then inverse-Mercator. Shared by the four point helpers
// below (was inlined 4×).
fn point_abs_lonlat(rtc_merc: vec2<f32>) -> vec2<f32> {
  let cam_lat = clamp(u.proj_params.z, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  let cam_merc_x = u.proj_params.y * DEG2RAD * EARTH_R;
  let cam_merc_y = log(tan(PI / 4.0 + cam_lat * DEG2RAD / 2.0)) * EARTH_R;
  let abs_lon = (rtc_merc.x + cam_merc_x) / (DEG2RAD * EARTH_R);
  let lat_rad = inv_merc_lat_rad(rtc_merc.y + cam_merc_y);
  let abs_lat = lat_rad / DEG2RAD;
  return vec2<f32>(abs_lon, abs_lat);
}

fn reproject_point(rtc_merc: vec2<f32>) -> vec2<f32> {
  if (u.proj_params.x < 0.5) { return rtc_merc; }
  let ll = point_abs_lonlat(rtc_merc);
  let proj_xy = project(ll.x, ll.y, u.proj_params);
  let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
  return proj_xy - center_xy;
}

// True 3D globe (projType 7): same lon/lat recovery as reproject_point,
// but the anchor is a point ON THE SPHERE relative to the focus. The
// BILLBOARD branch only needs a correct projected anchor (its quad
// corners are screen-space offsets), so this is all globe markers /
// labels need to sit on the 3D earth.
fn reproject_point_globe(rtc_merc: vec2<f32>) -> vec3<f32> {
  let ll = point_abs_lonlat(rtc_merc);
  return proj_globe(ll.x, ll.y) - proj_globe(u.proj_params.y, u.proj_params.z);
}

// Backface signal at a point's center. Same lon/lat reconstruction as
// reproject_point's non-Mercator branch, dispatched through
// needs_backface_cull. Cheap for flat projections — that helper
// returns +1 immediately when proj_params.x < 2.5.
fn point_cos_c(rtc_merc: vec2<f32>) -> f32 {
  let ll = point_abs_lonlat(rtc_merc);
  return needs_backface_cull(ll.x, ll.y, u.proj_params);
}

// Rim alpha at a point's center. Mirror of point_cos_c but returns
// the continuous-alpha smoothstep instead of a binary cull signal.
// Flat-interpolated like cos_c — all four quad corners share one
// rim value so fragments either all fade together or all render
// at full alpha (no per-corner artefacts on round points).
fn point_rim_alpha(rtc_merc: vec2<f32>) -> f32 {
  let ll = point_abs_lonlat(rtc_merc);
  return rim_alpha(ll.x, ll.y, u.proj_params);
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
  // Rim fade alpha at point center — flat-interpolated like cos_c.
  // Multiplied into fragment alpha so sphere-rim points fade
  // smoothly across [boundary, boundary + 0.02] cos_c on globe /
  // azimuthal / stereographic. 1.0 on flat / cylindrical (no-op).
  @location(5) @interpolate(flat) rim_a: f32,
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
  // Globe (projType 7): anchor on the sphere via the orbit MVP; the
  // billboard branch below offsets in screen-space around this, so
  // markers/labels sit on the 3D earth. (Flat-quad points on the
  // sphere are a later refinement — they reuse this anchor.)
  let center_clip = select(
    u.mvp * vec4f(rtc_x, rtc_y, 0.0, 1.0),
    u.mvp * vec4f(reproject_point_globe(rtc_merc), 1.0),
    u.proj_params.x > 6.5,
  );

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
  out.rim_a = point_rim_alpha(rtc_merc);
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

  // Apply rim alpha fade before the alpha-cutoff discard so points
  // sitting at the sphere visibility boundary fade smoothly rather
  // than popping. Flat / cylindrical projections receive rim_a=1.0
  // so this is a no-op there.
  color.a = color.a * in.rim_a;
  if (color.a < 0.005) { discard; }
  var out: PointFragmentOutput;
  out.color = color;
  out.depth = compute_log_frag_depth(in.view_w, u.viewport.w);
  return out;
}
`
