// ═══ X-GIS Map Renderer — WebGPU ═══

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { MeshData, LineMeshData } from '../loader/geojson'
import { generateGraticule } from './graticule'
import {
  BLEND_ALPHA, STENCIL_WRITE, STENCIL_TEST,
  STENCIL_WRITE_NO_DEPTH, STENCIL_TEST_NO_DEPTH,
  STENCIL_CLIPMASK_WRITE,
  BLEND_OIT_ACCUM, BLEND_OIT_REVEALAGE,
  OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT,
  MSAA_4X, WORLD_MERC, worldCopiesFor,
} from './gpu-shared'
import { isPickEnabled, getSampleCount } from './gpu'
import { WGSL_LOG_DEPTH_FNS } from './wgsl-log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from './wgsl-projection'

// generateGraticule(zoom) now handles zoom-adaptive steps internally

// ═══ Shader Source ═══

const POLYGON_SHADER = /* wgsl */ `
${WGSL_PROJECTION_CONSTS}
${WGSL_LOG_DEPTH_FNS}

struct Uniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  // projection params: x=type, y=centerLon, z=centerLat, w=unused
  proj_params: vec4<f32>,
  // DSFUN camera position in tile-local Mercator meters, split high/low.
  // cam_h + cam_l = splitF64(cam_merc - tile_origin_merc), computed CPU-side
  // per tile per frame. The vertex shader computes
  //   rel = (pos_h - cam_h) + (pos_l - cam_l)
  // which cancels the tile-origin magnitude and preserves f64-equivalent
  // precision at any camera zoom.
  cam_h: vec2<f32>,
  cam_l: vec2<f32>,
  // Absolute tile origin in Mercator meters (for non-Mercator reconstruction).
  tile_origin_merc: vec2<f32>,
  opacity: f32,
  // Logarithmic depth factor: 1.0 / log2(camera_far + 1.0).
  // Packed by the renderer each frame; shaders use it to rewrite
  // position.z and frag_depth for Three.js-equivalent log depth.
  log_depth_fc: f32,
  // Packed pick ID: low16 = layerId (1..65535, 0 = no layer),
  // high16 = instanceId (reserved for WORLD_COPIES). Written into
  // the RG32Uint pick texture G channel via the __PICK_WRITE__
  // template substitution.
  pick_id: u32,
  // Per-layer NDC-z bias to disambiguate coplanar fills under log-depth.
  // All polygon layers draw at z=0 (ground plane); at high pitch the
  // log-depth precision compresses (~10 effective bits at pitch 85°),
  // so coplanar fragments fight. Subtracting layer_depth_offset times
  // position.w from clip-space z shifts NDC z by layer_depth_offset,
  // making later layers always win the LEQUAL test. Caller sets this
  // to a small per-layer multiple (e.g. layerIndex * 1e-4). Positive
  // offset pushes the layer toward the camera (right-handed NDC z;
  // negative is near).
  // WGSL rounds struct size up to the largest member alignment (16,
  // from mat4x4 / vec4) so the now-two trailing 4-byte fields pad the
  // struct to a 160-byte total — same size as before.
  layer_depth_offset: f32,
  // Phase B vertex-compression: tile-local-meters extent of one tile
  // at this tile's zoom. Used by vs_main_quantized to dequant the
  // unorm16x2 polygon vertex back to local Mercator meters:
  //   local_m = pos_norm * tile_extent_m
  // tile_extent_m = 2π × R_earth / 2^tileZoom — written CPU-side per
  // tile per frame, packs into the existing uniform slot pad without
  // growing the struct past 160 bytes.
  tile_extent_m: f32,
  // 3D-extrusion height in METERS in world space. 0 = flat (default).
  // vs_main_quantized lifts the polygon vertex by this height in the
  // world-z direction; mvp transforms to clip space respecting camera
  // pitch. MVP for buildings: a constant per-layer height (e.g. 50m)
  // so polygons lift uniformly. Per-feature heights via PropertyTable
  // are a future extension.
  extrude_height_m: f32,
  // Per-tile clip mask in absolute Mercator meters (west, south,
  // east, north). Fragment shader discards if the fragment's world
  // position falls outside this rect. Used to clip parent-ancestor
  // fallback rendering to the visible tile area it's filling — a
  // z=11 parent's geometry covers a 16×16 z=15 child area, but for
  // any one visible-tile fallback only ONE child's worth should
  // render. Without clip the parent renders over neighboring
  // children too (some primary-loaded with their own buildings),
  // causing cross-z depth fights and "wrong building wins".
  //
  // Sentinel: clip_bounds.x (west) == -1e30 → no clip (skip
  // discard). Used for primary tiles where own geometry already
  // stays within own bounds — the fragment-shader cost would be
  // pure waste. Caller writes -1e30 for primary, real bounds for
  // fallback.
  //
  // Industry-standard equivalent: MapLibre's per-tile stencil ID
  // pre-pass + stencil-test at draw time. We use fragment discard
  // for the 1st-pass implementation (smaller refactor, same
  // visual outcome). Migration to hardware stencil is a follow-up
  // perf optimisation.
  clip_bounds: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

${WGSL_PROJECTION_FNS}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) cos_c: f32,
  @location(1) @interpolate(flat) feat_id: u32,
  @location(2) abs_lat: f32,
  // view_w = pre-division clip-space w. Fragment shader recomputes
  // log-depth per pixel from this (linear interpolation of log2 over
  // a triangle would drift otherwise).
  @location(3) view_w: f32,
  // 3D extrusion shading factor. is_top=1 (roof) → 1.0; is_top=0
  // (wall bottom) → 0.0; the value interpolates 0..1 along wall
  // triangles. Fragment uses to mix between dark wall + bright
  // roof colour for a poor-man's Lambert without a real normal.
  @location(4) wall_blend: f32,
  // Absolute mercator world position. Forwarded from the vertex
  // shader so the fragment can clip-test against u.clip_bounds.
  // Costs 8 bytes per vertex output but avoids reconstructing the
  // world position from view_w in the fragment.
  @location(5) abs_merc_x: f32,
  @location(6) abs_merc_y: f32,
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  __PICK_FIELD__
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs_main(
  @location(0) pos_h: vec2<f32>,
  @location(1) pos_l: vec2<f32>,
  @location(2) feature_id: f32,
) -> VertexOutput {
  // DSFUN Mercator subtraction — camera-relative tile-local meters.
  // (pos_h - cam_h) + (pos_l - cam_l) = pos_f64 - cam_f64 with f64-equivalent
  // precision, because the large tile-origin magnitude cancels before the low
  // parts are added.
  let rel = (pos_h - u.cam_h) + (pos_l - u.cam_l);

  // Reconstruct absolute Mercator meters (needed for non-Mercator
  // reprojection and for the fragment discard at |lat| > MERCATOR_LAT_LIMIT).
  let abs_merc_x = (pos_h.x + pos_l.x) + u.tile_origin_merc.x;
  let abs_merc_y = (pos_h.y + pos_l.y) + u.tile_origin_merc.y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  let abs_lat_clamped = clamp(abs_lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);

  var rtc: vec2<f32>;
  let t = u.proj_params.x;
  if (t < 0.5) {
    // Pure Mercator: rel is already camera-relative meters.
    rtc = rel;
  } else {
    // All other projections (equirect, natural earth, ortho, ...):
    // run the same project() as before but on the reconstructed absolute
    // lon/lat, then subtract the projected camera center. Precision here is
    // limited to the f32 reconstruction, which is fine because non-Mercator
    // projections are only used at low/global zoom.
    // NOTE: avoid the reserved word "target" as an identifier.
    let proj_xy = project(abs_lon, abs_lat, u.proj_params);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }

  var out: VertexOutput;
  let clip = u.mvp * vec4<f32>(rtc, 0.0, 1.0);
  // Log-depth rewrite of clip.z. Three.js equivalent — preserves near-plane
  // precision at high pitch and when rendering 3D geometry.
  out.position = apply_log_depth(clip, u.log_depth_fc);
  // Per-layer z bias (see Uniforms.layer_depth_offset). Multiplied by
  // post-projection w so the NDC-z shift is constant across the depth
  // range (perspective-divide cancels the w factor).
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  out.cos_c = needs_backface_cull(abs_lon, abs_lat, u.proj_params);
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  out.wall_blend = 1.0; // DSFUN line pipeline isn't extruded; full brightness
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  return out;
}

// Phase B quantized polygon vertex entry. Reads pos_raw (uint16x2 →
// vec2<u32> in shader) and unpacks:
//   - bit 15 of x  : is_top flag (3D extrusion side-wall support)
//   - bits 0-14    : 15-bit position quanta in [0, 32767]
//
// The 1-bit precision sacrifice on x (32767 vs 65535 quanta over a
// tile) is sub-pixel even at zoom 22 (9.5 m / 32767 ≈ 0.29 mm) so
// invisible in any rendering.
//
// Bottom and top vertices share the same x,y; only the is_top flag
// differs. vs_main_quantized lifts top vertices to z=extrude_height_m
// in world space; bottom vertices stay on the ground plane (z=0).
// Side walls between (a_bot, b_bot, a_top, b_top) thus form a vertical
// quad without needing a separate vertex format or pipeline.
@vertex
fn vs_main_quantized(
  @location(0) pos_raw: vec2<u32>,
  @location(2) feature_id: f32,
) -> VertexOutput {
  let is_top = (pos_raw.x & 0x8000u) != 0u;
  let mx_q = f32(pos_raw.x & 0x7FFFu);
  let my_q = f32(pos_raw.y);
  let local = vec2<f32>(mx_q, my_q) / 32767.0 * u.tile_extent_m;
  // cam_h + cam_l = cam_merc - tile_origin_merc (set CPU-side). Sum
  // here is fine because we are already at tile-local scale where Float32
  // suffices. Same downstream as vs_main from rel onward.
  let cam_local = u.cam_h + u.cam_l;
  let rel = local - cam_local;

  let abs_merc_x = local.x + u.tile_origin_merc.x;
  let abs_merc_y = local.y + u.tile_origin_merc.y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  let abs_lat_clamped = clamp(abs_lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);

  var rtc: vec2<f32>;
  let t = u.proj_params.x;
  if (t < 0.5) {
    rtc = rel;
  } else {
    let proj_xy = project(abs_lon, abs_lat, u.proj_params);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }

  var out: VertexOutput;
  // 3D extrusion: top vertices lift to z=extrude_height_m, bottom
  // stay at z=0. Wall quads (a_bot, b_bot, a_top, b_top) form
  // vertical sides; top-face polygons all carry is_top=1. Non-
  // extruded layers set extrude_height_m=0 → both branches yield
  // z=0 → identical to the flat path.
  let z_world = select(0.0, u.extrude_height_m, is_top);
  let clip = u.mvp * vec4<f32>(rtc, z_world, 1.0);
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  out.cos_c = needs_backface_cull(abs_lon, abs_lat, u.proj_params);
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  // Wall shading only meaningful when this layer is extruded; for
  // flat layers all geometry is at the roof brightness.
  out.wall_blend = select(1.0, select(0.0, 1.0, is_top), u.extrude_height_m > 0.0);
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  return out;
}

// Per-feature 3D extrusion entry. Same as vs_main_quantized but z
// comes from a parallel vertex buffer (location 3) instead of
// is_top times u.extrude_height_m. Bound when the upload path took
// the *Extruded mesh-gen variants — i.e. an MVT slice that carried
// per-feature render_height / height properties.
//
// wall_blend is derived from the z attribute: z>0 -> 1.0 (top / roof),
// z=0 -> 0.0 (bottom of wall). Roof faces get full brightness; walls
// fade from base to roof exactly like the uniform path.
@vertex
fn vs_main_quantized_extruded(
  @location(0) pos_raw: vec2<u32>,
  @location(2) feature_id: f32,
  @location(3) z_attr: f32,
) -> VertexOutput {
  let mx_q = f32(pos_raw.x & 0x7FFFu);
  let my_q = f32(pos_raw.y);
  let local = vec2<f32>(mx_q, my_q) / 32767.0 * u.tile_extent_m;
  let cam_local = u.cam_h + u.cam_l;
  let rel = local - cam_local;

  let abs_merc_x = local.x + u.tile_origin_merc.x;
  let abs_merc_y = local.y + u.tile_origin_merc.y;
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  let abs_lat_clamped = clamp(abs_lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);

  var rtc: vec2<f32>;
  let t = u.proj_params.x;
  if (t < 0.5) {
    rtc = rel;
  } else {
    let proj_xy = project(abs_lon, abs_lat, u.proj_params);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }

  var out: VertexOutput;
  let clip = u.mvp * vec4<f32>(rtc, z_attr, 1.0);
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  out.cos_c = needs_backface_cull(abs_lon, abs_lat, u.proj_params);
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  out.wall_blend = select(0.0, 1.0, z_attr > 0.0);
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  return out;
}

// ── Fragment shaders (replaceable by ShaderVariant) ──
// FILL_EXPR and STROKE_EXPR are replaced by buildShader() when a variant exists

@fragment
fn fs_fill(input: VertexOutput) -> FragmentOutput {
  if (input.cos_c < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask. When this draw is filling for a specific
  // visible tile (typically a fallback parent ancestor covering a
  // visible child), discard fragments whose mercator world position
  // falls outside that visible tile's mercator extent. Sentinel
  // u.clip_bounds.x == -1e30 means "no clip" — fast path for primary
  // tiles whose own geometry already stays within own bounds.
  if (u.clip_bounds.x > -1e29) {
    if (input.abs_merc_x < u.clip_bounds.x) { discard; }
    if (input.abs_merc_x > u.clip_bounds.z) { discard; }
    if (input.abs_merc_y < u.clip_bounds.y) { discard; }
    if (input.abs_merc_y > u.clip_bounds.w) { discard; }
  }
  var out: FragmentOutput;
  // Wall shading: bottom of wall (wall_blend=0) gets a darker
  // version of fill_color, roof (wall_blend=1) full brightness.
  // Linear interp along wall triangles from 0 at base to 1 at top.
  let wall_shade = 0.55 + 0.45 * input.wall_blend;
  out.color = vec4<f32>(u.fill_color.rgb * wall_shade, u.fill_color.a);
  __PICK_WRITE__
  // Per-feature deterministic depth jitter to break coplanar z-fights
  // at shared walls between adjacent buildings. Two buildings that
  // share an edge each emit a wall along that edge at z=0..min(H_A,
  // H_B) — fragments at the same screen pixel on both walls compute
  // the same view_w, so log-depth is identical and the GPU resolves
  // the tie from per-pixel rasterisation noise (visible "sparkle"
  // along the shared base, reported by user at Tokyo z=16.33
  // pitch=63.5°). A tiny per-feat_id offset shifts each feature's
  // depth by a deterministic amount well below visible pixel scale,
  // so adjacent walls always have a consistent winner.
  //   range: ±FEAT_DEPTH_JITTER ≈ ±1.5e-5 NDC z (24-bit depth = 6e-8
  //   per unit → ~250 depth units, sub-pixel visually).
  // Only applied when feat_id is non-zero — synthetic pseudo-features
  // (background quads etc.) keep the canonical log-depth result.
  //
  // Bitwise hash (xor-shift mix) on the LOW 16 bits of feat_id
  // avoids u32 multiplication overflow that some implementations
  // (notably Apple Metal under iOS Safari) treat as a shader-
  // validation error. Pure shifts + xor stay strictly within the
  // unsigned domain WGSL specifies as wrap-on-overflow.
  let base_depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  let id_lo = input.feat_id & 0xFFFFu;
  let mixed = (id_lo ^ (id_lo >> 7u) ^ (id_lo << 3u)) & 0x3FFu; // 0..1023
  let jitter = select(
    0.0,
    (f32(mixed) - 512.0) * 1.5e-8,
    input.feat_id != 0u,
  );
  out.depth = base_depth + jitter;
  return out;
}

// Weighted Blended OIT (McGuire-Bavoil 2013) translucent fill output.
// Writes to two MRT slots:
//   @location(0) accum:     vec4<f32> = (rgb·a·w, a·w)   [BLEND_ADD]
//   @location(1) revealage: f32        = a               [BLEND mul-by-1-src]
// The compose pass divides accum.rgb by accum.a to recover the
// weighted-average colour, and uses (1 - product_of_(1-a)) as the
// over-blend alpha onto the opaque framebuffer.
//
// Weight function: McGuire-Bavoil 7.4. The view-w-dependent term
// biases small-z fragments to dominate, matching what painter's
// order would do for clearly-front-most geometry. Clamping prevents
// degenerate cases (very small / very large weights breaking the
// running sums in fp16).
struct OitFragmentOutput {
  @location(0) accum: vec4<f32>,
  @location(1) revealage: f32,
}

@fragment
fn fs_oit_translucent(input: VertexOutput) -> OitFragmentOutput {
  if (input.cos_c < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask (see fs_fill).
  if (u.clip_bounds.x > -1e29) {
    if (input.abs_merc_x < u.clip_bounds.x) { discard; }
    if (input.abs_merc_x > u.clip_bounds.z) { discard; }
    if (input.abs_merc_y < u.clip_bounds.y) { discard; }
    if (input.abs_merc_y > u.clip_bounds.w) { discard; }
  }
  let wall_shade = 0.55 + 0.45 * input.wall_blend;
  let rgb = u.fill_color.rgb * wall_shade;
  let a = u.fill_color.a;
  if (a <= 0.001) { discard; }
  // McGuire-Bavoil weight: large for closer (smaller view_w) and
  // smaller alpha contributions, capped to avoid float overflow.
  let z = max(input.view_w, 1e-3);
  let w = clamp(0.03 / (1e-5 + pow(z / 200.0, 4.0)), 1e-2, 3.0e3);
  var out: OitFragmentOutput;
  out.accum = vec4<f32>(rgb * a, a) * w;
  out.revealage = a;
  return out;
}

@fragment
fn fs_stroke(input: VertexOutput) -> FragmentOutput {
  if (input.cos_c < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask (see fs_fill).
  if (u.clip_bounds.x > -1e29) {
    if (input.abs_merc_x < u.clip_bounds.x) { discard; }
    if (input.abs_merc_x > u.clip_bounds.z) { discard; }
    if (input.abs_merc_y < u.clip_bounds.y) { discard; }
    if (input.abs_merc_y > u.clip_bounds.w) { discard; }
  }
  // feat_id > 0 = major grid line (brighter), 0 = minor (dimmer)
  let alpha_scale = select(0.4, 1.0, input.feat_id > 0u);
  var out: FragmentOutput;
  out.color = vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);
  __PICK_WRITE__
  out.depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  return out;
}
`

// Fragment markers for template replacement. Match the entire
// `out.color = ...;` assignment in fs_fill / fs_stroke so variants can
// swap in a data-driven color expression without touching the FragmentOutput
// plumbing or the log-depth write.
const FILL_RETURN_MARKER = 'out.color = u.fill_color;'
const STROKE_RETURN_MARKER = 'out.color = vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);'

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
  /** Depth-disabled (`STENCIL_WRITE_NO_DEPTH`) mirror of `fillPipeline`
   *  for `extrude.kind === 'none'` ground layers. Coplanar painter's-
   *  order resolve depends on no draw writing depth — same role as the
   *  unconditional `fillPipelineGround` (renderer.ts:983), but bound
   *  to this variant's pipeline layout so feature-buffer-driven
   *  ground layers can use the painter's-order path too. */
  fillPipelineGround: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback: GPURenderPipeline
  /** Depth-disabled fallback (`STENCIL_TEST_NO_DEPTH`) for the
   *  parent-ancestor draw path. Mirrors `fillPipelineGround` but with
   *  stencil-test (only draws where current-zoom hasn't already
   *  filled). */
  fillPipelineGroundFallback: GPURenderPipeline
  linePipelineFallback: GPURenderPipeline
  /** Pickable=false mirror set: identical except `writeMask: 0` on the
   *  RG32Uint pick attachment, so layers with `pointer-events: none`
   *  draw their color but leave the pick texture's prior contents
   *  intact (picks fall through to the layer beneath). When picking is
   *  globally disabled, these alias the pickable pipelines (the
   *  colorTargets have no pick attachment so the writeMask is moot). */
  fillPipelineNoPick: GPURenderPipeline
  fillPipelineGroundNoPick: GPURenderPipeline
  linePipelineNoPick: GPURenderPipeline
  fillPipelineFallbackNoPick: GPURenderPipeline
  fillPipelineGroundFallbackNoPick: GPURenderPipeline
  linePipelineFallbackNoPick: GPURenderPipeline
}

/**
 * Build a specialized WGSL shader by injecting variant's preamble and expressions.
 */
function buildShader(variant?: ShaderVariantInfo | null): string {
  // Strip (or inject) the pick template markers BEFORE any other substitution
  // so variant pipelines see the same conditional output as the default path.
  // Default build (PICK=false) replaces both markers with empty strings so
  // the resulting WGSL is byte-identical to the pre-picking shader.
  const applyPick = (src: string): string => src
    .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
    .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(input.feat_id, u.pick_id);' : '')

  if (!variant || (!variant.preamble && !variant.needsFeatureBuffer)) return applyPick(POLYGON_SHADER)

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

  // Replace fragment color assignments (feat_data indexing is inlined in
  // expressions). The log-depth write after this assignment is untouched.
  if (variant.fillExpr && variant.fillExpr !== 'u.fill_color') {
    const matchCode = (variant as any).fillPreamble ? `${(variant as any).fillPreamble}  ` : ''
    shader = shader.replace(FILL_RETURN_MARKER, `${matchCode}out.color = ${variant.fillExpr};`)
  }
  if (variant.strokeExpr && variant.strokeExpr !== 'u.stroke_color') {
    const matchCode = (variant as any).strokePreamble ? `${(variant as any).strokePreamble}  ` : ''
    shader = shader.replace(STROKE_RETURN_MARKER, `${matchCode}out.color = ${variant.strokeExpr};`)
  }

  return applyPick(shader)
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

/** Easing function used between adjacent time-interpolated stops. */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface ShowCommand {
  targetName: string
  /** DSL layer name (`layer <name> { source: <target> | ... }`). Used
   *  by `map.getLayer(name)` and `LayerIdRegistry` so two layers
   *  drawing the same source still resolve to distinct `XGISLayer`
   *  wrappers. Legacy syntax that lacks a separate layer name reuses
   *  `targetName`. */
  layerName?: string
  /** Optional MVT layer slice within the source. When set, the
   *  catalog returns only that slice's TileData and the renderer
   *  draws only its geometry. Mapbox-style `source-layer` semantics
   *  (camelCase here for lexer compatibility). */
  sourceLayer?: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  /** Optional per-feature stroke-width override AST. Set by the
   *  compiler's mergeLayers pass when folding same-source-layer xgis
   *  layers with different widths. The MVT worker evaluates this AST
   *  against each feature's properties and writes the resolved width
   *  into the line segment buffer's per-segment slot; the shader
   *  picks `segment.width_px` over the layer uniform when non-zero. */
  strokeWidthExpr?: { ast: unknown }
  /** Optional per-feature stroke-colour override AST. Mirror of
   *  strokeWidthExpr; the worker resolves per feature, packs RGBA8
   *  into a u32, and writes it into the line segment buffer's
   *  `color_packed` slot. Line shader unpacks and uses when alpha > 0. */
  strokeColorExpr?: { ast: unknown }
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' marks the layer as non-
   *  pickable so the writeMask:0 pipeline variant skips its pickId
   *  write — picks fall through to the layer beneath. 'auto' (default)
   *  is fully pickable. */
  pointerEvents?: 'auto' | 'none'
  opacity: number
  size?: number | null
  zoomOpacityStops?: { zoom: number; value: number }[] | null
  zoomSizeStops?: { zoom: number; value: number }[] | null
  // ── Animation (PR 1: opacity; PR 3: color/width/size/dashoffset) ──
  //
  // Every animatable property carries a parallel time-stop list.
  // Shared loop/easing/delayMs come from the single `animation-<name>`
  // reference on the layer — one animation block drives every stop
  // list, even cross-property.
  timeOpacityStops?: { timeMs: number; value: number }[] | null
  timeFillStops?: { timeMs: number; value: [number, number, number, number] }[] | null
  timeStrokeStops?: { timeMs: number; value: [number, number, number, number] }[] | null
  timeStrokeWidthStops?: { timeMs: number; value: number }[] | null
  timeSizeStops?: { timeMs: number; value: number }[] | null
  timeDashOffsetStops?: { timeMs: number; value: number }[] | null
  timeOpacityLoop?: boolean
  timeOpacityEasing?: Easing
  timeOpacityDelayMs?: number
  // Per-frame animated overrides. Populated by map.ts
  // classifyVectorTileShows() when an animation is active, so VTR and
  // line-renderer don't need to know about time stops — they just read
  // the pre-resolved value. Bypasses VTR's hex-string parse cache.
  resolvedFillRgba?: [number, number, number, number] | null
  resolvedStrokeRgba?: [number, number, number, number] | null
  shaderVariant?: { key: string; preamble: string; fillExpr: string; strokeExpr: string; fillPreamble?: string; strokePreamble?: string; needsFeatureBuffer: boolean; featureFields: string[]; uniformFields: string[] } | null
  filterExpr?: { ast: unknown } | null  // AST expression for per-feature filtering
  geometryExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  sizeUnit?: string | null
  billboard?: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape?: string | null
  shapeDefs?: { name: string; paths: string[] }[]
  /** 3D extrusion height. Set by the compiler from the layer's
   *  `extrude:` keyword; VTR branches its upload + fill draw onto
   *  the extruded pipeline when `kind !== 'none'`. The feature form
   *  carries an AST expression (any shape — field access, binary,
   *  function call) that the MVT worker evaluates per feature. */
  extrude?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
  /** Mapbox `fill-extrusion-base` — wall bottom z. Same shape as
   *  `extrude`; default `none` (=> z=0 ground). */
  extrudeBase?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
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
  // Stable u16 layer ID assigned by `XGISMap` via `LayerIdRegistry` after
  // the compiler emits this command. Threaded into every per-tile uniform
  // write so the fragment shader can stamp the pick texture's G channel
  // with `(instanceId << 16) | layerId`. 0 = unregistered (sentinel).
  pickId?: number
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
  // Animation time-stop lists. Populated from ShowCommand.time*Stops
  // in addLayer(). Null means "no animation for this property".
  timeOpacityStops: { timeMs: number; value: number }[] | null
  timeFillStops: { timeMs: number; value: [number, number, number, number] }[] | null
  timeStrokeStops: { timeMs: number; value: [number, number, number, number] }[] | null
  timeStrokeWidthStops: { timeMs: number; value: number }[] | null
  timeSizeStops: { timeMs: number; value: number }[] | null
  timeDashOffsetStops: { timeMs: number; value: number }[] | null
  timeOpacityLoop: boolean
  timeOpacityEasing: Easing
  timeOpacityDelayMs: number
  // Per-layer specialized pipelines (null = use shared default)
  fillPipeline: GPURenderPipeline | null
  linePipeline: GPURenderPipeline | null
  // Per-feature data
  featureDataBuffer: GPUBuffer | null
  perLayerBindGroup: GPUBindGroup | null
  // Stable u16 layer ID assigned by `LayerIdRegistry`, written into the
  // pick texture's G channel via `u.pick_id` so `pickAt()` can route the
  // hit back to the owning layer. 0 means "not registered" (sentinel).
  pickId: number
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

/** Easing functions applied between adjacent time stops. Maps t∈[0,1] → [0,1]. */
const EASING_LUT: Record<Easing, (t: number) => number> = {
  'linear':      (t) => t,
  'ease-in':     (t) => t * t,
  'ease-out':    (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
}

/**
 * Linearly interpolate between sorted time stops, with easing applied to
 * the per-segment t. Mirrors interpolateZoom() but operates on milliseconds
 * instead of zoom levels, and supports loop / delay / easing semantics.
 *
 * - `elapsedMs` is the global wall clock since animation start
 * - `loop=true` wraps elapsed modulo the last stop's timeMs
 * - `delayMs` is subtracted before sampling (may be negative to "start mid")
 * - `easing` warps the per-segment t before the lerp
 *
 * Returns the first stop's value when no stops exist or we're before the
 * first stop (after delay adjustment). Returns the last stop's value when
 * we're past the end and loop=false.
 */
export function interpolateTime(
  stops: { timeMs: number; value: number }[],
  elapsedMs: number,
  loop: boolean,
  easing: Easing,
  delayMs: number,
): number {
  if (stops.length === 0) return 1.0
  const effective = elapsedMs - delayMs
  if (effective < 0) return stops[0].value
  const last = stops[stops.length - 1].timeMs
  const t = loop && last > 0 ? effective % last : Math.min(effective, last)
  if (t <= stops[0].timeMs) return stops[0].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].timeMs && t <= stops[i + 1].timeMs) {
      const span = stops[i + 1].timeMs - stops[i].timeMs
      if (span === 0) return stops[i + 1].value
      const raw = (t - stops[i].timeMs) / span
      const k = EASING_LUT[easing](raw)
      return stops[i].value + k * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

/**
 * Componentwise-RGB version of interpolateTime for color animations.
 * Writes the interpolated value into `out` (caller-provided, avoids
 * per-frame allocations) and returns it.
 *
 * Uses naive linear RGB lerp. A future PR may add per-keyframes
 * colorspace annotations (e.g. `in oklch`) — that's noted as out of
 * scope in the animation roadmap.
 */
export function interpolateTimeColor(
  stops: { timeMs: number; value: [number, number, number, number] }[],
  elapsedMs: number,
  loop: boolean,
  easing: Easing,
  delayMs: number,
  out: [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number, number] {
  if (stops.length === 0) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return out }
  const effective = elapsedMs - delayMs
  if (effective < 0) {
    const v = stops[0].value
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
    return out
  }
  const last = stops[stops.length - 1].timeMs
  const t = loop && last > 0 ? effective % last : Math.min(effective, last)
  if (t <= stops[0].timeMs) {
    const v = stops[0].value
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
    return out
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].timeMs && t <= stops[i + 1].timeMs) {
      const span = stops[i + 1].timeMs - stops[i].timeMs
      if (span === 0) {
        const v = stops[i + 1].value
        out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
        return out
      }
      const raw = (t - stops[i].timeMs) / span
      const k = EASING_LUT[easing](raw)
      const a = stops[i].value, b = stops[i + 1].value
      out[0] = a[0] + k * (b[0] - a[0])
      out[1] = a[1] + k * (b[1] - a[1])
      out[2] = a[2] + k * (b[2] - a[2])
      out[3] = a[3] + k * (b[3] - a[3])
      return out
    }
  }
  const v = stops[stops.length - 1].value
  out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
  return out
}

// ═══ MapRenderer ═══

export class MapRenderer {
  private ctx: GPUContext
  // Cached per-frame allocation (avoid GC pressure in render loop)
  private uniformDataBuf = new ArrayBuffer(160)
  // Dynamic-offset uniform ring (see docs: multi-layer uniform slots)
  private static readonly UNIFORM_SLOT = 256
  /** CPU-side mirror of uniformBuffer. Each draw's uniform block is
   *  copied into this staging buffer and a dirty range tracked; one
   *  writeBuffer per frame flushes the range. Saves ~1000 per-frame
   *  writeBuffer calls in the fixture audit's stress-many-layers
   *  scenario. Mirrors the VTR + LineRenderer pattern. */
  private uniformStaging = new Uint8Array(0)
  private uniformDirtyLo = 0
  private uniformDirtyHi = 0
  // Polygon Uniforms struct grew from 160 to 176 bytes when
  // `clip_bounds: vec4<f32>` was added for per-tile clip masking
  // (parent fallback z=11 ancestor's geometry clipped to the missing
  // z=15 child's screen extent so cross-z overlaps don't fight at
  // log-depth precision). WGSL spec requires bind group binding
  // ranges ≥ struct size + multiple of 16.
  private static readonly UNIFORM_SIZE = 176
  private uniformRingCapacity = 256 // slots
  private uniformSlot = 0
  fillPipeline!: GPURenderPipeline
  /** Ground-layer fill — identical to fillPipeline except depth
   *  test/write are off. Selected at draw time for any layer whose
   *  `extrude.kind === 'none'` so coplanar fills resolve via plain
   *  painter's order (GPU command submission), not the fragile
   *  layer_depth_offset NDC bias. */
  fillPipelineGround!: GPURenderPipeline
  /** Per-feature 3D extrusion variant of fillPipeline — identical
   *  except entryPoint=`vs_main_quantized_extruded` and a second
   *  vertex buffer slot for the per-vertex z attribute. Used by the
   *  fill-draw branch when a tile slice carries `heights` (e.g.
   *  protomaps `buildings` with `render_height`). */
  fillPipelineExtruded!: GPURenderPipeline
  /** Weighted-Blended OIT translucent extrude fill. Renders into
   *  `oitAccumTexture` + `oitRevealageTexture` so multiple
   *  translucent buildings composite without back-to-front sort.
   *  The OIT compose pipeline reads both targets back into the
   *  resolved main color afterward. */
  fillPipelineExtrudedOIT!: GPURenderPipeline
  /** Compose pipeline for the Weighted-Blended OIT pair. Samples
   *  `oitAccumTexture` + `oitRevealageTexture` and over-blends the
   *  recovered translucent color onto the opaque framebuffer. */
  oitComposePipeline!: GPURenderPipeline
  oitComposeBindGroupLayout!: GPUBindGroupLayout
  linePipeline!: GPURenderPipeline
  // Stencil-test pipelines: only draw where stencil = 0 (not covered by children)
  fillPipelineFallback!: GPURenderPipeline
  fillPipelineGroundFallback!: GPURenderPipeline
  fillPipelineExtrudedFallback!: GPURenderPipeline
  linePipelineFallback!: GPURenderPipeline
  // `pointer-events: none` mirrors — same shader, writeMask:0 on the
  // pick attachment so the layer's pickId never lands in the pick
  // texture. Identity-aliased to the pickable set when picking is
  // globally disabled (no pick attachment to mask).
  fillPipelineNoPick!: GPURenderPipeline
  fillPipelineGroundNoPick!: GPURenderPipeline
  fillPipelineExtrudedNoPick!: GPURenderPipeline
  linePipelineNoPick!: GPURenderPipeline
  fillPipelineFallbackNoPick!: GPURenderPipeline
  fillPipelineGroundFallbackNoPick!: GPURenderPipeline
  fillPipelineExtrudedFallbackNoPick!: GPURenderPipeline
  linePipelineFallbackNoPick!: GPURenderPipeline
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

  /** Rebuild all pipelines + invalidate shader variant cache. Called by
   *  `map.setQuality()` when MSAA or picking flip at runtime — both force
   *  a pipeline `sampleCount` / fragment-target-count change that's baked
   *  at pipeline creation. Non-pipeline state (bind group layouts, the
   *  uniform ring, graticule geometry) survives the rebuild unchanged. */
  rebuildForQuality(): void {
    // Toss the per-show variant pipelines — their shader embeds the
    // PICK markers too, and their `multisample.count` is frozen. A new
    // variant pipeline will be recreated lazily on the next frame's
    // render when `getOrCreateVariantPipelines` sees a cache miss.
    this.shaderCache.clear()
    this.initPipelines()
  }

  private initPipelines(): void {
    const { device, format } = this.ctx

    // Splice the pick output into the shader template when `?picking=1`
    // is enabled. Keeps the default (no-pick) shader byte-identical with
    // the prior build — existing deployments see no change.
    const pickShader = POLYGON_SHADER
      .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
      .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(input.feat_id, u.pick_id);' : '')
    const shaderModule = device.createShaderModule({
      code: pickShader,
      label: 'xgis-shader',
    })

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'mr-baseBindGroupLayout',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      }],
    })

    this.featureBindGroupLayout = device.createBindGroupLayout({
      label: 'mr-featureBindGroupLayout',
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
      label: 'mr-mainPipelineLayout(base-only)',
      bindGroupLayouts: [this.bindGroupLayout],
    })

    // Phase B quantized polygon vertex: [u16 mx, u16 my, f32 feat_id]
    // — stride 8 bytes, 60% smaller than the DSFUN stride 20 used by
    // line geometry. Pipeline binds this layout to vs_main_quantized
    // which dequants via u.tile_extent_m.
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'uint16x2' as GPUVertexFormat },
        { shaderLocation: 2, offset: 4, format: 'float32'   as GPUVertexFormat },
      ],
    }
    // Parallel z attribute (slot 1) for the per-feature extrusion
    // pipeline — one float per polygon vertex, 0 for wall bottoms,
    // feature-height for wall tops + roof faces. Bound only when the
    // tile's slice carries `heights`.
    const extrudedZBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 4,
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32' as GPUVertexFormat },
      ],
    }
    // DSFUN line vertex: [mx_h, my_h, mx_l, my_l, feat_id, arc_start] — stride 24 bytes.
    // arc_start lives at offset 20; the vertex shader ignores it (the SDF
    // LineRenderer reads it via the segment storage buffer), but keeping it
    // in the VB means the same typed-array lays out for both paths.
    const lineVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0,  format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8,  format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 2, offset: 16, format: 'float32'   as GPUVertexFormat },
      ],
    }

    // Pipeline color target list. When picking is on, append an RG32Uint
    // target at location 1 that the fragment shader's out.pick writes into.
    // `writeMask: ALL` is default — uint formats ignore blend state.
    // For `pointer-events: none` layers we build a parallel set with
    // `writeMask: 0` on the pick target so the layer's pickId never
    // overwrites the pick texture's prior contents (picks fall through).
    const pickEnabled = isPickEnabled()
    const colorTargets: GPUColorTargetState[] = [{ format, blend: BLEND_ALPHA }]
    if (pickEnabled) colorTargets.push({ format: 'rg32uint' })
    const colorTargetsNoPick: GPUColorTargetState[] = pickEnabled
      ? [{ format, blend: BLEND_ALPHA }, { format: 'rg32uint', writeMask: 0 }]
      : colorTargets
    const msaaState: GPUMultisampleState = { count: getSampleCount() }

    const buildSet = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-pipeline${suffix}`,
      }),
      // Ground-layer fill — same shader as `fill` but with depth
      // test + write disabled. Used for any layer with
      // `extrude.kind === 'none'`; painter's order resolves
      // coplanar fragments without the layer_depth_offset hack.
      fillGround: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-ground${suffix}`,
      }),
      fillExtruded: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized_extruded', buffers: [vertexBufferLayout, extrudedZBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        // Two-sided rendering. The earlier `cullMode: 'back'` saved
        // ~half the extruded fragments BUT cut a hole into any concave
        // building (dome interior, courtyard, atrium) — once the
        // camera tilts enough to see the inside the cull drops the
        // inward-facing wall and the user looks straight through.
        // Mapbox / MapLibre `fill-extrusion` rendering is unculled for
        // the same reason: source data carries arbitrary footprints
        // and the inside-out artefact is far more visible than the
        // ~2× fragment cost. Depth test + outward-winding emission
        // still resolve overdraw correctly.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-pipeline-extruded${suffix}`,
      }),
      line: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-pipeline${suffix}`,
      }),
      fillFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-pipeline-fallback${suffix}`,
      }),
      // Ground variant of the stencil-test fallback — same depth-
      // disabled state as fillGround.
      fillGroundFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-ground-fallback${suffix}`,
      }),
      fillExtrudedFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized_extruded', buffers: [vertexBufferLayout, extrudedZBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        // Same rationale as `fillExtruded` above: unculled to keep
        // dome / courtyard interiors visible.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-pipeline-extruded-fallback${suffix}`,
      }),
      lineFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-pipeline-fallback${suffix}`,
      }),
    })

    const pickable = buildSet(colorTargets, '')
    this.fillPipeline = pickable.fill
    this.fillPipelineGround = pickable.fillGround
    this.fillPipelineExtruded = pickable.fillExtruded
    this.linePipeline = pickable.line
    this.fillPipelineFallback = pickable.fillFallback
    this.fillPipelineGroundFallback = pickable.fillGroundFallback
    this.fillPipelineExtrudedFallback = pickable.fillExtrudedFallback
    this.linePipelineFallback = pickable.lineFallback

    // OIT translucent extrude pipeline — separate from buildSet
    // because it targets the OIT MRT pair (rgba16float accum +
    // r16float revealage) at sampleCount=1, not the main pass's
    // color + pick attachments at MSAA. Same vs_main_quantized_
    // extruded vertex stage as the opaque fill — only the fragment
    // entry + targets differ. Depth state DEPTH_READ_ONLY: the
    // translucent fill respects the opaque depth buffer (hidden
    // behind solid walls) without writing depth (so multiple
    // translucent layers don't occlude each other in OIT space).
    const oitTargets: GPUColorTargetState[] = [
      { format: OIT_ACCUM_FORMAT, blend: BLEND_OIT_ACCUM },
      { format: OIT_REVEALAGE_FORMAT, blend: BLEND_OIT_REVEALAGE, writeMask: GPUColorWrite.RED },
    ]
    // OIT pass uses NO depth attachment — opaque depth is MSAA-4
    // and accum/revealage RTs are single-sample, so they can't share
    // a depth-stencil view. Translucent extrude therefore doesn't
    // depth-test against opaque buildings in this MVP — every
    // translucent fragment writes into accum/revealage regardless of
    // foreground occluders. McGuire-Bavoil weighted blending still
    // mostly hides far translucent fragments via the weight function,
    // but a translucent building behind a tall opaque one will still
    // contribute slightly. Proper depth testing would need either
    // MSAA-resolve of opaque depth into a single-sample texture, or
    // building an MSAA OIT pair (more memory, more complex compose).
    // Deferred — single-sample OIT is the typical industry choice.
    this.fillPipelineExtrudedOIT = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main_quantized_extruded', buffers: [vertexBufferLayout, extrudedZBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_oit_translucent', targets: oitTargets },
      // Two-sided. Translucent OIT specifically benefits from front+
      // back contributions to the weighted-blend accum (otherwise
      // the inside surface of a translucent dome / shell adds
      // nothing and the volume looks empty from one side). Matches
      // the opaque-extruded pipeline above so opaque <-> translucent
      // transitions don't reveal cull seams.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // OIT pass attaches the opaque MSAA depth-stencil so
      // translucent fragments depth-test against the full opaque
      // scene. depthWriteEnabled=false keeps OIT
      // translucent-vs-translucent order independent.
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthCompare: 'less-equal',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      },
      multisample: msaaState,
      label: 'fill-pipeline-extruded-oit',
    })

    // When picking is off there's no pick attachment to mask, so the
    // no-pick set is identical to the pickable one — alias instead of
    // building duplicates.
    if (pickEnabled) {
      const noPick = buildSet(colorTargetsNoPick, '-nopick')
      this.fillPipelineNoPick = noPick.fill
      this.fillPipelineGroundNoPick = noPick.fillGround
      this.fillPipelineExtrudedNoPick = noPick.fillExtruded
      this.linePipelineNoPick = noPick.line
      this.fillPipelineFallbackNoPick = noPick.fillFallback
      this.fillPipelineGroundFallbackNoPick = noPick.fillGroundFallback
      this.fillPipelineExtrudedFallbackNoPick = noPick.fillExtrudedFallback
      this.linePipelineFallbackNoPick = noPick.lineFallback
    } else {
      this.fillPipelineNoPick = this.fillPipeline
      this.fillPipelineGroundNoPick = this.fillPipelineGround
      this.fillPipelineExtrudedNoPick = this.fillPipelineExtruded
      this.linePipelineNoPick = this.linePipeline
      this.fillPipelineFallbackNoPick = this.fillPipelineFallback
      this.fillPipelineGroundFallbackNoPick = this.fillPipelineGroundFallback
      this.fillPipelineExtrudedFallbackNoPick = this.fillPipelineExtrudedFallback
      this.linePipelineFallbackNoPick = this.linePipelineFallback
    }

    // OIT compose — full-screen quad samples accum + revealage and
    // over-blends the recovered translucent colour onto the
    // (resolved) main framebuffer. With MSAA on, accum + revealage
    // are multisampled; the shader averages every sample to recover
    // a single resolved value. Single-sample (mobile / safe mode)
    // takes the same code path with a 1-sample loop, no branch.
    const sampleCount = getSampleCount()
    const isMsaa = sampleCount > 1
    const oitComposeShader = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex fn vs_full(@builtin(vertex_index) idx: u32) -> VsOut {
  // Oversized triangle covering NDC [-1, 1]² — vertices at
  // (-1, -1), (3, -1), (-1, 3). The half outside the viewport is
  // clipped by the rasterizer; covers the whole framebuffer with
  // one triangle (3-vertex draw). Avoids the off-by-vertex bug of
  // the bit-packed 6-vertex quad pattern.
  var pos: vec2<f32>;
  if (idx == 0u) { pos = vec2<f32>(-1.0, -1.0); }
  else if (idx == 1u) { pos = vec2<f32>(3.0, -1.0); }
  else { pos = vec2<f32>(-1.0, 3.0); }
  var out: VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  // Texture coords are sample-load coords (integer pixels) computed
  // from clip-space NDC: uv = (pos + 1) / 2, y flipped because
  // texture origin is top-left.
  out.uv = vec2<f32>((pos.x + 1.0) * 0.5, 1.0 - (pos.y + 1.0) * 0.5);
  return out;
}
@group(0) @binding(0) var accum_tex: ${isMsaa ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>'};
@group(0) @binding(1) var revealage_tex: ${isMsaa ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>'};
const SAMPLE_COUNT: i32 = ${sampleCount};
@fragment fn fs_compose(in: VsOut) -> @location(0) vec4<f32> {
  let dim = vec2<f32>(textureDimensions(accum_tex));
  let uv = vec2<i32>(in.uv * dim);
  var accum_sum: vec4<f32> = vec4<f32>(0.0);
  var rev_sum: f32 = 0.0;
  for (var s: i32 = 0; s < SAMPLE_COUNT; s = s + 1) {
    accum_sum = accum_sum + textureLoad(accum_tex, uv, s);
    rev_sum = rev_sum + textureLoad(revealage_tex, uv, s).r;
  }
  let inv = 1.0 / f32(SAMPLE_COUNT);
  let accum = accum_sum * inv;
  let revealage = rev_sum * inv;
  let avg = accum.rgb / max(accum.a, 1e-5);
  let alpha = 1.0 - revealage;
  return vec4<f32>(avg, alpha);
}
`
    const oitComposeModule = device.createShaderModule({ code: oitComposeShader, label: 'oit-compose' })
    this.oitComposeBindGroupLayout = device.createBindGroupLayout({
      label: 'oit-compose-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', multisampled: isMsaa } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', multisampled: isMsaa } },
      ],
    })
    this.oitComposePipeline = device.createRenderPipeline({
      label: 'oit-compose-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.oitComposeBindGroupLayout] }),
      vertex: { module: oitComposeModule, entryPoint: 'vs_full' },
      fragment: {
        module: oitComposeModule,
        entryPoint: 'fs_compose',
        targets: [{ format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: msaaState,
    })

    // Uniform ring buffer: 256-byte slots, dynamic offsets per draw.
    // Guarantees that multi-layer draws don't overwrite each other's uniforms.
    this.uniformBuffer = device.createBuffer({
      size: this.uniformRingCapacity * MapRenderer.UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniform-ring',
    })
    this.uniformStaging = new Uint8Array(this.uniformRingCapacity * MapRenderer.UNIFORM_SLOT)

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } }],
    })
  }

  /** Ring buffers retired by growUniformRing during the previous frame.
   *  Destroyed at the START of the next frame, after the previous
   *  frame's queue.submit() completed — destroying mid-frame races
   *  with in-flight commands that still reference the old ring via
   *  bind groups recorded into the current encoder, which surfaces
   *  as STATUS_BREAKPOINT (GPU process __debugbreak under buffer-
   *  used-after-destroyed validation). VTR uses the same pattern;
   *  see vector-tile-renderer.ts:retiredUniformRings. */
  private retiredUniformRings: GPUBuffer[] = []

  /** Reset the ring-buffer slot cursor. Call once per frame before any draws. */
  beginFrame(): void {
    this.uniformSlot = 0
    for (const b of this.retiredUniformRings) b.destroy()
    this.retiredUniformRings.length = 0
  }

  /** Copy a draw's uniform block into the staging mirror; tracked by
   *  dirty range so endFrame() can emit one writeBuffer instead of
   *  one per draw. Same pattern as VTR.stageUniformSlot. */
  private stageUniformSlot(slotOffset: number, src: ArrayBuffer): void {
    const slot = MapRenderer.UNIFORM_SLOT
    this.uniformStaging.set(new Uint8Array(src, 0, Math.min(src.byteLength, slot)), slotOffset)
    const hi = slotOffset + slot
    if (this.uniformDirtyHi === this.uniformDirtyLo) {
      this.uniformDirtyLo = slotOffset
      this.uniformDirtyHi = hi
    } else {
      if (slotOffset < this.uniformDirtyLo) this.uniformDirtyLo = slotOffset
      if (hi > this.uniformDirtyHi) this.uniformDirtyHi = hi
    }
  }

  /** Flush the staged uniform bytes before queue.submit(). Safe to
   *  call any number of times per frame — a no-op when no slots have
   *  been staged since the last flush. */
  endFrame(): void {
    if (this.uniformDirtyHi === this.uniformDirtyLo) return
    const lo = this.uniformDirtyLo, hi = this.uniformDirtyHi
    this.ctx.device.queue.writeBuffer(
      this.uniformBuffer, lo,
      this.uniformStaging.buffer, this.uniformStaging.byteOffset + lo, hi - lo,
    )
    this.uniformDirtyLo = 0
    this.uniformDirtyHi = 0
  }

  private allocUniformSlot(): number {
    if (this.uniformSlot >= this.uniformRingCapacity) this.growUniformRing(this.uniformSlot + 1)
    return this.uniformSlot++ * MapRenderer.UNIFORM_SLOT
  }

  private growUniformRing(minSlots: number): void {
    const { device } = this.ctx
    let newCap = this.uniformRingCapacity
    while (newCap < minSlots) newCap *= 2
    // Defer destroy: in-flight commands recorded into the current
    // frame's encoder still reference the old buffer via bind groups.
    // beginFrame() destroys these after the next queue.submit() wraps.
    if (this.uniformBuffer) this.retiredUniformRings.push(this.uniformBuffer)
    this.uniformRingCapacity = newCap
    this.uniformBuffer = device.createBuffer({
      size: newCap * MapRenderer.UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniform-ring',
    })
    const grown = new Uint8Array(newCap * MapRenderer.UNIFORM_SLOT)
    grown.set(this.uniformStaging.subarray(0, Math.min(this.uniformStaging.length, grown.length)))
    this.uniformStaging = grown
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

  /** Register data + show command as a render layer.
   *  `pickId` is the stable u16 from `LayerIdRegistry`; it gets baked into
   *  every uniform-stage write so the fragment shader can stamp the pick
   *  texture's G channel. 0 = "no layer" (e.g., graticule), which makes
   *  `pickAt()` return null for hits. */
  addLayer(show: ShowCommand, polygons: MeshData, lines: LineMeshData, pickId = 0): void {
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
      timeOpacityStops: show.timeOpacityStops ?? null,
      timeFillStops: show.timeFillStops ?? null,
      timeStrokeStops: show.timeStrokeStops ?? null,
      timeStrokeWidthStops: show.timeStrokeWidthStops ?? null,
      timeSizeStops: show.timeSizeStops ?? null,
      timeDashOffsetStops: show.timeDashOffsetStops ?? null,
      timeOpacityLoop: show.timeOpacityLoop ?? false,
      timeOpacityEasing: show.timeOpacityEasing ?? 'linear',
      timeOpacityDelayMs: show.timeOpacityDelayMs ?? 0,
      fillPipeline: layerFillPipeline,
      linePipeline: layerLinePipeline,
      featureDataBuffer: null,
      perLayerBindGroup: null,
      pickId,
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

  /** Create specialized fill + line pipelines for a shader variant.
   *  Builds two parallel sets when picking is enabled — pickable
   *  (writeMask:ALL on the pick attachment) and non-pickable
   *  (writeMask:0). The bucket scheduler picks the right one based on
   *  each show's `pointerEvents`. When picking is globally off, the
   *  no-pick fields alias the pickable ones (no pick attachment to
   *  mask). */
  private createVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const { device, format } = this.ctx
    const wgsl = buildShader(variant)
    const msaaState: GPUMultisampleState = { count: getSampleCount() }
    const pickEnabled = isPickEnabled()
    const colorTargets: GPUColorTargetState[] = [{ format, blend: BLEND_ALPHA }]
    if (pickEnabled) colorTargets.push({ format: 'rg32uint' })
    const colorTargetsNoPick: GPUColorTargetState[] = pickEnabled
      ? [{ format, blend: BLEND_ALPHA }, { format: 'rg32uint', writeMask: 0 }]
      : colorTargets

    const module = device.createShaderModule({
      code: wgsl,
      label: `shader-${variant.key}`,
    })

    // Use feature bind group layout if storage buffer is needed
    const layout = variant.needsFeatureBuffer ? this.featureBindGroupLayout : this.bindGroupLayout
    const pipelineLayout = device.createPipelineLayout({
      label: `mr-variantPipelineLayout(${variant.needsFeatureBuffer ? 'feature' : 'base'})`,
      bindGroupLayouts: [layout],
    })

    // Phase B quantized polygon vertex layout — matches initPipelines()
    // above. unorm16x2 + float32 stride 8.
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'uint16x2' as GPUVertexFormat },
        { shaderLocation: 2, offset: 4, format: 'float32'   as GPUVertexFormat },
      ],
    }
    const lineVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0,  format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 1, offset: 8,  format: 'float32x2' as GPUVertexFormat },
        { shaderLocation: 2, offset: 16, format: 'float32'   as GPUVertexFormat },
      ],
    }

    const buildSet = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-${variant.key}${suffix}`,
      }),
      // Ground (depth-disabled) variant — coplanar painter's-order
      // resolve for `extrude.kind === 'none'` layers. Mirrors the
      // unconditional `fillPipelineGround` (renderer.ts:983) so
      // variant-driven ground layers don't write depth and force
      // z-fighting against subsequent coplanar layers in the same
      // source. Required after b98c449/e655b25 began routing variant
      // shows away from the base-only fillPipelineGround substitution.
      fillGround: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-${variant.key}${suffix}`,
      }),
      line: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-${variant.key}${suffix}`,
      }),
      fillFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-fallback-${variant.key}${suffix}`,
      }),
      // Ground depth-disabled fallback variant — same role as
      // `fillGround` but for the parent-ancestor fallback path
      // (stencil test, no stencil write). Without this the
      // ancestor draw path keeps writing depth which would block
      // siblings during the brief "current zoom missing, parent
      // showing" window.
      fillGroundFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-fallback-${variant.key}${suffix}`,
      }),
      lineFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-fallback-${variant.key}${suffix}`,
      }),
    })

    const p = buildSet(colorTargets, '')
    const np = pickEnabled ? buildSet(colorTargetsNoPick, '-nopick') : p

    return {
      fillPipeline: p.fill,
      fillPipelineGround: p.fillGround,
      linePipeline: p.line,
      fillPipelineFallback: p.fillFallback,
      fillPipelineGroundFallback: p.fillGroundFallback,
      linePipelineFallback: p.lineFallback,
      fillPipelineNoPick: np.fill,
      fillPipelineGroundNoPick: np.fillGround,
      linePipelineNoPick: np.line,
      fillPipelineFallbackNoPick: np.fillFallback,
      fillPipelineGroundFallbackNoPick: np.fillGroundFallback,
      linePipelineFallbackNoPick: np.lineFallback,
    }
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
  renderToPass(pass: GPURenderPassEncoder, camera: Camera, projType = 0, projCenterLon = 0, projCenterLat = 20, elapsedMs = 0): void {
    const { device, canvas } = this.ctx
    // RTC: no translation in MVP, projection center is at (0,0).
    // Compute the live DPR so the camera matrix uses CSS-pixel altitude
    // (matches what VTR / raster / point renderers do).
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    const frame = camera.getFrameView(canvas.width, canvas.height, dpr)
    const mvp = frame.matrix

    for (const layer of this.layers) {
      // Read from dynamic properties (supports runtime override)
      if (!layer.props.getBool('visible')) continue

      // Opacity = zoom factor × time factor. Either may be 1 if its stop
      // list is absent. Multiplying lets zoom-opacity act as a slow envelope
      // around a faster time-based pulse, which is what users expect.
      const zoomOpa = layer.zoomOpacityStops
        ? interpolateZoom(layer.zoomOpacityStops, camera.zoom)
        : layer.props.getNumber('opacity', 1.0)
      const timeOpa = layer.timeOpacityStops
        ? interpolateTime(
            layer.timeOpacityStops, elapsedMs,
            layer.timeOpacityLoop, layer.timeOpacityEasing, layer.timeOpacityDelayMs,
          )
        : 1.0
      const opacity = zoomOpa * timeOpa

      // Fill / stroke color — if keyframes animate them, sample the stop
      // list each frame. Otherwise fall back to the base color from the
      // dynamic property store (which itself originated from the compiled
      // `fill:` / `stroke:` hex).
      let fillRaw = layer.props.getColor('fill')
      let strokeRaw = layer.props.getColor('stroke')
      if (layer.timeFillStops) {
        fillRaw = interpolateTimeColor(
          layer.timeFillStops, elapsedMs,
          layer.timeOpacityLoop, layer.timeOpacityEasing, layer.timeOpacityDelayMs,
        )
      }
      if (layer.timeStrokeStops) {
        strokeRaw = interpolateTimeColor(
          layer.timeStrokeStops, elapsedMs,
          layer.timeOpacityLoop, layer.timeOpacityEasing, layer.timeOpacityDelayMs,
        )
      }
      const fillColor = fillRaw ? [fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * opacity] : [0, 0, 0, 0]
      const strokeColor = strokeRaw ? [strokeRaw[0], strokeRaw[1], strokeRaw[2], strokeRaw[3] * opacity] : [0, 0, 0, 0]

      const uniformData = this.uniformDataBuf
      new Float32Array(uniformData, 0, 16).set(mvp)
      new Float32Array(uniformData, 64, 4).set(fillColor as number[])
      new Float32Array(uniformData, 80, 4).set(strokeColor as number[])
      new Float32Array(uniformData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
      // Non-tiled layer: vertices are stored in absolute Mercator meters
      // (DSFUN stride 5/6) so tile_origin_merc = (0, 0) and
      // cam_h/cam_l = splitF64(cam_merc). The DSFUN subtraction in vs_main
      // then yields camera-relative meters exactly like the tiled path.
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const cx = projCenterLon * DEG2RAD * R
      const cy = projType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + Math.max(-85.051129, Math.min(85.051129, projCenterLat)) * DEG2RAD / 2)) * R  // Mercator
        : projCenterLat * DEG2RAD * R  // Equirectangular fallback (non-Mercator rebuilds lon/lat in the shader)
      const cxH = Math.fround(cx)
      const cxL = Math.fround(cx - cxH)
      const cyH = Math.fround(cy)
      const cyL = Math.fround(cy - cyH)
      new Float32Array(uniformData, 112, 4).set([cxH, cyH, cxL, cyL]) // cam_h.xy, cam_l.xy
      // tile_origin_merc=(0,0), opacity, log_depth_fc
      new Float32Array(uniformData, 128, 4).set([0, 0, opacity, frame.logDepthFc])
      // pick_id (low16 = layerId, high16 = instanceId=0 for non-tiled),
      // followed by 12 bytes of vec3<u32> padding so the uniform struct
      // ends on a 16-byte boundary as required by WebGPU std140-ish layout.
      new Uint32Array(uniformData, 144, 4).set([layer.pickId, 0, 0, 0])
      const slotOffset = this.allocUniformSlot()
      this.stageUniformSlot(slotOffset, uniformData)

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

      // Non-Mercator projections render a single world; only Mercator
      // wraps via WORLD_MERC. See worldCopiesFor() for rationale.
      const worldOffs = worldCopiesFor(projType)

      for (let wi = 0; wi < worldOffs.length; wi++) {
        const gratData = new ArrayBuffer(160)
        new Float32Array(gratData, 0, 16).set(mvp)
        new Float32Array(gratData, 64, 4).set([1, 1, 1, 0.15])
        new Float32Array(gratData, 80, 4).set([1, 1, 1, 0.15])
        new Float32Array(gratData, 96, 4).set([projType, projCenterLon, projCenterLat, 0])
        // Graticule vertices are DSFUN-encoded in absolute Mercator meters,
        // so tile_origin_merc = (0,0) and cam_h/cam_l = splitF64(cam_merc).
        // World-copy offsets shift the camera by ±WORLD_MERC meters.
        const gcx = projCenterLon * gDEG2RAD * gR - worldOffs[wi] * WORLD_MERC
        const gcxH = Math.fround(gcx)
        const gcxL = Math.fround(gcx - gcxH)
        const gcyH = Math.fround(gcy)
        const gcyL = Math.fround(gcy - gcyH)
        new Float32Array(gratData, 112, 4).set([gcxH, gcyH, gcxL, gcyL])
        // tile_origin_merc=(0,0) for graticule (world-space DSFUN), opacity=1, log_depth_fc
        new Float32Array(gratData, 128, 4).set([0, 0, 1, frame.logDepthFc])
        // pick_id=0 — graticule is decorative, never pickable.
        new Uint32Array(gratData, 144, 4).set([0, 0, 0, 0])
        const gratOff = this.allocUniformSlot()
        this.stageUniformSlot(gratOff, gratData)

        pass.setBindGroup(0, this.bindGroup, [gratOff])
        pass.draw(this.graticuleVertexCount)
      }
    }

    // pass.end() and submit() are handled by caller
  }
}
