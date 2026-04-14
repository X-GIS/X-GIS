// ═══ Common WGSL SDF Snippets ═══
// Shared signed-distance-field functions used by both point and line renderers.
// Include via string concatenation when building shaders.

/** Distance from point to line segment. */
export const WGSL_DIST_TO_SEGMENT = /* wgsl */ `
fn dist_to_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let len2 = dot(ab, ab);
  if (len2 < 1e-10) { return length(p - a); }
  let t = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
  return length(p - a - ab * t);
}
`

/** Distance to quadratic bezier (16-step sample). */
export const WGSL_DIST_TO_QUADRATIC = /* wgsl */ `
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
`

/** Distance to cubic bezier (24-step sample). */
export const WGSL_DIST_TO_CUBIC = /* wgsl */ `
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
`

/** Winding number contribution from a line segment (horizontal ray cast). */
export const WGSL_WINDING_LINE = /* wgsl */ `
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
`

/**
 * SDF shape sampler — reads from ShapeRegistry storage buffers.
 * Requires the caller to declare:
 *   @group(0) @binding(N) var<storage, read> shapes: array<ShapeDesc>;
 *   @group(0) @binding(M) var<storage, read> segments: array<Segment>;
 * and the corresponding struct definitions.
 */
export const WGSL_SDF_SHAPE = /* wgsl */ `
fn sdf_shape(uv_in: vec2f, shape_id: u32) -> f32 {
  // Flip Y: NDC Y-up → SVG/path Y-down convention
  let uv = vec2f(uv_in.x, -uv_in.y);
  let s = shapes[shape_id];

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
        min_dist = min(min_dist, dist_to_segment(uv, seg.p0, seg.p1));
        winding += winding_line(uv, seg.p0, seg.p1);
      }
      case 1u: {
        min_dist = min(min_dist, dist_to_quadratic(uv, seg.p0, seg.p1, seg.p2));
        winding += winding_line(uv, seg.p0, seg.p2);
      }
      case 2u: {
        min_dist = min(min_dist, dist_to_cubic(uv, seg.p0, seg.p1, seg.p2, seg.p3));
        winding += winding_line(uv, seg.p0, seg.p3);
      }
      default: {}
    }
  }

  if (winding != 0) { return 1.0 - min_dist; }
  return 1.0 + min_dist;
}
`

/** Shape storage struct definitions (match TypeScript layout in sdf-shape.ts). */
export const WGSL_SHAPE_STRUCTS = /* wgsl */ `
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

struct ShapeSegment {
  kind: u32,
  color_idx: u32,
  flags: u32,
  _pad: u32,
  p0: vec2f,
  p1: vec2f,
  p2: vec2f,
  p3: vec2f,
}
`

/** All SDF snippets combined (for line renderer convenience). */
export const WGSL_SDF_ALL =
  WGSL_DIST_TO_SEGMENT +
  WGSL_DIST_TO_QUADRATIC +
  WGSL_DIST_TO_CUBIC +
  WGSL_WINDING_LINE
