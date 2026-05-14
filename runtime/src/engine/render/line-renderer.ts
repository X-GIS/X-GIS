// ═══ SDF Line Renderer ═══
// Renders line features and polygon outlines as resolution-independent quads
// using signed-distance-field math in the fragment shader.
//
// Integration:
// - Group 0: VTR's tile uniform (MVP, tile_rtc, etc.) — reused from fill pipeline
// - Group 1: Line layer uniform + segment storage buffer
//
// Phase 1: variable pixel width, butt cap, bevel join (implicit).
// Later phases add cap/join styles, dash arrays, pattern stacks.
//
// ── Self-overlap behaviour (read this before reporting "weird joins") ──
//
// 1. Translucent self-intersection: when a single stroke crosses itself, the
//    crossing is handled by the offscreen + MAX-blend pipeline (see
//    `pipelineMax`, `beginTranslucentPass`, `composite`). Within-layer
//    overlap reduces to a single max-coverage value per pixel; cross-layer
//    blending then applies the per-layer opacity once. Result: no
//    double-darkening at self-intersections or corner overlap.
//
// 2. Dense vertices (many vertices within stroke-width pixels of each
//    other): segment quads overlap heavily and miter joins compute extreme
//    bisectors. The vertex shader's miter-limit clamp falls back to a bevel
//    offset when the ratio exceeds `layer.miter_limit`, and the fragment
//    shader guards `seg_len < 1e-6` against zero-length segments. This is
//    visually correct but pays heavy overdraw — push aggressive
//    Douglas-Peucker simplification at the tiler stage (`simplifyLine` in
//    `vector-tiler.ts`) rather than trying to fix it in the runtime.
//
// 3. Dash / pattern arc continuity: `arc_pos = arc_start + t_along` is
//    computed per fragment using each segment's stored `arc_start`
//    (precomputed in the tiler via `augmentLineWithArc` for stride-4 line
//    features). Across joins, `arc_start[seg_n+1] = arc_start[seg_n] +
//    segLen[seg_n]`, so dash and pattern phase advance continuously
//    regardless of vertex density. Caveat: arc length is measured along
//    the ORIGINAL geometry, not the offset stroke's parallel curve. For
//    typical small offsets the difference is sub-pixel; computing exact
//    parallel arc length would require per-segment numerical integration
//    and is deferred.

import { isPickEnabled, getSampleCount, type GPUContext } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { asyncWriteBuffer, type StagingBufferPool } from '../gpu/staging-buffer-pool'
import { BLEND_ALPHA, BLEND_ALPHA_PREMULT, BLEND_MAX, DEPTH_READ_ONLY } from '../gpu/gpu-shared'
import {
  WGSL_DIST_TO_SEGMENT,
  WGSL_DIST_TO_QUADRATIC,
  WGSL_DIST_TO_CUBIC,
  WGSL_WINDING_LINE,
  WGSL_SHAPE_STRUCTS,
} from '../shaders/sdf'
import { WGSL_LOG_DEPTH_FNS } from '../shaders/log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from '../shaders/projection'
import type { ShapeRegistry } from '../text/sdf-shape'
import {
  LINE_UNIFORM_SIZE, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
  LINE_CAP_BUTT, LINE_CAP_ROUND, LINE_CAP_SQUARE, LINE_CAP_ARROW,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
  LINE_FLAG_HAS_PATTERN, LINE_FLAG_HAS_OFFSET,
  PATTERN_UNIT_M, PATTERN_UNIT_PX, PATTERN_UNIT_KM, PATTERN_UNIT_NM,
  PATTERN_ANCHOR_REPEAT, PATTERN_ANCHOR_START, PATTERN_ANCHOR_END, PATTERN_ANCHOR_CENTER,
  checkPatternParams, packLineLayerUniform,
  type DashConfig, type PatternSlot,
} from './line-pattern'
// Re-export so test files (line-renderer.test, line-pattern-guards.test, etc.)
// keep importing the public surface from the renderer module.
export {
  LINE_UNIFORM_SIZE, PATTERN_SLOT_COUNT, PATTERN_SLOT_F32,
  LINE_CAP_BUTT, LINE_CAP_ROUND, LINE_CAP_SQUARE, LINE_CAP_ARROW,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
  LINE_FLAG_HAS_PATTERN, LINE_FLAG_HAS_OFFSET,
  PATTERN_UNIT_M, PATTERN_UNIT_PX, PATTERN_UNIT_KM, PATTERN_UNIT_NM,
  PATTERN_ANCHOR_REPEAT, PATTERN_ANCHOR_START, PATTERN_ANCHOR_END, PATTERN_ANCHOR_CENTER,
  checkPatternParams, packLineLayerUniform,
  type DashConfig, type PatternSlot,
}


// ═══ Segment Buffer Layout ═══
// 40 bytes per segment. Phase 1: p0, p1 only. Later phases add prev/next tangents, arc_start, line_length.

// Stride is 12 f32 = 48 bytes. Fields:
//   [0-1]  p0 (vec2)
//   [2-3]  p1 (vec2)
//   [4-5]  prev_tangent (vec2)  — direction of prev seg arriving at p0 (zero = cap)
//   [6-7]  next_tangent (vec2)  — direction of next seg leaving p1 (zero = cap)
//   [8]    arc_start   (f32)
// DSFUN segment layout (stride 16 f32 = 64 bytes):
//   [0-1]   p0_h (vec2<f32>)        — tile-local Mercator meters, high pair
//   [2-3]   p1_h (vec2<f32>)
//   [4-5]   p0_l (vec2<f32>)        — low pair
//   [6-7]   p1_l (vec2<f32>)
//   [8-9]   prev_tangent (vec2<f32>)
//   [10-11] next_tangent (vec2<f32>)
//   [12]    arc_start (f32)
//   [13]    line_length (f32)
//   [14]    pad_ratio_p0 (f32)
//   [15]    pad_ratio_p1 (f32)
//
// The shader subtracts (p0_h - cam_h) + (p0_l - cam_l) to cancel tile-origin
// magnitude and recover camera-relative meters with f64-equivalent precision.
// Tangents stay single-f32 — they're unit vectors in a tile-local frame and
// don't suffer from cancellation.
import { LINE_SEGMENT_STRIDE_F32, LINE_SEGMENT_STRIDE_BYTES, buildLineSegments } from '../../core/line-segment-build'
export { LINE_SEGMENT_STRIDE_F32, LINE_SEGMENT_STRIDE_BYTES, buildLineSegments }

// ═══ WGSL Shader ═══
//
// Coordinate convention (matches VTR fill shader):
//   segment.p0/p1 are tile-local, where:
//     - x = lon_local * DEG2RAD * EARTH_R  (meters from tile west edge)
//     - y = merc_lat_local * EARTH_R       (meters from tile south edge in Mercator)
//   tile.tile_rtc.xy adds the offset from tile SW corner to camera center.
//   So world position (RTC) = p + tile.tile_rtc.xy.
//
// Width expansion happens in world space using a layer-level `mpp` value
// (meters per pixel at camera center). This keeps the shader simple and
// avoids per-fragment viewport-size math.

// ── Composite shader: fullscreen triangle sampling the offscreen RT ──
const COMPOSITE_SHADER = /* wgsl */ `
struct CompUniform { opacity: f32, _pad: vec3<f32> }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> cu: CompUniform;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> VsOut {
  // Single triangle covering the viewport: (-1,-1) (3,-1) (-1,3)
  var p = vec2<f32>(-1.0, -1.0);
  var uv = vec2<f32>(0.0, 1.0);
  if (vi == 1u) { p = vec2<f32>( 3.0, -1.0); uv = vec2<f32>(2.0, 1.0); }
  if (vi == 2u) { p = vec2<f32>(-1.0,  3.0); uv = vec2<f32>(0.0, -1.0); }
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_full(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, in.uv);
  // The MAX-blend offscreen stores NON-premultiplied (rgb, a_aa).
  // BLEND_ALPHA_PREMULT below expects PREMULTIPLIED source — premultiply
  // here. The previous output (c.rgb * cu.opacity) left rgb full-strength
  // at anti-aliased edges (a_aa < 1) and doubled the line brightness vs
  // MapLibre's color * alpha * opacity. Visible as a brightness jump
  // between zoom 5.99 (translucent path) and 6.01 (opaque path), where
  // demotiles countries-boundary opacity stops cross 1.0.
  return vec4<f32>(c.rgb * c.a * cu.opacity, c.a * cu.opacity);
}
`

// Exported for the marker-drift invariant test (renderer-shader-
// markers.test.ts). The PICK_FIELD / PICK_WRITE regex replacements
// silently no-op when the token is absent — a stale shader-source
// edit could drop a token unnoticed and the pick attachment would
// stop receiving line writes. Mirror of POLYGON_SHADER_SOURCE
// export in renderer.ts.
export const LINE_SHADER_SOURCE: string = /* wgsl */ `
${WGSL_PROJECTION_CONSTS}
struct TileUniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  proj_params: vec4<f32>,
  // DSFUN camera offset in tile-local Mercator meters, split high/low.
  cam_h: vec2<f32>,
  cam_l: vec2<f32>,
  tile_origin_merc: vec2<f32>,
  opacity: f32,
  // Log-depth factor: 1.0 / log2(cam_far + 1.0). Reuses the old DSFUN
  // _pad0 slot so the 144-byte uniform layout is unchanged.
  log_depth_fc: f32,
  // Slots 36-39 mirror the polygon Uniforms tail (pick_id /
  // layer_depth_offset / tile_extent_m / extrude_height_m). The line
  // shader only reads outline_z_lift_m — the others are padding so
  // the WGSL struct lines up with the shared 160-byte uniform block.
  // outline_z_lift_m aliases polygon's extrude_height_m so a single
  // CPU-side write at slot 39 lifts BOTH the polygon roof faces AND
  // the polygon outline strokes onto the building roof, fixing the
  // "outline draws at ground level only" symptom that user reported
  // for extruded layers.
  _pad_pick: u32,
  _pad_layer_offset: f32,
  _pad_tile_extent: f32,
  outline_z_lift_m: f32,
  // Per-tile clip mask in absolute Mercator meters (west, south,
  // east, north). Matches the polygon Uniforms.clip_bounds field
  // at f32 offset 40-43, populated by
  // vector-tile-renderer.ts:3544-3547 for every tile (sentinel
  // -1e30 for primary direct-archive tiles, real bounds for parent-
  // ancestor fallback). Fragment shader discards if abs Mercator
  // position falls outside the rect — same pattern as fs_fill
  // (renderer.ts:330-339). Without this, fallback parent SDF
  // outlines bleed across child tile boundaries and produce
  // boundary-aligned vertical / horizontal strokes (user-reported
  // countries_boundary lines on demotiles Russia z=4.68 / 5.19).
  clip_bounds: vec4<f32>,
}
@group(0) @binding(0) var<uniform> tile: TileUniforms;

${WGSL_LOG_DEPTH_FNS}
${WGSL_PROJECTION_FNS}

// Reconstruct camera-relative position in the CURRENT projection's coordinate
// frame from a DSFUN Mercator-meter pair. This is the line-shader analogue of
// the polygon shader's vs_main reproject block.
//
// Mercator (proj_params.x < 0.5): take the DSFUN subtraction
//   (p_h - cam_h) + (p_l - cam_l)
// which preserves the small camera-relative delta at f64-equivalent precision
// — needed for sub-mm stability at high zoom.
//
// Non-Mercator: reconstruct absolute lon/lat from Mercator meters, project
// through the dispatch, and subtract the projected camera center. Precision
// is f32-limited but adequate at the low/global zooms where non-Mercator
// projections are used.
//
// The line shader's geometry math (segment direction, miter pad, etc.) is
// then computed in this projected-meter frame, which means polylines drawn
// on a globe (orthographic / azimuthal / stereographic) curve along the
// surface instead of leaking out as a Mercator world map.
// Backface signal at a DSFUN endpoint. Reconstructs absolute lon/lat
// (same path as finalize_corner's non-Mercator branch) and dispatches
// needs_backface_cull. Cheap for flat projections — that helper
// returns +1 immediately when proj_params.x < 2.5.
fn endpoint_cos_c(p_h: vec2<f32>, p_l: vec2<f32>) -> f32 {
  let abs_merc_x = (p_h.x + p_l.x) + tile.tile_origin_merc.x;
  let abs_merc_y = (p_h.y + p_l.y) + tile.tile_origin_merc.y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  return needs_backface_cull(abs_lon, abs_lat, tile.proj_params);
}

// Stroke geometry frame helpers.
//
// vs_line + compute_line_color do all stroke math (segment direction,
// perpendicular offset, miter/join padding, pattern extents) in a
// "geometry frame" that depends on the projection:
//
//   * Mercator (proj_params.x < 0.5): camera-relative Mercator
//     meters, computed via DSFUN cancellation for sub-mm precision
//     at high zoom. This frame IS the projected XY space — Mercator
//     projection is the identity on Mercator coords — so we feed
//     the corner straight into MVP.
//
//   * Non-Mercator (orthographic / azimuthal / stereographic /
//     equirect / natural earth): TILE-LOCAL Mercator. Geometry is
//     built in the SOURCE coord space where the data lives; each
//     corner is projected independently via project() before the
//     MVP transform. This is the architectural fix for the globe-
//     stroke "fan splay" (2026-05-05): previously we projected the
//     segment endpoints first and expanded perpendicular in the
//     ortho XY plane, which produced quads that flew off into 2D
//     space instead of wrapping the sphere. By moving the perp
//     expansion to source Mercator and projecting per-corner,
//     thick strokes follow the sphere surface like an RTT-style
//     tile renderer would (and like the polygon fill already does).
//
// line_endpoint reads a DSFUN-packed segment endpoint into the
// frame. finalize_corner maps a finished corner into camera-relative
// projected XY ready for MVP.

fn line_endpoint(p_h: vec2<f32>, p_l: vec2<f32>) -> vec2<f32> {
  if (tile.proj_params.x < 0.5) {
    return (p_h - tile.cam_h) + (p_l - tile.cam_l); // DSFUN camera-relative
  }
  return p_h + p_l; // tile-local Mercator
}

fn finalize_corner(corner: vec2<f32>) -> vec2<f32> {
  if (tile.proj_params.x < 0.5) {
    return corner; // already camera-relative projected XY (= Mercator)
  }
  let abs_merc = corner + tile.tile_origin_merc;
  let abs_lon = abs_merc.x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc.y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  let proj_xy = project(abs_lon, abs_lat, tile.proj_params);
  let center_xy = project(tile.proj_params.y, tile.proj_params.z, tile.proj_params);
  return proj_xy - center_xy;
}

struct PatternSlot {
  id: u32,
  flags: u32,
  spacing: f32,
  size: f32,
  offset: f32,
  start_offset: f32,
  _pad0: f32,
  _pad1: f32,
}

struct LineLayer {
  color: vec4<f32>,
  width_px: f32,
  aa_width_px: f32,
  mpp: f32,            // meters per pixel at camera center
  miter_limit: f32,
  // flags: cap(0-1) | join(2-3) | dash_enable(4)
  flags: u32,
  dash_count: u32,
  dash_cycle_m: f32,
  dash_offset_m: f32,
  dash_array: array<vec4<f32>, 2>,  // 8 floats, packed
  patterns: array<PatternSlot, 3>,
  offset_m: f32,        // lateral parallel offset (+left of travel)
  viewport_height: f32, // screen height in pixels — screen-space width clamping
  _pad_b: f32,
  _pad_c: f32,
}
@group(1) @binding(0) var<uniform> layer: LineLayer;

const CAP_BUTT:   u32 = 0u;
const CAP_ROUND:  u32 = 1u;
const CAP_SQUARE: u32 = 2u;
const CAP_ARROW:  u32 = 3u;
const JOIN_MITER: u32 = 0u;
const JOIN_ROUND: u32 = 1u;
const JOIN_BEVEL: u32 = 2u;

// Feature-present flag bits (mirror LINE_FLAG_* in TS). Fragment shader
// gates pattern-stack and offset-only math on these so simple strokes
// (no pattern / no offset — the common case) skip hundreds of ops per
// fragment on mobile.
const LINE_FLAG_HAS_PATTERN: u32 = 64u;  // 1 << 6
const LINE_FLAG_HAS_OFFSET:  u32 = 128u; // 1 << 7

const PAT_UNIT_M:  u32 = 0u;
const PAT_UNIT_PX: u32 = 1u;
const PAT_UNIT_KM: u32 = 2u;
const PAT_UNIT_NM: u32 = 3u;
const PAT_ANCHOR_REPEAT: u32 = 0u;
const PAT_ANCHOR_START:  u32 = 1u;
const PAT_ANCHOR_END:    u32 = 2u;
const PAT_ANCHOR_CENTER: u32 = 3u;

struct LineSegment {
  // DSFUN endpoint pairs in tile-local Mercator meters. The shader
  // subtracts (p0_h - cam_h) + (p0_l - cam_l) (and similarly for p1)
  // to reach camera-relative meters at f64-equivalent precision.
  p0_h: vec2<f32>,
  p1_h: vec2<f32>,
  p0_l: vec2<f32>,
  p1_l: vec2<f32>,
  prev_tangent: vec2<f32>,
  next_tangent: vec2<f32>,
  arc_start: f32,
  line_length: f32,
  // Per-endpoint quad pad ratios (multiples of half_w). Precomputed on CPU
  // using the current layer's miter limit so that straight / gentle joins
  // shrink from 4×half_w to just what miter geometry needs.
  pad_ratio_p0: f32,
  pad_ratio_p1: f32,
  // Per-segment 3D extrude height in metres. Set at line-segment build
  // time from the slice's heights map (looked up by featId) so polygon
  // outlines on extruded layers ride the per-feature roof; 0 = stay on
  // the ground (default for non-extruded layers). Slots 17-19 are WGSL
  // alignment padding — naturally promoted to the next 16-byte boundary.
  z_lift_m: f32,
  // Per-segment stroke width override (pixels). When non-zero, the
  // line vertex / fragment math substitutes this for layer.width_px
  // — lets the compiler's mergeLayers pass fold same-source-layer
  // groups (e.g. roads_minor / primary / highway) whose only stroke
  // difference is the width into ONE compound draw with per-feature
  // dispatch instead of N separate draws. 0 = "use the layer
  // uniform" (legacy / unmerged layers).
  width_px_override: f32,
  // Per-segment stroke colour override (RGBA8 packed). Worker writes
  // a u32 bit pattern into the underlying ArrayBuffer at this slot;
  // the shader reads it as f32 and uses bitcast<u32> + unpack4x8unorm
  // to recover the colour. Alpha = 0 → fall through to layer.color.
  // Companion to width_px_override; lets the merge pass fold groups
  // whose stroke colours also differ.
  color_packed: f32,
  _pad19: f32,
}
@group(1) @binding(1) var<storage, read> segments: array<LineSegment>;

${WGSL_SHAPE_STRUCTS}
@group(1) @binding(2) var<storage, read> shapes: array<ShapeDesc>;
@group(1) @binding(3) var<storage, read> shape_segments: array<ShapeSegment>;

${WGSL_DIST_TO_SEGMENT}
${WGSL_DIST_TO_QUADRATIC}
${WGSL_DIST_TO_CUBIC}
${WGSL_WINDING_LINE}

// Inlined SDF shape sampler — uses shape_segments (our binding 3) instead
// of the shared WGSL_SDF_SHAPE snippet's "segments" name (which would
// collide with the line segment storage buffer on binding 1).
fn sdf_shape(uv_in: vec2f, shape_id: u32) -> f32 {
  let uv = vec2f(uv_in.x, -uv_in.y);
  let s = shapes[shape_id];
  if (uv.x < s.bbox_min_x || uv.x > s.bbox_max_x ||
      uv.y < s.bbox_min_y || uv.y > s.bbox_max_y) {
    return 2.0;
  }
  var min_dist: f32 = 1e10;
  var winding: i32 = 0;
  let end = min(s.seg_start + s.seg_count, s.seg_start + 32u);
  for (var i = s.seg_start; i < end; i = i + 1u) {
    let seg = shape_segments[i];
    switch seg.kind {
      case 0u: {
        min_dist = min(min_dist, dist_to_segment(uv, seg.p0, seg.p1));
        winding = winding + winding_line(uv, seg.p0, seg.p1);
      }
      case 1u: {
        min_dist = min(min_dist, dist_to_quadratic(uv, seg.p0, seg.p1, seg.p2));
        winding = winding + winding_line(uv, seg.p0, seg.p2);
      }
      case 2u: {
        min_dist = min(min_dist, dist_to_cubic(uv, seg.p0, seg.p1, seg.p2, seg.p3));
        winding = winding + winding_line(uv, seg.p0, seg.p3);
      }
      default: {}
    }
  }
  if (winding != 0) { return 1.0 - min_dist; }
  return 1.0 + min_dist;
}

fn pattern_unit_to_m(v: f32, unit: u32, mpp: f32) -> f32 {
  if (unit == PAT_UNIT_M)  { return v; }
  if (unit == PAT_UNIT_PX) { return v * mpp; }
  if (unit == PAT_UNIT_KM) { return v * 1000.0; }
  return v * 1852.0; // nautical mile
}

struct LineOut {
  @builtin(position) position: vec4<f32>,
  @location(0) world_local: vec2<f32>,
  @location(1) @interpolate(flat) seg_id: u32,
  // view_w = pre-division clip-space w. Fragment recomputes log-depth
  // per pixel so long line segments don't drift in view-space.
  @location(2) view_w: f32,
  // Backface signal for globe projections (orthographic, azimuthal,
  // stereographic). needs_backface_cull returns positive on the
  // visible hemisphere and negative behind the camera. Fragment
  // shader discards on negative; for flat projections the helper
  // returns +1 unconditionally so this is a no-op there. Mirrors the
  // polygon shader's pattern (renderer.ts: VertexOutput.cos_c).
  @location(3) cos_c: f32,
}

struct LineFragmentOutput {
  @location(0) color: vec4<f32>,
  __PICK_FIELD__
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs_line(
  @builtin(instance_index) seg_id: u32,
  @builtin(vertex_index) vi: u32,
) -> LineOut {
  let seg = segments[seg_id];
  // Endpoints in the stroke geometry frame — see line_endpoint and
  // finalize_corner above. Mercator: camera-relative DSFUN. Non-
  // Mercator: tile-local source Mercator (corner gets projected
  // independently below). All stroke math (dir, nrm, perpendicular
  // offset, joins, patterns, arrow caps) operates in this frame so
  // that on globes the perp expansion is in source space, not in
  // ortho's flat 2D plane.
  let p0 = line_endpoint(seg.p0_h, seg.p0_l);
  let p1 = line_endpoint(seg.p1_h, seg.p1_l);

  // Segment direction in the geometry frame.
  let seg_vec = p1 - p0;
  let seg_len = length(seg_vec);
  var dir: vec2<f32>;
  if (seg_len < 1e-6) {
    dir = vec2<f32>(1.0, 0.0);
  } else {
    dir = seg_vec / seg_len;
  }
  let nrm = vec2<f32>(-dir.y, dir.x);

  // Width in world meters (at camera center): width_px * mpp.
  // seg.width_px_override is non-zero only on compound layers
  // produced by the compiler mergeLayers pass (per-feature width
  // dispatch); legacy / unmerged layers leave it at 0 and fall
  // through to the layer-uniform width_px.
  let effective_width_px = select(layer.width_px, seg.width_px_override, seg.width_px_override > 0.0);
  let half_w_m = (effective_width_px * 0.5 + layer.aa_width_px) * layer.mpp;

  // Per-endpoint pad precomputed on CPU. A straight joint gets 1×half_w (just
  // AA margin), a 90° miter gets ~1.41×half_w, and sharp joints that exceed
  // the miter limit also fall back to 1×half_w (bevel). This avoids paying
  // worst-case 4×half_w overdraw per segment.
  var pad_p0_m = seg.pad_ratio_p0 * half_w_m;
  var pad_p1_m = seg.pad_ratio_p1 * half_w_m;

  // Pattern extent: if any slot is active, expand both along and across so
  // that pattern instances near segment edges aren't clipped by the quad.
  // Gated on LINE_FLAG_HAS_PATTERN so plain strokes skip the scan entirely.
  var pat_extent_m = 0.0;
  if ((layer.flags & LINE_FLAG_HAS_PATTERN) != 0u) {
    for (var pk = 0u; pk < 3u; pk = pk + 1u) {
      let pat = layer.patterns[pk];
      if (pat.id == 0u) { continue; }
      let sz_unit = (pat.flags >> 2u) & 3u;
      let off_unit = (pat.flags >> 4u) & 3u;
      let size_m = pattern_unit_to_m(pat.size, sz_unit, layer.mpp);
      let off_m = abs(pattern_unit_to_m(pat.offset, off_unit, layer.mpp));
      pat_extent_m = max(pat_extent_m, size_m * 0.5 + off_m);
    }
  }
  // Arrow cap extends 4×half_w past each endpoint.
  let cap_type_vs = layer.flags & 7u;
  let arrow_len = half_w_m * 4.0;
  var across_m = max(half_w_m, pat_extent_m);
  pad_p0_m = max(pad_p0_m, pat_extent_m);
  pad_p1_m = max(pad_p1_m, pat_extent_m);
  // Arrow caps only apply where there is no neighbor (prev/next_tangent zero).
  // Guard with length(seg.prev_tangent) checks so interior joins don't pay
  // the arrow cost.
  if (cap_type_vs == CAP_ARROW) {
    if (length(seg.prev_tangent) < 0.001) { pad_p0_m = max(pad_p0_m, arrow_len); }
    if (length(seg.next_tangent) < 0.001) { pad_p1_m = max(pad_p1_m, arrow_len); }
  }

  // 6-vert quad → 4 distinct corners: (start,-), (end,-), (end,+), (start,+).
  // At each corner we compute an explicit MITER offset from prev/next tangent
  // (or fall back to a perpendicular cap offset at chain termini). Adjacent
  // segments sharing an endpoint compute the identical offset, so their
  // outer vertices coincide — the rasterized quad union is the proper join
  // shape with no gap and no duplicated triangle.
  var along: f32 = 0.0;
  var across: f32 = 0.0;
  switch vi {
    case 0u: { along = -1.0; across = -1.0; }
    case 1u: { along =  1.0; across = -1.0; }
    case 2u: { along =  1.0; across =  1.0; }
    case 3u: { along = -1.0; across = -1.0; }
    case 4u: { along =  1.0; across =  1.0; }
    case 5u: { along = -1.0; across =  1.0; }
    default: {}
  }

  let is_start = along < 0.0;
  let base = select(p1, p0, is_start);
  let perp_cur = nrm * across; // outward perpendicular of current seg on this side

  // Neighbor tangents + has_prev/has_next flags
  let has_prev = length(seg.prev_tangent) > 0.001;
  let has_next = length(seg.next_tangent) > 0.001;
  let neighbor_tangent = select(seg.next_tangent, seg.prev_tangent, is_start);
  let has_neighbor = select(has_next, has_prev, is_start);

  // Join type (shared with fragment shader)
  let join_type_vs = (layer.flags >> 3u) & 3u;

  // Pattern scaling: quad needs to flare out proportionally when patterns
  // extend past half_w so stamps near the stroke edge aren't clipped.
  let across_scale = max(1.0, across_m / max(half_w_m, 1e-6));

  // Lateral parallel offset (stroke-offset-N): adds a signed shift along
  // the perpendicular. On the +left side (across=+1) the effective stroke
  // half-width grows by offset_m; on the -right side it shrinks. Applied
  // via the miter scalar so adjacent segments still share corner vertices.
  let half_w_side = half_w_m + layer.offset_m * across;

  // Simple perpendicular rectangle with half_w dir-padding at each end.
  //
  // Previously this computed a miter-extended vertex using the neighbor
  // tangent. That approach SELF-INTERSECTS for segments shorter than half_w
  // (common in low-resolution coastline data at low zoom), producing a
  // bow-tie quad whose two rasterization triangles overlap and shade
  // every pixel in the overlap region TWICE. With translucent strokes
  // this manifested as bright beads at every sharp corner.
  //
  // The simple rectangle is convex by construction (strictly no bow-tie),
  // overlaps between adjacent segments are handled by the fs_line
  // bisector half-plane clip, and the corner wedge is filled by the
  // round-join circle SDF (radius half_w) in fs_line. Sharp miter tips
  // are not supported by this geometry — miter tips are rendered by the
  // fragment shader's SDF intersection of both adjacent strips.
  var offset = perp_cur * half_w_side * across_scale;
  if (has_neighbor) {
    // Joined endpoint: pad along dir so there is geometry for the
    // fragment shader to shade the join on.
    //   - MITER: the miter tip projects |tan(theta/2)| x half_w along dir,
    //     so the quad must extend by pad_ratio x half_w_aa (= endpoint_pad).
    //   - ROUND: the join circle of radius half_w_aa stays within half_w_aa
    //     of the endpoint in every direction — pad_ratio overshoots and
    //     produces a visible alpha-blend halo at sharp corners when two
    //     layers stack on the same polyline.
    //   - BEVEL: the bevel edge stays within half_w of the endpoint — same
    //     bound as ROUND.
    // half_w_side alone is INSUFFICIENT when it collapses to <= 0
    // (|offset_m| >= half_w_m + aa): on the inner across side the quad
    // then pulls INWARD past the endpoint instead of outward, leaving the
    // round-join circle uncovered and producing a visible V-notch at the
    // join. Clamping up to join_pad fixes that.
    // For offset strokes the miter tip slides along the segment direction
    // by pad_ratio * offset_m on top of the standard pad_ratio * half_w.
    // Budget that into the MITER endpoint pad using abs(offset_m) so both
    // inset and outset are covered regardless of turn direction; the
    // fragment shader's offset-aware bisector clip then discards the
    // extra coverage past the true miter tip. Without this, the quad
    // truncates the shifted miter and the join renders shorter than
    // the geometric endpoint of the offset stroke.
    //
    // pad_p0_m / pad_p1_m already carry the base miter pad plus any
    // pattern-extent clamping done earlier (see pat_extent_m line ~934) —
    // max against those so offset layers that also use patterns don't
    // lose their pattern margin.
    let pad_ratio = select(seg.pad_ratio_p1, seg.pad_ratio_p0, is_start);
    let base_pad = select(pad_p1_m, pad_p0_m, is_start);
    let offset_extent_m = half_w_m + abs(layer.offset_m);
    let endpoint_pad = max(base_pad, pad_ratio * offset_extent_m);
    // ROUND / BEVEL: the offset miter vertex (p0_join_center /
    // p1_join_center) sits abs(offset_m) * pad_ratio past the
    // centerline endpoint along the -dir direction, and the round-join
    // circle drawn around it has radius half_w_m (the bevel-edge
    // clip stays within the same radius). Extend the quad by the sum
    // so the rasteriser visits those fragments — previously the quad
    // capped at half_w_m from the CENTERLINE endpoint and cut off
    // the far half of the shifted circle. Fixture-stroke-outset made
    // this loud: an isolated ring appeared where the body should have
    // flowed into the corner, with gaps on either side.
    // offset_m = 0 collapses to half_w_m, preserving the stroke-
    // center pad exactly.
    var join_pad = half_w_m + abs(layer.offset_m) * pad_ratio;
    if (join_type_vs == JOIN_MITER) { join_pad = endpoint_pad; }
    // Add a half-pixel safety margin to absorb float-precision slippage
    // between the vertex-shader quad size and the fragment-shader circle
    // SDF edge — at tight tie-breaker values (2×half_w outset at 90°)
    // the two equal exactly and any per-vertex rounding leaked thin
    // "whisker" artifacts past the round-join circle.
    join_pad = join_pad + 0.5 * layer.mpp;
    let along_pad = max(half_w_side, join_pad);
    offset = offset + dir * along * along_pad * across_scale;
  } else {
    // Chain terminus: use the configured cap pad (butt/square/arrow).
    let endpoint_pad = select(pad_p1_m, pad_p0_m, is_start);
    offset = offset + dir * along * endpoint_pad;
  }

  var corner_local = base + offset;

  // ── Screen-pixel-width stroke geometry (Mapbox / MapLibre convention) ──
  // Scale the perpendicular offset so each corner lands EXACTLY
  // (width_px + 2*aa_width_px) screen pixels from the centerline,
  // regardless of source-meter scale or projection distortion.
  // Two effects:
  //   1. At high pitch / perspective foreshortening, the quad keeps
  //      coverage instead of dropping below 1 px (was the prior
  //      reason for this branch — minimum clamp).
  //   2. On globe projections (orthographic / azimuthal /
  //      stereographic) at low zoom, source-meter half_w can be
  //      thousands of km — without this clamp the quad extends
  //      far past the visible disc as a flat slab and the per-
  //      fragment backface cull (compute_line_color below) sees
  //      fragments off the globe entirely. Scaling down to
  //      pixel-equivalent source meters keeps the quad on-globe
  //      so the cull lands on the great-circle horizon.
  // Trade-off: when scale < 1 (down-scaling case), the in-fragment
  // SDF threshold (half_w_m source meters) is larger than the
  // rasterized quad's extent, so all visible fragments resolve
  // alpha=1 and AA happens at the rasterization edge instead of
  // the SDF transition. Acceptable for current scope; full
  // pixel-space SDF (with per-quad scaled half_w varying) is a
  // future refinement once joins / patterns / arrow caps move to
  // pixel units too.
  if (layer.viewport_height > 0.0) {
    let center_clip = tile.mvp * vec4<f32>(finalize_corner(base), seg.z_lift_m, 1.0);
    let corner_clip = tile.mvp * vec4<f32>(finalize_corner(corner_local), seg.z_lift_m, 1.0);
    let center_ndc = center_clip.xy / max(abs(center_clip.w), 1e-6) * sign(center_clip.w);
    let corner_ndc = corner_clip.xy / max(abs(corner_clip.w), 1e-6) * sign(corner_clip.w);
    let screen_dist = length(corner_ndc - center_ndc);
    let target_ndc = (effective_width_px + 2.0 * layer.aa_width_px) / layer.viewport_height;
    if (screen_dist > 1e-8) {
      let scale = target_ndc / screen_dist;
      corner_local = base + offset * scale;
    }
  }

  // corner_local is in the geometry frame (Mercator: cam-relative
  // projected XY; Non-Mercator: tile-local source Mercator). Project
  // exactly once per corner so each quad vertex lands where it
  // should on the globe — same per-vertex projection pattern as the
  // polygon shader. world_local stays in the geometry frame so the
  // fragment SDF works in a consistent space.
  var out: LineOut;
  let corner_proj = finalize_corner(corner_local);
  // seg.z_lift_m: per-segment world-z lift in metres. Baked at line-
  // segment build time from the slice's heights map (looked up by
  // featId). 0 = stay on the ground (default for non-extruded
  // layers). For per-feature extrude this matches each building's
  // own height so the outline rides exactly on its roof — tall
  // buildings get tall outlines, short buildings get short outlines.
  let clip = tile.mvp * vec4<f32>(corner_proj, seg.z_lift_m, 1.0);
  out.position = apply_log_depth(clip, tile.log_depth_fc);
  out.view_w = clip.w;
  out.world_local = corner_local; // geometry-frame; matches compute_line_color
  out.seg_id = seg_id;
  // Backface signal — pick the cos_c at this vertex's endpoint. With
  // is_start=true (vertex near p0) we output cos_c at p0, otherwise at
  // p1. The sign interpolates across the quad so a segment that
  // straddles the visible-hemisphere boundary gets discarded fragment-
  // by-fragment along the great-circle horizon line. For flat
  // projections both endpoints return +1, so the discard is a no-op.
  let cos_c_p0 = endpoint_cos_c(seg.p0_h, seg.p0_l);
  let cos_c_p1 = endpoint_cos_c(seg.p1_h, seg.p1_l);
  out.cos_c = select(cos_c_p1, cos_c_p0, is_start);
  return out;
}

// ── Cap + Join helpers (Phase 2) ──

// Distance to a half-plane defined by a point and an outward normal.
// d_plane > 0 means the fragment is on the outside (to be clipped or capped).
fn plane_signed(p: vec2<f32>, origin: vec2<f32>, outward_nrm: vec2<f32>) -> f32 {
  return dot(p - origin, outward_nrm);
}

// Core line SDF + color math. Shared by two entry points:
//   - fs_line: standard path, writes @builtin(frag_depth) so log-depth
//              matches the vector-tile + raster passes into the same
//              main depth target.
//   - fs_line_max: translucent offscreen path. Its render target has no
//              depth attachment, so writing frag_depth there is a
//              validation error. This path returns plain color only.
fn compute_line_color(in: LineOut) -> vec4<f32> {
  // Backface cull for globe projections (orthographic / azimuthal /
  // stereographic), evaluated PER FRAGMENT.
  //
  // Per-vertex cos_c was the original cull (5867a80) but interpolating
  // a non-linear function (cos_c is the cosine of great-circle distance
  // from camera) across a thick stroke quad gives wrong values inside
  // the quad — fragments whose actual world position is on the back
  // hemisphere can interpolate to a positive cos_c if all four quad
  // corners are barely positive. Reconstruct lon/lat at the fragment
  // from in.world_local and dispatch the canonical helper. For flat
  // projections (Mercator / equirect / natural earth) the helper
  // returns +1, so this is a no-op there.
  //
  // in.world_local is in the stroke geometry frame (see line_endpoint
  // / finalize_corner): cam-relative projected XY for Mercator,
  // tile-local source Mercator for non-Mercator. We only need the
  // non-Mercator branch since the helper short-circuits for flat.
  if (tile.proj_params.x >= 0.5) {
    let abs_merc = in.world_local + tile.tile_origin_merc;
    let abs_lon = abs_merc.x / (DEG2RAD * EARTH_R);
    let lat_rad = 2.0 * atan(exp(abs_merc.y / EARTH_R)) - PI / 2.0;
    let abs_lat = lat_rad / DEG2RAD;
    if (needs_backface_cull(abs_lon, abs_lat, tile.proj_params) < 0.0) { discard; }
  }

  // Per-tile clip mask (parity with fs_fill in renderer.ts:330-339).
  // Active when a fallback parent tile clips its geometry to the
  // visible child's mercator bounds. Without this, parent SDF
  // outlines bleed across child tile boundaries and produce
  // boundary-aligned vertical / horizontal strokes (user-reported
  // countries_boundary lines on demotiles Russia z=4.68 / 5.19).
  // Sentinel -1e30 in clip_bounds.x skips the check (primary
  // direct-archive tiles never set real bounds).
  let _clip_valid =
    tile.clip_bounds.x > -1e29 &&
    tile.clip_bounds.z > tile.clip_bounds.x &&
    tile.clip_bounds.w > tile.clip_bounds.y;
  if (_clip_valid) {
    // world_local frame depends on projection: Mercator branch is
    // CAM-RELATIVE projected XY, non-Mercator is TILE-LOCAL source
    // Mercator. Reconstruct absolute Mercator accordingly. For
    // Mercator add back the DSFUN cam offset (cam_h + cam_l =
    // cam_merc - tile_origin_merc per the Uniforms.cam_h comment).
    let cam_offset = select(
      vec2<f32>(0.0, 0.0),
      tile.cam_h + tile.cam_l,
      tile.proj_params.x < 0.5,
    );
    let abs_merc_clip = in.world_local + cam_offset + tile.tile_origin_merc;
    if (abs_merc_clip.x < tile.clip_bounds.x) { discard; }
    if (abs_merc_clip.x > tile.clip_bounds.z) { discard; }
    if (abs_merc_clip.y < tile.clip_bounds.y) { discard; }
    if (abs_merc_clip.y > tile.clip_bounds.w) { discard; }
  }

  let seg = segments[in.seg_id];
  let p = in.world_local;
  // Reconstruct p0/p1 in the SAME geometry frame as in.world_local
  // (vs_line corner_local) — see line_endpoint above. Mercator: DSFUN
  // camera-relative (= projected XY for Mercator). Non-Mercator:
  // tile-local source Mercator. Distance/SDF math runs in that frame
  // and half_w_m is meters in the same frame.
  let p0 = line_endpoint(seg.p0_h, seg.p0_l);
  let p1 = line_endpoint(seg.p1_h, seg.p1_l);

  // Segment direction/normal in tile-local meters
  let seg_vec = p1 - p0;
  let seg_len = length(seg_vec);
  var dir: vec2<f32>;
  if (seg_len < 1e-6) {
    dir = vec2<f32>(1.0, 0.0);
  } else {
    dir = seg_vec / seg_len;
  }

  // Per-segment width override falls through to layer width_px when 0
  // (legacy / unmerged layers). Compound mergeLayers groups
  // populate it from the synthesized match() AST.
  let effective_width_px = select(layer.width_px, seg.width_px_override, seg.width_px_override > 0.0);
  let half_w_m = effective_width_px * 0.5 * layer.mpp;

  // ── 1. Main body distance (pixels) ──
  // Signed perpendicular distance (+left of travel). With a parallel offset
  // the stroke centerline is shifted to signed_perp == offset_m, so the
  // body SDF measures |signed_perp - offset_m|.
  let nrm_line = vec2<f32>(-dir.y, dir.x);
  let signed_perp = dot(p - p0, nrm_line);
  let perp_m = abs(signed_perp - layer.offset_m);
  let body_d = perp_m - half_w_m;

  // Offset-shifted endpoint centers used by round caps / round joins.
  // For a CAP (chain end, no neighbor) the simple perp shift is correct.
  // For a JOIN the two adjacent offset centerlines meet at the OFFSET MITER
  // VERTEX, not at the perp-shifted endpoint — both adjacent segments must
  // compute the same join center for their round circles to coincide.
  // Bare cap centers (used by !has_prev / !has_next branches below):
  let p0_cap_center = p0 + nrm_line * layer.offset_m;
  let p1_cap_center = p1 + nrm_line * layer.offset_m;

  // Offset miter vertices (used by has_prev / has_next round-join branches).
  // Standard miter formula applied to offset_m instead of half_w.
  let nrm_prev_off = vec2<f32>(-seg.prev_tangent.y, seg.prev_tangent.x);
  let miter_vec_p0 = nrm_line + nrm_prev_off;
  let proj_p0 = dot(miter_vec_p0, nrm_line);
  let p0_join_center = p0 + miter_vec_p0 * (layer.offset_m / max(proj_p0, 1e-4));

  let nrm_next_off = vec2<f32>(-seg.next_tangent.y, seg.next_tangent.x);
  let miter_vec_p1 = nrm_line + nrm_next_off;
  let proj_p1 = dot(miter_vec_p1, nrm_line);
  let p1_join_center = p1 + miter_vec_p1 * (layer.offset_m / max(proj_p1, 1e-4));

  // Clip planes at endpoints — shared by early discard and cap/join logic below.
  let dist_p0_vs = -dot(p - p0, dir);
  let dist_p1_vs =  dot(p - p1, dir);

  // ── Early fragment discard ──
  // Quads are padded by the worst-case miter/pattern/arrow extent. Fragments
  // that fall clearly OUTSIDE the stroke body AND inside the segment range
  // (no cap/join needed) contribute nothing — skip the full ~90-branch body
  // below. Keeps the body, caps, joins, dashes, and patterns all intact.
  var pat_extent_fs = 0.0;
  if ((layer.flags & LINE_FLAG_HAS_PATTERN) != 0u) {
    for (var pk_fs = 0u; pk_fs < 3u; pk_fs = pk_fs + 1u) {
      let pat_fs = layer.patterns[pk_fs];
      if (pat_fs.id == 0u) { continue; }
      let sz_unit_fs = (pat_fs.flags >> 2u) & 3u;
      let off_unit_fs = (pat_fs.flags >> 4u) & 3u;
      let size_m_fs = pattern_unit_to_m(pat_fs.size, sz_unit_fs, layer.mpp);
      let off_m_fs = abs(pattern_unit_to_m(pat_fs.offset, off_unit_fs, layer.mpp));
      pat_extent_fs = max(pat_extent_fs, size_m_fs * 0.5 + off_m_fs);
    }
  }
  let aa_margin_m = 2.0 * layer.aa_width_px * layer.mpp;
  let early_perp_thresh = max(half_w_m, pat_extent_fs) + aa_margin_m;
  if (perp_m > early_perp_thresh && dist_p0_vs < 0.0 && dist_p1_vs < 0.0) {
    discard;
  }

  // ── 2. Cap at p0 (has_prev == false) ──
  // The p0 cap acts only when this segment is a line START (no prev tangent).
  // has_prev == false when prev_tangent is zero.
  let has_prev = length(seg.prev_tangent) > 0.001;
  let has_next = length(seg.next_tangent) > 0.001;
  let cap_type = layer.flags & 7u;
  let arrow_L = half_w_m * 4.0;

  // Clip planes at endpoints (already computed above for early-discard).
  let dist_p0 = dist_p0_vs;
  let dist_p1 = dist_p1_vs;

  var d_m = body_d;

  // ── Bisector clip at joined endpoints ──
  // At every join the segment body is constrained to the HALF-PLANE on
  // its own side of the forward bisector. The adjacent segment clips to
  // the OPPOSITE side so the two meet exactly at the bisector plane and
  // don't re-cover each other's pixels. Without this clip, the vertex-
  // level miter geometry produces overlapping quads whenever consecutive
  // segments are short relative to the stroke width (dense polyline data
  // at low zoom) — and every overlap pixel accumulates alpha, making
  // translucent strokes visibly brighter at sharp corners.
  //
  // For MITER joins, the body SDF naturally extends past the join vertex
  // into the miter tip area. The bisector splits ownership so each segment
  // renders its half of the miter diamond. The vertex-shader quad extension
  // (pad_ratio × half_w) ensures geometry coverage.
  //
  // For BEVEL joins, a bevel-edge clip is added on top of the bisector
  // clip. This truncates the miter tip at the straight line connecting
  // the two outer stroke corners, producing the flat bevel shape.
  let join_flags = (layer.flags >> 3u) & 3u;
  if (has_prev) {
    let bis_p0 = seg.prev_tangent + dir;
    let bis_len_p0 = length(bis_p0);
    if (bis_len_p0 > 1e-6) {
      let bis_unit_p0 = bis_p0 / bis_len_p0;
      // Bisector plane passes through the OFFSET miter vertex
      // (p0_join_center), not the centerline vertex p0. For offset_m = 0
      // the two points coincide; for inset/outset/stroke-offset layers
      // the bisector slides along the bisector direction by
      // offset_m / sin(theta/2) so each segment's half of the join sits
      // where the shifted parallel strokes actually meet. Without this
      // correction the join-territory split fires at the wrong along
      // position, visibly shortening or lengthening the apparent end
      // of an offset stroke.
      let along_p0 = dot(p - p0_join_center, bis_unit_p0);
      // Only clip when on the WRONG side of the bisector (prev's territory).
      // Gating with an if avoids pulling d_m toward zero on MY side near
      // the bisector plane, which would reduce alpha and create visible
      // brightness discontinuities when the adjacent segment draws with
      // full coverage on the other side.
      if (along_p0 < 0.0) {
        // See p1 bisector clip for the +mpp rationale (whisker fix).
        d_m = max(d_m, -along_p0 + layer.mpp);
      }
    }
    // Bevel-edge clip at p0: truncate the body at the bevel edge so the
    // miter tip is cut flat. The bevel edge connects the outer stroke
    // corners of the two segments meeting at this vertex. Applied for
    // explicit BEVEL joins AND for MITER joins whose corner exceeds the
    // per-layer miter limit — without this, MITER corners sharper than
    // the limit rendered as long spikes even though the CPU already
    // clamped the quad pad (the layer uniform miter_limit was declared
    // but never read by the old shader).
    //   sinHalf = abs(cross(A,B)) / length(A+B)
    //   miter_ratio = 1 / sinHalf = length(A+B) / abs(cross(A,B))
    //   exceeded  when miter_ratio greater than miter_limit
    //   equivalently  length(A+B) > miter_limit * abs(cross(A,B))
    let cross_p0_mag = abs(seg.prev_tangent.x * dir.y - seg.prev_tangent.y * dir.x);
    let bis_mag_p0 = length(seg.prev_tangent + dir);
    let miter_over_p0 = bis_mag_p0 > layer.miter_limit * cross_p0_mag;
    let apply_bevel_p0 = (join_flags == JOIN_BEVEL) ||
                         (join_flags == JOIN_MITER && miter_over_p0);
    if (apply_bevel_p0) {
      let prev_nrm = vec2<f32>(-seg.prev_tangent.y, seg.prev_tangent.x);
      let cross_p0 = seg.prev_tangent.x * dir.y - seg.prev_tangent.y * dir.x;
      if (abs(cross_p0) > 1e-6) {
        let s0 = -sign(cross_p0);
        let oc0 = p0 + prev_nrm * (layer.offset_m + half_w_m * s0);
        let on0 = p0 + nrm_line * (layer.offset_m + half_w_m * s0);
        let be0 = on0 - oc0;
        let bl0 = length(be0);
        if (bl0 > 1e-6) {
          let bd0 = be0 / bl0;
          let bo0 = vec2<f32>(-bd0.y, bd0.x) * s0;
          let bclip0 = dot(p - oc0, bo0);
          if (bclip0 > 0.0) {
            d_m = max(d_m, bclip0);
          }
        }
      }
    }
  }
  if (has_next) {
    let bis_p1 = dir + seg.next_tangent;
    let bis_len_p1 = length(bis_p1);
    if (bis_len_p1 > 1e-6) {
      let bis_unit_p1 = bis_p1 / bis_len_p1;
      // Same offset-miter-vertex correction as at p0.
      let along_p1 = dot(p - p1_join_center, bis_unit_p1);
      if (along_p1 > 0.0) {
        // Push at least 1 pixel positive so the AA-edge of this bisector
        // clip doesn't overlap with the neighbour segment's AA-edge of its
        // own round-join arc. Without the +mpp guard the two segments both
        // contribute partial alpha at the bisector line and BLEND_ALPHA
        // composes them as 0.75 instead of 1.0 — visible as a thin dim
        // "whisker" diagonal at the offset round-join corner.
        d_m = max(d_m, along_p1 + layer.mpp);
      }
    }
    // Bevel-edge clip at p1 — same BEVEL-or-miter-exceeded condition as p0.
    let cross_p1_mag = abs(dir.x * seg.next_tangent.y - dir.y * seg.next_tangent.x);
    let bis_mag_p1 = length(dir + seg.next_tangent);
    let miter_over_p1 = bis_mag_p1 > layer.miter_limit * cross_p1_mag;
    let apply_bevel_p1 = (join_flags == JOIN_BEVEL) ||
                         (join_flags == JOIN_MITER && miter_over_p1);
    if (apply_bevel_p1) {
      let next_nrm_bv = vec2<f32>(-seg.next_tangent.y, seg.next_tangent.x);
      let cross_p1 = dir.x * seg.next_tangent.y - dir.y * seg.next_tangent.x;
      if (abs(cross_p1) > 1e-6) {
        let s1 = -sign(cross_p1);
        let oc1 = p1 + nrm_line * (layer.offset_m + half_w_m * s1);
        let on1 = p1 + next_nrm_bv * (layer.offset_m + half_w_m * s1);
        let be1 = on1 - oc1;
        let bl1 = length(be1);
        if (bl1 > 1e-6) {
          let bd1 = be1 / bl1;
          let bo1 = vec2<f32>(-bd1.y, bd1.x) * s1;
          let bclip1 = dot(p - oc1, bo1);
          if (bclip1 > 0.0) {
            d_m = max(d_m, bclip1);
          }
        }
      }
    }
  }

  // ── Handle p0 end (cap or join) ──
  if (!has_prev) {
    // CAP at p0
    if (cap_type == CAP_BUTT) {
      d_m = max(d_m, dist_p0);
    } else if (cap_type == CAP_SQUARE) {
      d_m = max(d_m, dist_p0 - half_w_m);
    } else if (cap_type == CAP_ARROW) {
      // Analytical arrow: fragments past p0 (along -dir) use a tapered
      // half-width = half_w * (1 - dist_p0/arrow_L), clipped at arrow_L.
      if (dist_p0 > 0.0) {
        let t = clamp(dist_p0 / arrow_L, 0.0, 1.0);
        let new_w = half_w_m * (1.0 - t);
        d_m = max(perp_m - new_w, dist_p0 - arrow_L);
      }
    } else { // CAP_ROUND
      let circle_d = length(p - p0_cap_center) - half_w_m;
      d_m = select(d_m, circle_d, dist_p0 > 0.0);
    }
  } else {
    // JOIN at p0. For round joins, draw a circle overlay that fills the
    // corner wedge. Gate by the forward-bisector side so each segment
    // only draws its own half of the circle — the other half is drawn
    // by the prev segment at its p1 join. Without this gate, both
    // segments draw the full circle at the corner and alpha accumulates
    // on translucent strokes (the bright beads the user reported).
    let join_type = (layer.flags >> 3u) & 3u;
    if (join_type == JOIN_ROUND && dist_p0 > 0.0) {
      let bis_p0_j = seg.prev_tangent + dir;
      let bis_len_j = length(bis_p0_j);
      if (bis_len_j > 1e-6) {
        let bis_unit_j = bis_p0_j / bis_len_j;
        // Bisector gate must reference the offset miter vertex so it
        // agrees with where the circle is centered below. Using p0
        // (the centerline vertex) here made the gate fire at the wrong
        // along position for offset strokes, so both adjacent segments
        // sometimes passed on the same pixel and the round-join circle
        // visibly doubled at the corner — observed on
        // fixture-stroke-outset where a rogue ring appears inside each
        // polygon corner.
        let along_j = dot(p - p0_join_center, bis_unit_j);
        // Both p0 (>= 0) and p1 (<= 0) gates are INCLUSIVE at the
        // bisector plane. See the p1 gate below for the full story —
        // a strict-on-one-side + strict-on-other-side split leaves
        // body_d from the adjacent segment leaking past the circle
        // radius as a diagonal whisker. Matching inclusives double-
        // replace at the exact bisector line only, which is
        // idempotent for opaque strokes.
        if (along_j >= 0.0) {
          // True round-join with offset. Centre-aligned strokes have
          // the body's outer corner exactly at the circle's tangent
          // point — body meets arc seamlessly. With offset, the miter
          // vertex shifts by |offset_m| * tan(β/2) along the bisector,
          // so the body's natural endpoint at p0 needs to extend
          // backward by the SAME amount along -dir to reach the
          // circle's tangent line. Below, the clip threshold is
          // abs(offset_m) * pad_ratio (= tan(β/2)) instead of 0 —
          // that keeps body fragments up to the offset-extended
          // endpoint, closing the tangent gap exactly.
          let circle_d = length(p - p0_join_center) - half_w_m;
          let along_extend_p0 = abs(layer.offset_m) * seg.pad_ratio_p0;

          // Clip current body: past p0 by more than the extension is
          // miter-wedge territory. Within the extension the body
          // stays — that's where body meets circle tangentially.
          var current_d = d_m;
          if (dist_p0 > along_extend_p0) {
            current_d = max(d_m, dist_p0 - along_extend_p0);
          }

          // Prev segment's body (reconstructed from prev_tangent).
          // Same extension rule past prev's end in its +dir direction.
          let prev_nrm = vec2<f32>(-seg.prev_tangent.y, seg.prev_tangent.x);
          let prev_signed_perp = dot(p - p0, prev_nrm);
          let prev_perp_m = abs(prev_signed_perp - layer.offset_m);
          var neighbor_d = prev_perp_m - half_w_m;
          let along_past_prev_end = dot(p - p0, seg.prev_tangent);
          if (along_past_prev_end > along_extend_p0) {
            neighbor_d = max(neighbor_d, along_past_prev_end - along_extend_p0);
          }

          d_m = min(min(current_d, circle_d), neighbor_d);
        }
      }
    }
  }

  // ── Handle p1 end (cap or join) — symmetric ──
  if (!has_next) {
    if (cap_type == CAP_BUTT) {
      d_m = max(d_m, dist_p1);
    } else if (cap_type == CAP_SQUARE) {
      d_m = max(d_m, dist_p1 - half_w_m);
    } else if (cap_type == CAP_ARROW) {
      if (dist_p1 > 0.0) {
        let t = clamp(dist_p1 / arrow_L, 0.0, 1.0);
        let new_w = half_w_m * (1.0 - t);
        d_m = max(perp_m - new_w, dist_p1 - arrow_L);
      }
    } else { // CAP_ROUND
      let circle_d = length(p - p1_cap_center) - half_w_m;
      d_m = select(d_m, circle_d, dist_p1 > 0.0);
    }
  } else {
    // JOIN at p1 — symmetric with p0. Draw the circle only on the
    // current segment's side (along_p1 <= 0) so the next segment handles
    // the other half of the corner.
    let join_type_p1 = (layer.flags >> 3u) & 3u;
    if (join_type_p1 == JOIN_ROUND && dist_p1 > 0.0) {
      let bis_p1_j = dir + seg.next_tangent;
      let bis_len_j = length(bis_p1_j);
      if (bis_len_j > 1e-6) {
        let bis_unit_j = bis_p1_j / bis_len_j;
        // Same offset-miter-vertex correction as at p0; see comment there.
        let along_j = dot(p - p1_join_center, bis_unit_j);
        // Both p0 (>= 0) and p1 (<= 0) gates are INCLUSIVE at the
        // bisector plane (along == 0). The two neighbouring segments
        // therefore BOTH replace body_d with circle_d on that exact
        // line. This is intentional double-draw: making only one side
        // inclusive still leaves the OTHER segment's body visible past
        // the round-circle radius (the diagonal whisker user reported
        // on fixture-stroke-outset even after the first inclusive-gate
        // fix). Opaque blending of two identical circle_d samples is
        // idempotent — the tiny AA-edge pixel brightening is invisible
        // next to the eliminated whisker.
        if (along_j <= 0.0) {
          // Mirror of p0 with the same offset-aware along extension.
          // See the p0 branch above for the full rationale; tl;dr:
          // the body's natural endpoint extends past p1 by
          // |offset_m| * tan(β/2) so the body's outer corner lands
          // on the offset circle's tangent line, matching the
          // seamless meet at offset=0.
          let circle_d = length(p - p1_join_center) - half_w_m;
          let along_extend_p1 = abs(layer.offset_m) * seg.pad_ratio_p1;

          var current_d = d_m;
          if (dist_p1 > along_extend_p1) {
            current_d = max(d_m, dist_p1 - along_extend_p1);
          }

          let next_nrm = vec2<f32>(-seg.next_tangent.y, seg.next_tangent.x);
          let next_signed_perp = dot(p - p1, next_nrm);
          let next_perp_m = abs(next_signed_perp - layer.offset_m);
          var neighbor_d = next_perp_m - half_w_m;
          let along_into_next = dot(p - p1, seg.next_tangent);
          if (along_into_next < -along_extend_p1) {
            neighbor_d = max(neighbor_d, -along_into_next - along_extend_p1);
          }

          d_m = min(min(current_d, circle_d), neighbor_d);
        }
      }
    }
    // Note: MITER joins need no additional SDF here. The body SDF extends
    // past the endpoint, and the bisector clip (above) splits ownership
    // between adjacent segments. Each segment renders its half of the
    // miter diamond via its own body. The vertex-shader quad extension
    // (pad_ratio × half_w) ensures geometry coverage for the tip.
    //
    // BEVEL joins are handled by the bevel-edge clip in the bisector
    // section (above), which truncates the miter tip at the bevel edge.
  }

  // Project fragment onto segment's along-axis to get local arc (shared by dash + patterns)
  let t_along_unclamped = dot(p - p0, dir);
  let t_along = clamp(t_along_unclamped, 0.0, seg_len);
  let arc_pos = seg.arc_start + t_along;
  let nrm_fs = vec2<f32>(-dir.y, dir.x);

  // ── Dash array ──
  // Fragments inside the chain-terminus cap region (past p0 with no
  // prev neighbor, or past p1 with no next) are NOT subject to the
  // dash pattern: caps are part of the line endpoint, not dash
  // segments. Without this guard the cap phase-flickers in and out
  // as the dash_offset animation advances — the cap's clamped
  // arc_pos lands in a "gap" slot and the whole fragment is
  // discarded, giving the "caps disappear with marching ants" bug.
  // The guard condition is (!has_prev && dist_p0>0) || (!has_next && dist_p1>0);
  // interior joints + body fragments still get the dash.
  let in_cap_region =
    (!has_prev && dist_p0 > 0.0) ||
    (!has_next && dist_p1 > 0.0);
  if ((((layer.flags >> 5u) & 1u) == 1u) && (layer.dash_count > 0u) && (layer.dash_cycle_m > 1e-6) && !in_cap_region) {
    var phase = (arc_pos + layer.dash_offset_m) / layer.dash_cycle_m;
    phase = (phase - floor(phase)) * layer.dash_cycle_m;

    var acc = 0.0;
    var visible = false;
    for (var i: u32 = 0u; i < layer.dash_count; i = i + 1u) {
      let idx = i / 4u;
      let sub = i % 4u;
      var seg_v = layer.dash_array[idx];
      var len: f32 = 0.0;
      if (sub == 0u) { len = seg_v.x; }
      else if (sub == 1u) { len = seg_v.y; }
      else if (sub == 2u) { len = seg_v.z; }
      else { len = seg_v.w; }
      if (phase >= acc && phase < acc + len) {
        visible = (i & 1u) == 0u;
        break;
      }
      acc = acc + len;
    }
    if (!visible) { discard; }
  }

  // ── Pattern stack ──
  // For each active slot, find the nearest pattern instance center along the
  // arc, then sample sdf_shape in that instance's local (-1..1) uv frame.
  // The minimum of all pattern SDFs is unioned with the line body.
  var pat_d_m: f32 = 1e10;
  if ((layer.flags & LINE_FLAG_HAS_PATTERN) != 0u) {
    for (var k: u32 = 0u; k < 3u; k = k + 1u) {
      let pat = layer.patterns[k];
      if (pat.id == 0u) { continue; }

      let sp_unit = pat.flags & 3u;
      let sz_unit = (pat.flags >> 2u) & 3u;
      let of_unit = (pat.flags >> 4u) & 3u;
      let anchor = (pat.flags >> 6u) & 3u;
      let spacing_m = max(pattern_unit_to_m(pat.spacing, sp_unit, layer.mpp), 1e-3);
      let size_m = max(pattern_unit_to_m(pat.size, sz_unit, layer.mpp), 1e-3);
      let off_m = pattern_unit_to_m(pat.offset, of_unit, layer.mpp);
      let start_m = pat.start_offset;
      let half_s = size_m * 0.5;

      if (anchor == PAT_ANCHOR_REPEAT) {
        // Sample the nearest instance plus both neighbors so that size > spacing
        // overlap works correctly (union of adjacent SDFs). Early-outs via the
        // arc-range and |local| checks keep cost ~1x for the common case
        // size << spacing, because dk=-1/+1 trivially continue.
        let k_center = floor((arc_pos - start_m) / spacing_m + 0.5);
        for (var dk: i32 = -1; dk <= 1; dk = dk + 1) {
          let center_arc_k = (k_center + f32(dk)) * spacing_m + start_m;
          let arc_on_seg_k = center_arc_k - seg.arc_start;
          if (arc_on_seg_k < -half_s * 2.0 || arc_on_seg_k > seg_len + half_s * 2.0) { continue; }
          let center_world_k = p0 + dir * arc_on_seg_k;
          let local_k = vec2<f32>(
            dot(p - center_world_k, dir) / half_s,
            (dot(p - center_world_k, nrm_fs) - off_m) / half_s,
          );
          if (abs(local_k.x) > 1.2 || abs(local_k.y) > 1.2) { continue; }
          let shape_v_k = sdf_shape(local_k, pat.id - 1u);
          let pd_k = (shape_v_k - 1.0) * half_s;
          pat_d_m = min(pat_d_m, pd_k);
        }
        continue;
      }

      // START / END / CENTER — single instance
      var center_arc: f32;
      if (anchor == PAT_ANCHOR_START) {
        center_arc = start_m;
      } else if (anchor == PAT_ANCHOR_END) {
        center_arc = seg.line_length - start_m;
      } else {
        center_arc = seg.line_length * 0.5;
      }

      // Transform to segment-local coords
      let arc_on_seg = center_arc - seg.arc_start;
      if (arc_on_seg < -half_s * 2.0 || arc_on_seg > seg_len + half_s * 2.0) { continue; }
      let center_world = p0 + dir * arc_on_seg;
      let local = vec2<f32>(
        dot(p - center_world, dir) / half_s,
        (dot(p - center_world, nrm_fs) - off_m) / half_s,
      );
      if (abs(local.x) > 1.2 || abs(local.y) > 1.2) { continue; }

      // sdf_shape returns normalized distance (1.0 = edge). Convert to meters.
      let shape_v = sdf_shape(local, pat.id - 1u);
      let pd = (shape_v - 1.0) * half_s;
      pat_d_m = min(pat_d_m, pd);
    }
  }
  if (pat_d_m < 1e9) { d_m = min(d_m, pat_d_m); }

  // Convert to pixels
  let d_px = d_m / layer.mpp;
  // MapLibre line-blur spec: paint property in pixels, default 0.
  // aa_width_px is packed as (1.0 + blur_px) on the CPU side, so
  // split it back into a sub-pixel base AA + the spec blur addition.
  let blur_px = max(0.0, layer.aa_width_px - 1.0);
  let aa = 0.5 + blur_px;
  let alpha = 1.0 - smoothstep(-aa, aa, d_px);
  if (alpha < 0.005) { discard; }
  // Per-segment stroke colour override (RGBA8 packed). Compound
  // mergeLayers groups whose members had different stroke colours
  // bake the resolved colour into seg.color_packed at compile time.
  // Unpack here and use when alpha > 0; otherwise fall through to
  // the layer uniform colour (legacy / unmerged layers).
  let seg_packed: u32 = bitcast<u32>(seg.color_packed);
  let seg_color = unpack4x8unorm(seg_packed);
  let base_color = select(layer.color, seg_color, seg_color.a > 0.0);
  return vec4<f32>(base_color.rgb, base_color.a * alpha);
}

@fragment
fn fs_line(in: LineOut) -> LineFragmentOutput {
  var out: LineFragmentOutput;
  out.color = compute_line_color(in);
  __PICK_WRITE__
  out.depth = compute_log_frag_depth(in.view_w, tile.log_depth_fc);
  return out;
}

// Max-blend path: targets an offscreen color-only attachment (no depth).
// Writing @builtin(frag_depth) here trips WebGPU's "shader writes frag
// depth but no depth texture set" validation, so this entry point skips
// log-depth entirely — the translucent pass composites over the main
// framebuffer later, so its depth values would be discarded anyway.
@fragment
fn fs_line_max(in: LineOut) -> @location(0) vec4<f32> {
  return compute_line_color(in);
}
`

// ═══ Renderer ═══

export class LineRenderer {
  private static readonly LAYER_SLOT = 256
  private device: GPUDevice
  private format: GPUTextureFormat
  /** Standard alpha-blend pipeline — used for opaque line draws. */
  private pipeline: GPURenderPipeline
  /** Max-blend pipeline — used for translucent line draws into the offscreen
   *  RT. Max blending eliminates within-layer alpha accumulation at corner
   *  overlaps and self-intersections. */
  private pipelineMax!: GPURenderPipeline
  private tileBindGroupLayout: GPUBindGroupLayout
  private layerBindGroupLayout: GPUBindGroupLayout
  private shapeRegistry: ShapeRegistry | null = null
  /** Deduped warnings for bad pattern parameter combos. Key: stable string
   *  describing the violation. Survives per LineRenderer instance — reset on
   *  demo reload (new instance). */
  private patternWarnings = new Set<string>()
  private emptyShapeBuffer: GPUBuffer
  // Dynamic-offset layer uniform ring (shared across all VTR sources/layers)
  private layerRing!: GPUBuffer
  private layerRingCapacity = 512
  private layerSlot = 0
  /** CPU-side mirror of layerRing. Each writeLayerSlot() stages its
   *  packed uniform bytes here and widens a dirty range; a single
   *  writeBuffer per frame flushes the range (in endFrame). Mirrors
   *  the VTR uniform-ring batching pattern. */
  private layerStaging!: Uint8Array
  private layerDirtyLo = 0
  private layerDirtyHi = 0

  // ── Translucent line offscreen + composite ──
  /** Single-sample offscreen RT used to render translucent line layers
   *  with max blending. Composited onto the main framebuffer with per-layer
   *  alpha. Lazily allocated + resized on demand. */
  private offscreenTexture: GPUTexture | null = null
  private offscreenView: GPUTextureView | null = null
  private offscreenWidth = 0
  private offscreenHeight = 0
  private offscreenSampler!: GPUSampler
  private compositePipeline!: GPURenderPipeline
  private compositeBindGroupLayout!: GPUBindGroupLayout
  private compositeBindGroup: GPUBindGroup | null = null
  /** Composite uniform buffer — single f32 (opacity). 16-byte aligned. */
  private compositeUniformBuffer!: GPUBuffer
  /** Last opacity value written to compositeUniformBuffer. The composite
   *  only needs a fresh writeBuffer when the opacity actually changes
   *  (between frames where opacity stays constant we'd otherwise rewrite
   *  identical bytes — cheap per call but ~200 redundant calls per
   *  translucent scenario). */
  private lastCompositeOpacity = Number.NaN

  constructor(ctx: GPUContext, vtrTileBindGroupLayout: GPUBindGroupLayout) {
    this.device = ctx.device
    this.format = ctx.format
    this.tileBindGroupLayout = vtrTileBindGroupLayout

    this.layerBindGroupLayout = this.device.createBindGroupLayout({
      label: 'line-layer-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    // Layer uniform ring. 256-byte slots → dynamic offsets prevent
    // multi-layer writeBuffer clobbering within a single frame.
    this.layerRing = this.device.createBuffer({
      size: this.layerRingCapacity * LineRenderer.LAYER_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-layer-ring',
    })
    this.layerStaging = new Uint8Array(this.layerRingCapacity * LineRenderer.LAYER_SLOT)

    this.emptyShapeBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE,
      label: 'line-empty-shape-buf',
    })

    // Splice the pick output into the SDF line shader when `?picking=1`.
    // SDF lines are usually stroke-only — they don't carry per-feature IDs
    // in the segment buffer, so the pick value is left at (0, 0). The
    // underlying polygon fill already wrote its feature ID in this pass,
    // so writing (0, 0) from the line stroke would OVERWRITE the fill's
    // pick — which is why the `writeMask: 0` on the second target skips
    // pick output entirely for the line pipeline.
    const linePickShader = LINE_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
      .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(0u, 0u);' : '')
    const module = this.device.createShaderModule({ code: linePickShader, label: 'line-shader' })

    const linePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.tileBindGroupLayout, this.layerBindGroupLayout],
    })

    this.pipeline = this.device.createRenderPipeline({
      label: 'line-pipeline',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line',
        targets: isPickEnabled()
          ? [
              { format: this.format, blend: BLEND_ALPHA },
              // writeMask: 0 → pick buffer preserves whatever the
              // polygon fill wrote underneath the line stroke.
              { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 },
            ]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Depth test ON, depth write OFF — lines respect 3D building
      // occlusion (a roof-edge outline behind a foreground wall is
      // hidden by the wall) without interfering with subsequent
      // draws. The previous STENCIL_DISABLED state ignored depth
      // entirely, which is fine for purely 2D scenes but visibly
      // wrong once `extrude:` lifts outlines onto building roofs:
      // background buildings' outlines bled through foreground
      // walls. Pure painter's order via depth-disabled writes —
      // already used by ground-layer fills — doesn't apply here
      // because lines need to compete with extruded fills that
      // DO write depth.
      depthStencil: DEPTH_READ_ONLY,
      multisample: { count: getSampleCount() },
    })

    // MAX-blend variant: same shader, different blend op + NO MSAA + NO depth-stencil.
    // Targets the single-sample offscreen RT used for translucent compositing.
    // Uses fs_line_max (not fs_line) because the offscreen target has no
    // depth attachment — writing @builtin(frag_depth) would trip the
    // "shader writes frag depth but no depth texture set" validation.
    this.pipelineMax = this.device.createRenderPipeline({
      label: 'line-pipeline-max',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line_max',
        targets: [{ format: this.format, blend: BLEND_MAX }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })

    // ── Composite pipeline ──
    this.compositeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    const compositeModule = this.device.createShaderModule({ code: COMPOSITE_SHADER, label: 'line-composite' })
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'line-composite-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vs_full' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_full',
        // fs_full emits PREMULTIPLIED rgb (`c.rgb * cu.opacity`); pair it
        // with the matching blend factor so we don't multiply by alpha a
        // second time at write. Using BLEND_ALPHA here was the original
        // bug — translucent line composites came out darker than asked.
        targets: [{ format: this.format, blend: BLEND_ALPHA_PREMULT }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: getSampleCount() },
    })
    this.offscreenSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
    this.compositeUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-composite-uniform',
    })
  }

  /** Re-create the main + composite pipelines from the live QUALITY
   *  (MSAA sample count, pick target). Called by map.setQuality(). The
   *  `pipelineMax` variant is always single-sample (offscreen RT) and
   *  has no pick target, so it doesn't need rebuilding. Bind group
   *  layouts, shape buffers, and the uniform ring survive unchanged. */
  rebuildForQuality(): void {
    const linePickShader = LINE_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
      .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(0u, 0u);' : '')
    const module = this.device.createShaderModule({ code: linePickShader, label: 'line-shader-rebuilt' })
    const linePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.tileBindGroupLayout, this.layerBindGroupLayout],
    })
    this.pipeline = this.device.createRenderPipeline({
      label: 'line-pipeline',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line',
        targets: isPickEnabled()
          ? [
              { format: this.format, blend: BLEND_ALPHA },
              { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 },
            ]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: DEPTH_READ_ONLY,
      multisample: { count: getSampleCount() },
    })
    // Composite pipeline samples the offscreen RT back into the MSAA main
    // color, so its multisample.count must match.
    const compositeModule = this.device.createShaderModule({ code: COMPOSITE_SHADER, label: 'line-composite-rebuilt' })
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'line-composite-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vs_full' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_full',
        targets: [{ format: this.format, blend: BLEND_ALPHA_PREMULT }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: getSampleCount() },
    })
  }

  /** Lazily allocate / resize the offscreen RT to match the main color target. */
  ensureOffscreen(width: number, height: number): void {
    if (this.offscreenTexture && this.offscreenWidth === width && this.offscreenHeight === height) return
    this.offscreenTexture?.destroy()
    this.offscreenTexture = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'line-translucent-offscreen',
    })
    this.offscreenView = this.offscreenTexture.createView()
    this.offscreenWidth = width
    this.offscreenHeight = height
    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.offscreenSampler },
        { binding: 1, resource: this.offscreenView },
        { binding: 2, resource: { buffer: this.compositeUniformBuffer } },
      ],
    })
  }

  /** Begin a translucent line render pass against the offscreen RT. */
  beginTranslucentPass(encoder: GPUCommandEncoder): GPURenderPassEncoder {
    if (!this.offscreenView) throw new Error('LineRenderer: offscreen not initialised')
    return encoder.beginRenderPass({
      label: 'line-translucent-pass',
      colorAttachments: [{
        view: this.offscreenView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
  }

  /** Composite the offscreen RT onto a main render pass with the given opacity. */
  composite(mainPass: GPURenderPassEncoder, opacity: number): void {
    if (!this.compositeBindGroup) return
    if (opacity !== this.lastCompositeOpacity) {
      this.device.queue.writeBuffer(this.compositeUniformBuffer, 0, new Float32Array([opacity, 0, 0, 0]))
      this.lastCompositeOpacity = opacity
    }
    mainPass.setPipeline(this.compositePipeline)
    mainPass.setBindGroup(0, this.compositeBindGroup)
    mainPass.draw(3, 1)
  }

  /** Used by VTR to pick the right pipeline depending on whether the
   *  current pass is the offscreen translucent pass. */
  getDrawPipeline(translucent: boolean): GPURenderPipeline {
    return translucent ? this.pipelineMax : this.pipeline
  }

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  /** Upload segment data and return a GPU buffer. Caller owns destruction. */
  uploadSegmentBuffer(segments: Float32Array): GPUBuffer {
    const size = Math.max(segments.byteLength, LINE_SEGMENT_STRIDE_BYTES)
    const buf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'line-segments',
    })
    this.device.queue.writeBuffer(buf, 0, segments)
    return buf
  }

  /** Async variant of `uploadSegmentBuffer`. Allocates the destination
   *  buffer, then schedules the write through `asyncWriteBuffer` (the
   *  caller's pool + encoder). Returns the destination buffer + a
   *  release closure for the staging slot — the caller submits the
   *  encoder, then invokes release() to return the staging slot to the
   *  pool. Requested by VTR's queued tile upload path so the segment
   *  buffer doesn't pay the driver's writeBuffer staging copy. */
  async uploadSegmentBufferAsync(
    segments: Float32Array,
    encoder: GPUCommandEncoder,
    pool: StagingBufferPool,
  ): Promise<{ buffer: GPUBuffer; release: () => void }> {
    const size = Math.max(segments.byteLength, LINE_SEGMENT_STRIDE_BYTES)
    const buf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'line-segments-async',
    })
    const handle = await asyncWriteBuffer(pool, encoder, buf, 0, segments)
    return { buffer: buf, release: handle.release }
  }

  /** Reset the layer ring slot cursor. Call once per frame. */
  beginFrame(): void {
    this.layerSlot = 0
  }

  /**
   * Allocate a slot and write layer uniform data. Returns byte offset to
   * pass as the dynamic offset in `drawSegments`.
   */
  writeLayerSlot(
    strokeColor: [number, number, number, number],
    strokeWidthPx: number,
    opacity: number,
    mppAtCenter: number,
    cap: number = LINE_CAP_BUTT,
    join: number = LINE_JOIN_MITER,
    miterLimit: number = 4.0,
    dash: DashConfig | null = null,
    patterns: PatternSlot[] = [],
    offsetPx: number = 0,
    viewportHeight: number = 1,
    blurPx: number = 0,
  ): number {
    // Pattern sanity checks (deduped, one warning per condition per
    // LineRenderer instance). Runs on the parameter set BEFORE packing so
    // that bogus values are flagged even if the GPU silently renders them.
    checkPatternParams(patterns, mppAtCenter, (k, m) => this.warnOnce(k, m))

    if (this.layerSlot >= this.layerRingCapacity) {
      console.warn('[LineRenderer] layer ring overflow — capping at capacity; style bleed possible')
      return (this.layerRingCapacity - 1) * LineRenderer.LAYER_SLOT
    }
    const off = this.layerSlot * LineRenderer.LAYER_SLOT
    this.layerSlot++
    const data = packLineLayerUniform(
      strokeColor, strokeWidthPx, opacity, mppAtCenter,
      cap, join, miterLimit, dash, patterns, offsetPx, viewportHeight, blurPx,
    )
    // Stage into the CPU mirror; flushLayerStaging (called from the
    // map's render loop via `endFrame()`) emits a single writeBuffer
    // over the frame's dirty range instead of one per layer.
    const src = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, LineRenderer.LAYER_SLOT))
    this.layerStaging.set(src, off)
    const hi = off + LineRenderer.LAYER_SLOT
    if (this.layerDirtyHi === this.layerDirtyLo) {
      this.layerDirtyLo = off
      this.layerDirtyHi = hi
    } else {
      if (off < this.layerDirtyLo) this.layerDirtyLo = off
      if (hi > this.layerDirtyHi) this.layerDirtyHi = hi
    }
    return off
  }

  /** Flush the accumulated layer-ring bytes in a single writeBuffer.
   *  Safe to call any time before queue.submit() — WebGPU orders the
   *  write before the submitted command buffer by spec. */
  endFrame(): void {
    if (this.layerDirtyHi === this.layerDirtyLo) return
    const lo = this.layerDirtyLo, hi = this.layerDirtyHi
    this.device.queue.writeBuffer(
      this.layerRing, lo,
      this.layerStaging.buffer, this.layerStaging.byteOffset + lo, hi - lo,
    )
    this.layerDirtyLo = 0
    this.layerDirtyHi = 0
  }

  /** Emit a warning once per (stable) key for the lifetime of this renderer. */
  private warnOnce(key: string, msg: string): void {
    if (this.patternWarnings.has(key)) return
    this.patternWarnings.add(key)
    console.warn(msg)
  }

  /**
   * Look up a shape name in the registry.
   * Returns the 1-based ID (0 = unknown/inactive) that goes straight into
   * PatternSlot.shapeId. The shader will call sdf_shape(uv, id - 1u).
   */
  resolveShapeId(name: string): number {
    return this.shapeRegistry?.getShapeId(name) ?? 0
  }

  /** Create a bind group for the line layer + segments + shape registry.
   *  Binding 0 uses a dynamic offset — actual slot is chosen at draw time. */
  createLayerBindGroup(segmentBuffer: GPUBuffer): GPUBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer ?? this.emptyShapeBuffer
    const shapeSegBuf = this.shapeRegistry?.segmentBuffer ?? this.emptyShapeBuffer
    return this.device.createBindGroup({
      layout: this.layerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.layerRing, offset: 0, size: LINE_UNIFORM_SIZE } },
        { binding: 1, resource: { buffer: segmentBuffer } },
        { binding: 2, resource: { buffer: shapeBuf } },
        { binding: 3, resource: { buffer: shapeSegBuf } },
      ],
    })
  }

  /**
   * Draw instanced quads for line segments.
   * `tileOffset` and `layerOffset` are the dynamic byte offsets returned from
   * each ring's allocator for this draw.
   */
  drawSegments(
    pass: GPURenderPassEncoder,
    tileBindGroup: GPUBindGroup,
    layerBindGroup: GPUBindGroup,
    segmentCount: number,
    tileOffset: number,
    layerOffset: number,
    translucent: boolean = false,
  ): void {
    if (segmentCount === 0) return
    // Overdraw-debug v1: SDF stroke pipeline targets the swapchain
    // format; r16float accumulator would mismatch. Skip — strokes
    // don't contribute to the v1 heatmap. Phase 2 adds an additive
    // r16float variant so line overdraw counts too.
    if (DEBUG_OVERDRAW) return
    pass.setPipeline(translucent ? this.pipelineMax : this.pipeline)
    pass.setBindGroup(0, tileBindGroup, [tileOffset])
    pass.setBindGroup(1, layerBindGroup, [layerOffset])
    pass.draw(6, segmentCount)
  }

  clearLayers(): void {
    // no-op: per-tile buffers are owned by VTR
  }
}
