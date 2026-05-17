// ═══ X-GIS Map Renderer — WebGPU ═══

import type { GPUContext } from '../gpu/gpu'
import type { Camera } from '../projection/camera'
import type { MeshData, LineMeshData } from '../../loader/geojson'
import { generateGraticule } from '../graticule'
import {
  BLEND_ALPHA, STENCIL_WRITE, STENCIL_TEST,
  STENCIL_WRITE_NO_DEPTH, STENCIL_TEST_NO_DEPTH,
  BLEND_OIT_ACCUM, BLEND_OIT_REVEALAGE,
  OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT,
  WORLD_MERC, worldCopiesFor,
} from '../gpu/gpu-shared'
import { isPickEnabled, getSampleCount } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { WGSL_LOG_DEPTH_FNS } from '../shaders/log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from '../shaders/projection'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'
import { ComputeDispatcher } from '../gpu/compute'
import { ComputeLayerRegistry } from './compute-layer-registry'
import { extendBindGroupLayoutEntriesForCompute, buildComputeBindGroupEntries } from './compute-bind-layout'

// generateGraticule(zoom) now handles zoom-adaptive steps internally

// ═══ Shader Source ═══

// Exported for the marker-drift invariant test (polygon-shader-
// markers.test.ts). Marker constants below MUST stay byte-identical
// to a substring of this template — `String.replace` silently no-ops
// on miss, so a stale marker turns every variant fragment shader
// into the legacy uniform path. That's the bug class that hid the
// OFM Bright school fill (P1 root cause, fix 5/5 in 8e1aa08).
export const POLYGON_SHADER_SOURCE: string = /* wgsl */ `
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
  // Per-frame camera zoom (Mapbox-style fractional zoom level).
  // Sampled by the palette gradient lookup (P3 Step 3c, see
  // textureSampleLevel call sites generated by emitColorGradient
  // Sample) — the variant shader maps zoom into the gradient
  // atlas's U coord. Followed by 3 f32 pads (NOT vec3<f32>, whose
  // 16-byte alignment would push the struct to 208 bytes) so the
  // struct ends on a 16-byte boundary at exactly 192 bytes.
  zoom: f32,
  _pad_zoom_0: f32,
  _pad_zoom_1: f32,
  _pad_zoom_2: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

${WGSL_PROJECTION_FNS}

// Per-fragment recompute of the hemisphere-cull signal. The vertex
// shader emits cos_c as a varying (location 0), but cos_c is a non-
// linear function of position — linear interpolation across a triangle
// spanning the visible-hemisphere boundary on globe / orthographic /
// azimuthal projections diverges from the true per-fragment value.
// A long polygon edge crossing the terminator can interpolate to a
// positive cos_c even where the fragment is on the back hemisphere
// (false visibility), or to a negative cos_c where it is on the front
// (false hole). Recompute from the absolute-Mercator varyings (which
// telescope exactly under linear interpolation) and call the shared
// needs_backface_cull entry that the vertex path uses.
//
// Cost: 1 atan + 1 exp + a few muls per fragment in the cull path.
// Flat projections (proj_params.x < 2.5) short-circuit inside
// needs_backface_cull to +1 so the per-pixel cost stays at ~0 for the
// common Mercator / equirect / natural-earth cases.
//
// Pattern mirrors line-renderer.ts:779 and point-renderer.ts:340,
// which already recompute per-fragment after the same vertex-
// interpolation correctness regression was identified for those
// renderers.
fn polygon_cos_c_fragment(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  let abs_lon = abs_merc_x / (DEG2RAD * EARTH_R);
  let lat_rad = 2.0 * atan(exp(abs_merc_y / EARTH_R)) - PI / 2.0;
  let abs_lat = lat_rad / DEG2RAD;
  return needs_backface_cull(abs_lon, abs_lat, u.proj_params);
}

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

  let t = u.proj_params.x;
  var rtc: vec2<f32>;
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
    // Tile centre longitude — the per-tile unwrap reference that keeps a
    // seam-straddling tile contiguous under equirect / natural_earth.
    let tile_ref_lon = (u.tile_origin_merc.x + 0.5 * u.tile_extent_m) / (DEG2RAD * EARTH_R);
    let proj_xy = project_geom(abs_lon, abs_lat, u.proj_params, tile_ref_lon);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }
  // True 3D globe (projType 7): RTC against the focus point ON THE
  // sphere, then the orbit-camera MVP the camera emits in globe mode.
  let globe_rtc = proj_globe(abs_lon, abs_lat) - proj_globe(u.proj_params.y, u.proj_params.z);

  var out: VertexOutput;
  let clip = select(
    u.mvp * vec4<f32>(rtc, 0.0, 1.0),
    u.mvp * vec4<f32>(globe_rtc, 1.0),
    t > 6.5,
  );
  // Log-depth rewrite of clip.z. Three.js equivalent — preserves near-plane
  // precision at high pitch and when rendering 3D geometry.
  out.position = apply_log_depth(clip, u.log_depth_fc);
  // Per-layer z bias (see Uniforms.layer_depth_offset). Multiplied by
  // post-projection w so the NDC-z shift is constant across the depth
  // range (perspective-divide cancels the w factor).
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  // cos_c kept as a varying-layout placeholder — fragments now
  // recompute hemisphere cull per-pixel via polygon_cos_c_fragment()
  // (commit c205871) since linear interpolation of cos_c across
  // large triangles diverges from the true sphere distance. Writing
  // 0 avoids the per-vertex needs_backface_cull() call which on
  // globe/ortho computes sin/cos; flat projections were already a
  // no-op (returns 1.0) so this is a perf win on the projection
  // paths that benefit AND a clarity win everywhere else (no
  // misleading "this varying gets read" implication).
  out.cos_c = 0.0;
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

  let t = u.proj_params.x;
  var rtc: vec2<f32>;
  if (t < 0.5) {
    rtc = rel;
  } else {
    let tile_ref_lon = (u.tile_origin_merc.x + 0.5 * u.tile_extent_m) / (DEG2RAD * EARTH_R);
    let proj_xy = project_geom(abs_lon, abs_lat, u.proj_params, tile_ref_lon);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }
  let globe_rtc = proj_globe(abs_lon, abs_lat) - proj_globe(u.proj_params.y, u.proj_params.z);

  var out: VertexOutput;
  // 3D extrusion: top vertices lift to z=extrude_height_m, bottom
  // stay at z=0. Wall quads (a_bot, b_bot, a_top, b_top) form
  // vertical sides; top-face polygons all carry is_top=1. Non-
  // extruded layers set extrude_height_m=0 → both branches yield
  // z=0 → identical to the flat path.
  let z_world = select(0.0, u.extrude_height_m, is_top);
  // Globe (projType 7) uses the sphere RTC + orbit MVP; extrusion on
  // the sphere is a later refinement (flat basemap path unaffected).
  let clip = select(
    u.mvp * vec4<f32>(rtc, z_world, 1.0),
    u.mvp * vec4<f32>(globe_rtc, 1.0),
    t > 6.5,
  );
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  // cos_c kept as a varying-layout placeholder — fragments now
  // recompute hemisphere cull per-pixel via polygon_cos_c_fragment()
  // (commit c205871) since linear interpolation of cos_c across
  // large triangles diverges from the true sphere distance. Writing
  // 0 avoids the per-vertex needs_backface_cull() call which on
  // globe/ortho computes sin/cos; flat projections were already a
  // no-op (returns 1.0) so this is a perf win on the projection
  // paths that benefit AND a clarity win everywhere else (no
  // misleading "this varying gets read" implication).
  out.cos_c = 0.0;
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

  let t = u.proj_params.x;
  var rtc: vec2<f32>;
  if (t < 0.5) {
    rtc = rel;
  } else {
    let tile_ref_lon = (u.tile_origin_merc.x + 0.5 * u.tile_extent_m) / (DEG2RAD * EARTH_R);
    let proj_xy = project_geom(abs_lon, abs_lat, u.proj_params, tile_ref_lon);
    let center_xy = project(u.proj_params.y, u.proj_params.z, u.proj_params);
    rtc = proj_xy - center_xy;
  }
  let globe_rtc = proj_globe(abs_lon, abs_lat) - proj_globe(u.proj_params.y, u.proj_params.z);

  var out: VertexOutput;
  let clip = select(
    u.mvp * vec4<f32>(rtc, z_attr, 1.0),
    u.mvp * vec4<f32>(globe_rtc, 1.0),
    t > 6.5,
  );
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = out.position.z - u.layer_depth_offset * out.position.w;
  out.view_w = clip.w;
  // cos_c kept as a varying-layout placeholder — fragments now
  // recompute hemisphere cull per-pixel via polygon_cos_c_fragment()
  // (commit c205871) since linear interpolation of cos_c across
  // large triangles diverges from the true sphere distance. Writing
  // 0 avoids the per-vertex needs_backface_cull() call which on
  // globe/ortho computes sin/cos; flat projections were already a
  // no-op (returns 1.0) so this is a perf win on the projection
  // paths that benefit AND a clarity win everywhere else (no
  // misleading "this varying gets read" implication).
  out.cos_c = 0.0;
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
  // Per-fragment recompute (see polygon_cos_c_fragment doc above).
  // Interpolating the per-vertex cos_c across a triangle that crosses
  // the visible-hemisphere boundary diverges from the true sphere
  // distance, so vertex-only cull leaks fragments on the back
  // hemisphere or punches false holes on the front. The fragment
  // recompute uses abs_merc_x/y, which DO telescope exactly under
  // linear interpolation.
  if (polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask: only apply when ALL FOUR sides describe a
  // valid bounding box (east > west AND north > south). The sentinel
  // -1e30 trips the first check; the validity check catches the case
  // where some upstream path forgot to write all four fields and
  // left partial / stale data — without it, a (0, 0, 0, 0) residue
  // would silently discard most of the world (symptom: hero map
  // shows only ~1/4 of the globe — Africa + Australia only).
  let _clip_valid =
    u.clip_bounds.x > -1e29 &&
    u.clip_bounds.z > u.clip_bounds.x &&
    u.clip_bounds.w > u.clip_bounds.y;
  if (_clip_valid) {
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
  if (polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask (see fs_fill — robust check requires both
  // sentinel-not-tripped AND the bounds to describe a valid box).
  let _clip_valid =
    u.clip_bounds.x > -1e29 &&
    u.clip_bounds.z > u.clip_bounds.x &&
    u.clip_bounds.w > u.clip_bounds.y;
  if (_clip_valid) {
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
  if (polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0) { discard; }
  if (abs(input.abs_lat) > MERCATOR_LAT_LIMIT) { discard; }
  // Per-tile clip mask (see fs_fill — robust check requires both
  // sentinel-not-tripped AND the bounds to describe a valid box).
  let _clip_valid =
    u.clip_bounds.x > -1e29 &&
    u.clip_bounds.z > u.clip_bounds.x &&
    u.clip_bounds.w > u.clip_bounds.y;
  if (_clip_valid) {
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

// ?debug=overdraw — single constant-output entry shared by every
// debug-variant pipeline (fill, stroke, fallback, etc.). Vertex
// shaders still project correctly so the rasterizer produces the
// SAME fragments as the normal path; FS work collapses to one
// write that an additive blend sums into the r16float accumulator.
// Counts SUBMITTED overdraw — depth is forced always, no stencil,
// no clip-bounds discard — matching the MapLibre debug convention.
@fragment
fn fs_overdraw() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 0.0);
}
`

// Fragment markers for template replacement. Match the entire
// `out.color = ...;` assignment in fs_fill / fs_stroke so variants can
// swap in a data-driven color expression without touching the FragmentOutput
// plumbing or the log-depth write.
// Marker strings used by `buildShader` to splice variant-specific
// fill / stroke emission into the fragment shader. MUST be byte-
// identical to a substring of `POLYGON_SHADER_SOURCE` —
// `String.replace` silently no-ops when the search string isn't
// found, so a stale marker turns every data-driven fill / stroke
// into the legacy uniform path (root cause of the OFM Bright
// school-fill bug 2026-05-14, fix 5/5 in commit 8e1aa08).
//
// Exported so polygon-shader-markers.test.ts can assert each
// marker appears exactly once in the shader source. CI fails
// before the silent no-op reaches production.
export const FILL_RETURN_MARKER = 'out.color = vec4<f32>(u.fill_color.rgb * wall_shade, u.fill_color.a);'
export const STROKE_RETURN_MARKER = 'out.color = vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);'
/** Template tokens replaced via regex (not literal string replace),
 *  so the no-op risk is different — a missed token simply stays in
 *  the WGSL and trips a compile error rather than rendering as a
 *  silent legacy path. Exported anyway so the same invariant test
 *  asserts they're present (catch deletion in fs_fill / fs_stroke). */
export const PICK_FIELD_TOKEN = '__PICK_FIELD__'
export const PICK_WRITE_TOKEN = '__PICK_WRITE__'

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

  if (!variant || (!variant.preamble && !variant.needsFeatureBuffer)) return applyPick(POLYGON_SHADER_SOURCE)

  let shader = POLYGON_SHADER_SOURCE
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
  /** Mapbox `layer.minzoom` — layer is hidden when camera.zoom <
   *  minzoom. Without enforcement every sub-layer of a multi-zoom
   *  style renders at every zoom level (place city + state + town +
   *  village + POI all at z=1). The label render path and the
   *  polygon/line draw loop both consult this. */
  minzoom?: number
  /** Mapbox `layer.maxzoom` — layer is hidden when camera.zoom >=
   *  maxzoom. */
  maxzoom?: number
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
  /** Mapbox `paint.line-width: ["interpolate", curve, ["zoom"], …]` —
   *  pure zoom stops the renderer evaluates per frame against
   *  camera.zoom. Lets the line widen smoothly inside one tile-zoom
   *  bracket (vs. the strokeWidthExpr / worker bake which freezes
   *  the width at tile-decode zoom). When present, overrides
   *  `strokeWidth`. */
  zoomStrokeWidthStops?: { zoom: number; value: number }[]
  zoomStrokeWidthStopsBase?: number
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
  /** Per-frame composed opacity (resolved-value channel). Bucket-
   *  scheduler writes this in `effectiveShow` after evaluating
   *  paintShapes.opacity; downstream renderers read it as a scalar. */
  opacity: number
  /** Per-frame composed size. Same resolved-value channel pattern as
   *  `opacity`. `null` when the layer doesn't author a size. */
  size?: number | null
  /** Dash offset as a PropertyShape — composed by emit-commands from
   *  the static `stroke.dashOffset` and any time-interpolated
   *  animation plus the layer-level lifecycle metadata. `null` means
   *  no offset authored. dashOffset is a STRUCTURAL stroke attribute
   *  (drift of the dash pattern along the line), not a paint axis —
   *  that's why it lives outside the PaintShapes bundle. */
  dashOffsetShape?: import('@xgis/compiler').PropertyShape<number> | null
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
  /** Lateral parallel offset in CSS px (Mapbox `paint.line-offset`). */
  strokeOffset?: number
  /** Stroke alignment ('inset' / 'outset' shifts by ±half-width). */
  strokeAlign?: 'center' | 'inset' | 'outset'
  /** Mapbox `paint.line-blur` — edge feathering in CSS px (0 = crisp). */
  strokeBlur?: number
  // Stable u16 layer ID assigned by `XGISMap` via `LayerIdRegistry` after
  // the compiler emits this command. Threaded into every per-tile uniform
  // write so the fragment shader can stamp the pick texture's G channel
  // with `(instanceId << 16) | layerId`. 0 = unregistered (sentinel).
  pickId?: number
  /** Typed paint-property bundle (Plan Step 1b/1c). Mirrors the legacy
   *  flat fields above (fill / stroke / strokeWidth / opacity / size +
   *  their zoom* / time* companions). Consumers migrating off the
   *  flat-field stitching pattern read paintShapes directly — the
   *  bucket-scheduler's opacity resolution does this today, with
   *  fill / stroke / strokeWidth / size to follow (Step 1c.3). The
   *  field is required because the legacy interpreter (interpreter.ts)
   *  and the compiler's emit-commands both populate it; bucket-
   *  scheduler can drop its legacy-field fallback now. */
  paintShapes: import('@xgis/compiler').PaintShapes
  /** Per-feature label spec (Mapbox `symbol` text / icon). Compiler's
   *  ShowCommand carries the full LabelDef; the runtime renderer only
   *  needs the presence check + text/size for the SDF stage, so the
   *  type here is the structurally-narrower compiler export. Without
   *  this field, show-source-maps.ts:149's `show.label !== undefined`
   *  check failed TS2339. */
  label?: import('@xgis/compiler').LabelDef
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

/** Interpolate between sorted zoom stops.
 *
 *  `base` is the Mapbox `["exponential", base]` curve parameter — when
 *  unset or 1, falls through to linear interpolation. When > 1, the
 *  fraction t accelerates near the higher zoom stop (lines / dots
 *  grow fast as you zoom in); when 0 < base < 1, t accelerates near
 *  the lower stop. Formula matches Mapbox / MapLibre:
 *
 *      t = (base^(z - z_i) - 1) / (base^(z_{i+1} - z_i) - 1)
 *
 *  Defaults to linear so the 99 % of call sites that don't carry an
 *  exponential curve continue to behave identically. */
export function interpolateZoom(
  stops: { zoom: number; value: number }[],
  zoom: number,
  base: number = 1,
): number {
  if (stops.length === 0) return 1.0
  if (zoom <= stops[0].zoom) return stops[0].value
  if (zoom >= stops[stops.length - 1].zoom) return stops[stops.length - 1].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const z0 = stops[i].zoom
      const z1 = stops[i + 1].zoom
      const span = z1 - z0
      let t: number
      if (base === 1 || Math.abs(base - 1) < 1e-6) {
        t = (zoom - z0) / span
      } else {
        // Exponential. Math.pow handles base > 1 and 0 < base < 1.
        const numer = Math.pow(base, zoom - z0) - 1
        const denom = Math.pow(base, span) - 1
        t = denom === 0 ? 0 : numer / denom
      }
      return stops[i].value + t * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

/** RGBA component-wise zoom interpolation. Sibling of interpolateZoom
 *  but for the [r,g,b,a] tuples Mapbox text-color / text-halo-color
 *  stops produce. Returns a freshly allocated tuple — call sites are
 *  per-frame-per-label so allocation is cheap relative to the GPU
 *  work, and aliasing an `out` buffer would be brittle. */
export function interpolateZoomRgba(
  stops: { zoom: number; value: [number, number, number, number] }[],
  zoom: number,
  base: number = 1,
): [number, number, number, number] {
  if (stops.length === 0) return [0, 0, 0, 1]
  if (zoom <= stops[0].zoom) {
    const v = stops[0].value
    return [v[0], v[1], v[2], v[3]]
  }
  if (zoom >= stops[stops.length - 1].zoom) {
    const v = stops[stops.length - 1].value
    return [v[0], v[1], v[2], v[3]]
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const z0 = stops[i].zoom
      const z1 = stops[i + 1].zoom
      const span = z1 - z0
      let t: number
      if (base === 1 || Math.abs(base - 1) < 1e-6) {
        t = (zoom - z0) / span
      } else {
        const numer = Math.pow(base, zoom - z0) - 1
        const denom = Math.pow(base, span) - 1
        t = denom === 0 ? 0 : numer / denom
      }
      const a = stops[i].value, b = stops[i + 1].value
      return [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
        a[3] + t * (b[3] - a[3]),
      ]
    }
  }
  const v = stops[stops.length - 1].value
  return [v[0], v[1], v[2], v[3]]
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
  // Must equal MapRenderer.UNIFORM_SIZE (192). Inlined because
  // class-field init can't reference static-readonly fields declared
  // later in the same class. Grew 160 → 176 when `clip_bounds:
  // vec4<f32>` was added to WGSL Uniforms (per-tile fallback clip
  // mask). Out-of-bounds typed-array writes are silent no-ops so a
  // mismatch here = uniform never reaches the GPU.
  private uniformDataBuf = new ArrayBuffer(192)
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
  private static readonly UNIFORM_SIZE = 192
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
  /** `?debug=overdraw` final pass — fullscreen quad samples the
   *  r16float overdraw accumulator and writes a heat-colormapped RGBA
   *  to the swapchain. Built lazily on first call to ensureOverdrawCompose. */
  overdrawComposePipeline: GPURenderPipeline | null = null
  overdrawComposeBindGroupLayout!: GPUBindGroupLayout
  /** `?debug=overdraw` — fill pipeline mirror (base bind group
   *  layout). FS replaced with `fs_overdraw`, color target r16float
   *  + additive. Variant shows that use the feature bind group
   *  layout select `fillPipelineOverdrawFeature` instead. */
  fillPipelineOverdraw: GPURenderPipeline | null = null
  /** `?debug=overdraw` — fill pipeline mirror for feature-layout
   *  shows (data-driven variants that bind a per-feature storage
   *  buffer alongside the uniform). */
  fillPipelineOverdrawFeature: GPURenderPipeline | null = null
  /** `?debug=overdraw` — line pipeline mirror (base bind group
   *  layout). Lines go through LineRenderer.drawSegments today,
   *  which is gated off in debug mode; this pipeline is here for
   *  completeness in case a future caller setPipelines it. */
  linePipelineOverdraw: GPURenderPipeline | null = null
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
  // P3 Step 3c palette atlas resources. The texture starts as a 1×1
  // transparent stub so every bind group is valid even before the
  // real atlas (uploadPalette result) lands. `setPaletteColorAtlas`
  // swaps the view in-place when the scene compile finishes.
  paletteStubTexture!: GPUTexture
  paletteStubTextureView!: GPUTextureView
  /** Currently-bound color gradient atlas view. Defaults to the 1×1
   *  stub; set to the real atlas via `setPaletteColorAtlas`. */
  paletteColorAtlasView!: GPUTextureView
  paletteSampler!: GPUSampler
  private bindGroup!: GPUBindGroup
  private layers: RenderLayer[] = []
  private graticuleBuffer: GPUBuffer | null = null
  private graticuleVertexCount = 0
  private lastGratZoom = -1
  /** Toggle for the lat/lon grid overlay. Default OFF — the graticule
   *  was a dev/debug aid that shipped enabled; basemap-quality output
   *  should opt in. XGISMap exposes `setGraticuleEnabled()` so the
   *  host app + URL flags can flip it without rebuilding renderers. */
  private graticuleEnabled = false
  /** GPU-buffer cache mirroring graticule.ts's CPU-data cache.
   *  Keyed by GraticuleData IDENTITY — the underlying generator
   *  returns the same object for the same zoom bucket, so a Map
   *  keyed by reference avoids recomputing a bucket key here.
   *
   *  10 ms / call on Bright zoom animations (createBuffer +
   *  writeBuffer + destroy) fired exactly on LOD-boundary frames,
   *  doubling the worst-frame hitch. With this cache, re-entry into
   *  a previously-seen bucket is a pointer swap (~0 ms). */
  private graticuleBufferCache = new WeakMap<object, { buf: GPUBuffer; count: number }>()


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

  // Compute-paint scaffolding (plan P4-5). Lazily initialised on the
  // first request — the registry owns ComputeLayerHandle instances
  // and dispatches their kernels once per frame. Stays null until a
  // variant with `computeBindings` is encountered, so the production
  // path (no enableComputePath flag) pays nothing.
  private computeRegistry: ComputeLayerRegistry | null = null
  private computeDispatcher: ComputeDispatcher | null = null
  /** Per-variant cached extended bind-group layout (legacy feature
   *  entries + one read-only-storage per computeBindings spec). Keyed
   *  by `variant.key` — same key as `shaderCache` so a cache hit on
   *  one implies a hit on the other. Pipelines built against the
   *  legacy `featureBindGroupLayout` use that directly; compute
   *  variants take a freshly-built per-variant layout from here. */
  private variantComputeLayoutCache = new Map<string, GPUBindGroupLayout>()
  /** Scene plan provided by the orchestrator before addLayer is
   *  called. ComputeLayerHandle filters this by renderNodeIndex —
   *  the runtime never holds an opinion about which subset goes
   *  where; the variant.computeBindings + plan filter agree by
   *  construction (compiler post-condition). */
  private currentComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    this.initPipelines()
    // Graticule init is lazy — first frame after setGraticuleEnabled(true)
    // builds the buffer. Default off so the ctor stays cheap and the
    // grid doesn't render unless the host opts in.
  }

  /** Toggle the lat/lon grid overlay at runtime. Default off. */
  setGraticuleEnabled(on: boolean): void {
    this.graticuleEnabled = on
    if (on && !this.graticuleBuffer) this.initGraticule(this.lastGratZoom >= 0 ? this.lastGratZoom : 2)
  }

  /** Read the current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this.graticuleEnabled
  }

  /** Get-or-create the compute registry. Lazy because most scenes
   *  don't use the compute path; we don't want to allocate the
   *  dispatcher unless we actually have a compute kernel to run. */
  private ensureComputeRegistry(): ComputeLayerRegistry {
    if (this.computeRegistry) return this.computeRegistry
    this.computeDispatcher = new ComputeDispatcher(this.ctx)
    this.computeRegistry = new ComputeLayerRegistry(this.computeDispatcher)
    return this.computeRegistry
  }

  /** Run every attached compute kernel onto the encoder. Call ONCE
   *  per frame from the orchestrator (map.ts) BEFORE the first
   *  beginRenderPass — compute output buffers must be populated
   *  before the fragment shader reads them.
   *
   *  No-op when no compute layer is attached (the registry is null
   *  or empty). Safe to call unconditionally from the orchestrator. */
  dispatchComputePass(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    this.computeRegistry?.dispatchAll(encoder, timestampWritesProvider)
  }

  /** Hand the scene's compute plan to the renderer before issuing
   *  addLayer calls. ComputeLayerHandle filters the plan by
   *  `show.renderNodeIndex`; calling this with `undefined` clears
   *  the plan (back-compat for scenes without compute kernels). */
  setComputePlan(plan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined): void {
    this.currentComputePlan = plan
  }

  /** Return the bind-group layout the renderer should bind for a
   *  given variant. Variants without `computeBindings` keep using
   *  the shared `featureBindGroupLayout`; variants WITH compute
   *  bindings get a per-key extended layout (cached). The returned
   *  layout matches the bind-group entries `addLayer` constructs
   *  for the same variant — drift between the two surfaces as a
   *  WebGPU validation error at pipeline / bind-group create.
   *
   *  Public so VTR / point-renderer (which build their own per-tile
   *  bind groups against this same layout) can request the right
   *  layout per variant during their setBindGroupLayout / pipeline-
   *  build call sites. */
  getOrBuildVariantLayout(variant: ShaderVariantInfo): GPUBindGroupLayout {
    if (!variant.computeBindings || variant.computeBindings.length === 0) {
      return variant.needsFeatureBuffer ? this.featureBindGroupLayout : this.bindGroupLayout
    }
    const cached = this.variantComputeLayoutCache.get(variant.key)
    if (cached) return cached
    // Build extended entries from the legacy feature entries (the
    // single source of truth for the polygon path's uniform / feature-
    // data / palette layout). `extendBindGroupLayoutEntriesForCompute`
    // appends one read-only-storage entry per computeBindings spec at
    // the binding indices the compiler chose.
    const legacy = MapRenderer.FEATURE_LAYOUT_ENTRIES
    // FRAGMENT bit = 2 (raw spec value; see FEATURE_LAYOUT_ENTRIES
    // comment for why we don't reference GPUShaderStage here).
    const extended = extendBindGroupLayoutEntriesForCompute(
      variant, legacy, /* FRAGMENT */ 2,
    )
    const layout = this.ctx.device.createBindGroupLayout({
      label: `mr-featureBindGroupLayout-compute(${variant.key})`,
      entries: extended as GPUBindGroupLayoutEntry[],
    })
    this.variantComputeLayoutCache.set(variant.key, layout)
    return layout
  }

  /** Single source of truth for the legacy feature-bind-group entries.
   *  The constructor builds `featureBindGroupLayout` from these same
   *  values; `getOrBuildVariantLayout` reuses them as the base for
   *  compute-extended layouts so the two layouts agree on legacy
   *  bindings 0/1/2/4.
   *
   *  Visibility bits use the raw spec values (VERTEX=1, FRAGMENT=2,
   *  COMPUTE=4) instead of `GPUShaderStage.X` because this is a
   *  class-field initializer evaluated at module load; Node test
   *  environments don't define the WebGPU globals at that time.
   *  Browsers' WebGPU runtimes assign the same numeric values. */
  private static readonly FEATURE_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: /* VERTEX|FRAGMENT */ 3,
      buffer: { type: 'uniform' as const, hasDynamicOffset: true } },
    { binding: 1, visibility: /* FRAGMENT */ 2,
      buffer: { type: 'read-only-storage' as const } },
    { binding: 2, visibility: /* FRAGMENT */ 2,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const } },
    { binding: 4, visibility: /* FRAGMENT */ 2,
      sampler: { type: 'filtering' as const } },
  ]

  /** Rebuild all pipelines + invalidate shader variant cache. Called by
   *  `map.setQuality()` when MSAA or picking flip at runtime — both force
   *  a pipeline `sampleCount` / fragment-target-count change that's baked
   *  at pipeline creation. Non-pipeline state (bind group layouts, the
   *  uniform ring, graticule geometry) survives the rebuild unchanged. */
  rebuildForQuality(): void {
    // Toss the per-show variant pipelines — their shader embeds the
    // PICK markers too, and their `multisample.count` is frozen.
    // map.setQuality (the only caller) follows up with an eager
    // re-resolve loop over vectorTileShows that calls
    // getOrCreateVariantPipelines + getOrBuildVariantLayout so
    // pipelines AND layouts stay self-consistent. Lazy rebuild from the
    // draw path was previously promised in a comment here but never
    // wired — that promise let entry.pipelines stay null with
    // entry.layout still feature/compute, tripping per-frame
    // BindGroupLayout validation (see commit 6080a2f).
    this.shaderCache.clear()
    this.initPipelines()
    this.overdrawComposePipeline = null
  }

  /** Lazy-build the `?debug=overdraw` final compose pipeline. Samples
   *  the r16float overdraw accumulator and writes a heat-colormapped
   *  RGBA to the swapchain. SampleCount = 1 (debug mode forces MSAA
   *  off in `quality.ts`), so this pipeline never needs MSAA variants.
   *  Idempotent — first call builds, subsequent calls reuse. */
  ensureOverdrawCompose(): GPURenderPipeline {
    if (this.overdrawComposePipeline) return this.overdrawComposePipeline
    const { device, format } = this.ctx
    const code = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs_full(@builtin(vertex_index) idx: u32) -> VsOut {
  // Oversized triangle covering NDC — same trick as oit-compose.
  var pos: vec2<f32>;
  if (idx == 0u)      { pos = vec2<f32>(-1.0, -1.0); }
  else if (idx == 1u) { pos = vec2<f32>( 3.0, -1.0); }
  else                { pos = vec2<f32>(-1.0,  3.0); }
  var out: VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  // y-flip — texture origin top-left, NDC origin bottom-left.
  out.uv = vec2<f32>((pos.x + 1.0) * 0.5, 1.0 - (pos.y + 1.0) * 0.5);
  return out;
}

@group(0) @binding(0) var accum_tex: texture_2d<f32>;

// Heat colormap — black → blue → green → yellow → red → white. Tuned
// so 1-2 overdraws are visibly cool, 8 mid-warm, 16+ saturated red.
fn colormap(t: f32) -> vec3<f32> {
  let s = clamp(t, 0.0, 1.0);
  // 4-stop piecewise: dark navy (0, 0.05, 0.2) → cyan (0, 0.6, 0.6) →
  // yellow (1, 1, 0) → red (1, 0.2, 0). Polynomial fit, no branching.
  let r = clamp(s * 3.0 - 0.5, 0.0, 1.0);
  let g = clamp(s * 2.5, 0.0, 1.0) * clamp(2.0 - s * 2.0, 0.0, 1.0);
  let b = clamp(0.6 - s * 1.5, 0.0, 1.0);
  return vec3<f32>(r, g, b);
}

@fragment
fn fs_compose(in: VsOut) -> @location(0) vec4<f32> {
  let dim = vec2<f32>(textureDimensions(accum_tex));
  let uv = vec2<i32>(in.uv * dim);
  let count = textureLoad(accum_tex, uv, 0).r;
  if (count < 0.5) {
    // No fragments → empty pixel, leave dark to distinguish from "1 draw".
    return vec4<f32>(0.02, 0.02, 0.04, 1.0);
  }
  // Exposure: 16 overdraws → fully saturated. Tunable constant; viable
  // range 8 (label-heavy scenes) to 32 (extruded-building scenes).
  let t = count / 16.0;
  return vec4<f32>(colormap(t), 1.0);
}
`
    const module = device.createShaderModule({ code, label: 'overdraw-compose-shader' })
    this.overdrawComposeBindGroupLayout = device.createBindGroupLayout({
      label: 'overdraw-compose-bgl',
      entries: [{
        binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', multisampled: false },
      }],
    })
    this.overdrawComposePipeline = device.createRenderPipeline({
      label: 'overdraw-compose-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.overdrawComposeBindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_full' },
      fragment: {
        module, entryPoint: 'fs_compose',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    })
    return this.overdrawComposePipeline
  }

  private initPipelines(): void {
    const { device, format } = this.ctx

    // Splice the pick output into the shader template when `?picking=1`
    // is enabled. Keeps the default (no-pick) shader byte-identical with
    // the prior build — existing deployments see no change.
    const pickShader = POLYGON_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
      .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(input.feat_id, u.pick_id);' : '')
    const shaderModule = device.createShaderModule({
      code: pickShader,
      label: 'xgis-shader',
    })

    // P3 Step 3c — palette gradient atlas bindings on group 0:
    //   binding 2: rgba8unorm 2-D atlas of pre-baked color gradients
    //              (one row per gradient, GRADIENT_WIDTH texels wide).
    //   binding 4: linear-filter sampler shared by every gradient
    //              sample call site. (Binding 3 is reserved for the
    //              scalar atlas; not wired yet — scalars stay on the
    //              CPU resolve path until r32float-vs-filterable is
    //              resolved.)
    // Both base and feature layouts include these so the variant
    // pipeline can validate against either, regardless of whether the
    // layer also needs the per-feature data buffer.
    const paletteLayoutEntries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'mr-baseBindGroupLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        ...paletteLayoutEntries,
      ],
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
        ...paletteLayoutEntries,
      ],
    })

    // Device-lifetime 1×1 stub color texture + linear sampler. Every
    // pipeline created against the layouts above must bind SOMETHING
    // at bindings 2 / 4 to satisfy WebGPU validation, even when the
    // layer has no zoom-interpolated paint. P3 Step 3c proper will
    // swap the stub for `uploadPalette`'s real atlas; until then the
    // stubs keep existing bind groups valid + the visual unchanged.
    this.paletteStubTexture = device.createTexture({
      label: 'mr-palette-stub-color',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: this.paletteStubTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    )
    this.paletteStubTextureView = this.paletteStubTexture.createView()
    this.paletteColorAtlasView = this.paletteStubTextureView
    this.paletteSampler = device.createSampler({
      label: 'mr-palette-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    // Outer scope of constructor — methods that need re-bind on
    // palette swap close over `device` via `this.ctx.device`.

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

    // `?debug=overdraw` — fill + line debug mirrors. Same VS as the
    // opaque pipelines so the rasterizer produces matching fragment
    // coverage; FS collapses to `fs_overdraw` (constant 1.0 R, alpha
    // 0). Color target r16float + additive blend accumulates fragment
    // counts. Depth-stencil `always` + no writes so every rasterized
    // fragment contributes (submitted overdraw, the MapLibre debug-
    // mode convention). One pipeline per primitive type covers every
    // fill / line draw in the opaque bucket — map.ts overrides
    // cs.fp / cs.lp / cs.fpF etc. to point at these in debug mode.
    if (DEBUG_OVERDRAW) {
      const overdrawTargets: GPUColorTargetState[] = [{
        format: 'r16float',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }]
      const overdrawDepthStencil: GPUDepthStencilState = {
        format: 'depth24plus-stencil8',
        depthCompare: 'always',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      }
      this.fillPipelineOverdraw = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'fill-pipeline-overdraw',
      })
      // Feature-layout variant — for data-driven shows whose bgl is
      // `featureBindGroupLayout`. WebGPU compares bind-group layouts
      // by identity, so we need a dedicated pipeline whose
      // pipelineLayout references the same featureBindGroupLayout.
      const featurePipelineLayout = device.createPipelineLayout({
        label: 'mr-overdrawPipelineLayout(feature)',
        bindGroupLayouts: [this.featureBindGroupLayout],
      })
      this.fillPipelineOverdrawFeature = device.createRenderPipeline({
        layout: featurePipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'fill-pipeline-overdraw-feature',
      })
      this.linePipelineOverdraw = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'line-pipeline-overdraw',
      })
    }

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
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
      ],
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
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
      ],
    })
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
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

        // ─── Compute path attach (P4-5 integration step 2) ───
        // When the variant carries `computeBindings`, attach a handle
        // BEFORE building the per-layer bind group so the compute
        // output buffer exists by the time we append its entry. The
        // registry filters the scene plan by renderNodeIndex; drift
        // between (variant.computeBindings.length) and
        // (plan entries with this index) propagates as a thrown error
        // from ComputeLayerHandle — surfacing the
        // compiler / runtime contract violation before the WebGPU
        // pipeline build does.
        let extraComputeEntries: { binding: number; resource: { buffer: GPUBuffer } }[] = []
        if ((variant.computeBindings?.length ?? 0) > 0 && show.renderNodeIndex !== undefined) {
          const registry = this.ensureComputeRegistry()
          const handle = registry.attach(
            show.targetName,
            variant,
            this.currentComputePlan,
            show.renderNodeIndex,
          )
          if (handle) {
            // Pack feature properties for the compute kernel(s). The
            // handle's TileComputeResources owns its own packer; we
            // pass a fid→props lookup mirroring the polygon feature
            // array's order (fid = polygons.features index).
            handle.uploadFromProps(
              (fid) => polygons.features[fid]?.properties ?? null,
              featureCount,
            )
            const bg = handle.getBindGroupEntries()
            if (bg) extraComputeEntries = bg
          }
        }

        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.getOrBuildVariantLayout(variant),
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            ...extraComputeEntries,
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

  /** P3 Step 3c — swap the bound color gradient atlas. Caller uploads
   *  the texture via `uploadPalette` (palette-texture.ts), then hands
   *  the returned `colorPalette.createView()` here. We rebuild every
   *  bind group that referenced the previous view (default + every
   *  per-layer feature group) so the next frame samples the real
   *  atlas instead of the 1×1 transparent stub.
   *
   *  Mirrors `setBindGroupLayout` lifecycle — caller invokes once per
   *  scene compile (palette is scene-scoped). */
  setPaletteColorAtlas(view: GPUTextureView): void {
    this.paletteColorAtlasView = view
    if (this.bindGroup) {
      this.bindGroup = this.ctx.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
          { binding: 2, resource: this.paletteColorAtlasView },
          { binding: 4, resource: this.paletteSampler },
        ],
      })
    }
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        // Preserve compute output entries on palette swap. The
        // registry still owns the handle (palette changes are scene-
        // level, layer set is untouched); we look up the handle by
        // the same `targetName` key addLayer used. No-op for legacy
        // variants.
        const variant = layer.show.shaderVariant as ShaderVariantInfo | null | undefined
        const computeEntries = variant?.computeBindings
          ? (this.computeRegistry?.getHandle(layer.show.targetName)?.getBindGroupEntries() ?? [])
          : []
        layer.perLayerBindGroup = this.ctx.device.createBindGroup({
          layout: variant ? this.getOrBuildVariantLayout(variant) : this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MapRenderer.UNIFORM_SIZE } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            ...computeEntries,
          ],
        })
      }
    }
  }

  /** Get or create variant pipelines (public for vector tile renderer) */
  getOrCreateVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const cached = this.shaderCache.get(variant.key)
    if (cached) return cached
    const pipelines = this.createVariantPipelines(variant)
    this.shaderCache.set(variant.key, pipelines)
    return pipelines
  }

  /** Async prewarm — calls `createRenderPipelineAsync` for every
   *  pipeline in every variant and awaits resolution before
   *  populating `shaderCache`. Subsequent sync
   *  `getOrCreateVariantPipelines` calls in `rebuildLayers` then
   *  hit the cache and the driver is guaranteed to have already
   *  finished compiling.
   *
   *  Why this exists: WebGPU's sync `createRenderPipeline` returns
   *  a pipeline handle immediately while the driver compiles
   *  lazily on first draw. On filter_gdp at z=8 Europe cold-start
   *  this produced a ~1.7 s post-ready hitch frame (CPU profile
   *  showed >60 % `(idle)` — JS thread was waiting for the GPU
   *  queue to drain the inline compile). Switching to the async
   *  variant + awaiting before `__xgisReady` flips moves the
   *  driver work off the user-visible critical path. */
  async prewarmShaderVariantsAsync(variants: ShaderVariantInfo[]): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const v of variants) {
      if (this.shaderCache.has(v.key)) continue
      tasks.push(this.createVariantPipelinesAsync(v).then((pipelines) => {
        this.shaderCache.set(v.key, pipelines)
      }))
    }
    if (tasks.length > 0) await Promise.all(tasks)
  }

  /** Create specialized fill + line pipelines for a shader variant.
   *  Builds two parallel sets when picking is enabled — pickable
   *  (writeMask:ALL on the pick attachment) and non-pickable
   *  (writeMask:0). The bucket scheduler picks the right one based on
   *  each show's `pointerEvents`. When picking is globally off, the
   *  no-pick fields alias the pickable ones (no pick attachment to
   *  mask). */
  /** Build the per-variant pipeline descriptor set + the shared
   *  shader module / layouts. Pure data construction — no GPU calls
   *  beyond shader/layout creation, which the spec defines as
   *  cheap. Used by both sync (`createVariantPipelines`) and async
   *  (`createVariantPipelinesAsync`) entry points so the descriptor
   *  shape stays in one place. */
  private buildVariantDescriptors(variant: ShaderVariantInfo): {
    descriptors: { fill: GPURenderPipelineDescriptor; fillGround: GPURenderPipelineDescriptor; line: GPURenderPipelineDescriptor; fillFallback: GPURenderPipelineDescriptor; fillGroundFallback: GPURenderPipelineDescriptor; lineFallback: GPURenderPipelineDescriptor }[]
    pickEnabled: boolean
  } {
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

    // Compute-aware layout pick: extended layout when the variant
    // carries `computeBindings`, otherwise the legacy
    // featureBindGroupLayout / bindGroupLayout. Pipeline + per-layer
    // bind group must agree on the extended layout — both reach the
    // same `getOrBuildVariantLayout` cache entry.
    const layout = this.getOrBuildVariantLayout(variant)
    const layoutLabel = (variant.computeBindings?.length ?? 0) > 0
      ? 'compute'
      : (variant.needsFeatureBuffer ? 'feature' : 'base')
    const pipelineLayout = device.createPipelineLayout({
      label: `mr-variantPipelineLayout(${layoutLabel})`,
      bindGroupLayouts: [layout],
    })

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

    const buildSetDesc = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-${variant.key}${suffix}`,
      },
      fillGround: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-${variant.key}${suffix}`,
      },
      line: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-${variant.key}${suffix}`,
      },
      fillFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-fallback-${variant.key}${suffix}`,
      },
      fillGroundFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_quantized', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-fallback-${variant.key}${suffix}`,
      },
      lineFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-fallback-${variant.key}${suffix}`,
      },
    })

    const descriptors = [buildSetDesc(colorTargets, '')]
    if (pickEnabled) descriptors.push(buildSetDesc(colorTargetsNoPick, '-nopick'))
    return { descriptors, pickEnabled }
  }

  private async createVariantPipelinesAsync(variant: ShaderVariantInfo): Promise<CachedPipeline> {
    const { device } = this.ctx
    const { descriptors, pickEnabled } = this.buildVariantDescriptors(variant)
    const built = await Promise.all(descriptors.map(async (set) => ({
      fill:               await device.createRenderPipelineAsync(set.fill),
      fillGround:         await device.createRenderPipelineAsync(set.fillGround),
      line:               await device.createRenderPipelineAsync(set.line),
      fillFallback:       await device.createRenderPipelineAsync(set.fillFallback),
      fillGroundFallback: await device.createRenderPipelineAsync(set.fillGroundFallback),
      lineFallback:       await device.createRenderPipelineAsync(set.lineFallback),
    })))
    const p = built[0]
    const np = pickEnabled ? built[1] : p
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

    // Use the compute-aware layout (extended when variant carries
    // computeBindings, legacy otherwise). Matches `buildVariantDescriptors`
    // above so the cache key + pipeline layout stay in sync.
    const layout = this.getOrBuildVariantLayout(variant)
    const layoutLabel = (variant.computeBindings?.length ?? 0) > 0
      ? 'compute'
      : (variant.needsFeatureBuffer ? 'feature' : 'base')
    const pipelineLayout = device.createPipelineLayout({
      label: `mr-variantPipelineLayout(${layoutLabel})`,
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
    // Same GraticuleData reference → same bucket as last call →
    // GPU buffer is already correct, no need to destroy/create/upload.
    const cached = this.graticuleBufferCache.get(grat)
    if (cached) {
      this.graticuleBuffer = cached.buf
      this.graticuleVertexCount = cached.count
      this.lastGratZoom = zoom
      return
    }
    // Don't destroy the previous buffer — it's still referenced by
    // a cached entry for its own bucket. The WeakMap holds references
    // alive while their bucket is reachable; when graticule.ts's
    // bucket cache evicts (currently never), the GraticuleData object
    // becomes unreachable and the WeakMap entry GCs along with the
    // GPUBuffer.
    const buf = this.ctx.device.createBuffer({
      size: grat.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'graticule',
    })
    this.ctx.device.queue.writeBuffer(buf, 0, grat.vertices)
    this.graticuleBufferCache.set(grat, { buf, count: grat.indexCount })
    this.graticuleBuffer = buf
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
    // Drop every compute handle's GPU buffers. The registry survives
    // (lazy-allocated, cheap to re-fill); `destroyAll` only frees
    // owned device memory. Production never enters this branch
    // because no variant carries `computeBindings` today.
    this.computeRegistry?.destroyAll()
  }

  /** Render all layers into an existing render pass (RTC projection) */
  renderToPass(pass: GPURenderPassEncoder, camera: Camera, projType = 0, projCenterLon = 0, projCenterLat = 20, elapsedMs = 0): void {
    // Overdraw-debug v1: legacy MapRenderer layers (graticule, etc.)
    // bake their pipeline against the swapchain format. The pass
    // attachment in debug mode is r16float — formats mismatch. Skip
    // entirely. Vector content goes through VTR, not this path.
    if (DEBUG_OVERDRAW) return
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

      // Opacity / fill / stroke — read straight off the typed
      // `paintShapes` bundle the compiler / interpreter populated.
      // For `constant` shapes the renderer keeps using the dynamic
      // `props` store so `props.setOverride('opacity', X)` keeps
      // working at runtime; for the four animated kinds the resolver
      // takes precedence.
      const ps = layer.show.paintShapes
      const opacity = ps.opacity.kind === 'constant'
        ? layer.props.getNumber('opacity', 1.0)
        : resolveNumberShape(ps.opacity, camera.zoom, elapsedMs).value

      let fillRaw = layer.props.getColor('fill')
      let strokeRaw = layer.props.getColor('stroke')
      if (ps.fill !== null) {
        const r = resolveColorShape(ps.fill, camera.zoom, elapsedMs)
        if (r !== null) fillRaw = [r.value[0], r.value[1], r.value[2], r.value[3]]
      }
      if (ps.stroke !== null) {
        const r = resolveColorShape(ps.stroke, camera.zoom, elapsedMs)
        if (r !== null) strokeRaw = [r.value[0], r.value[1], r.value[2], r.value[3]]
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
      // clip_bounds (160-175): sentinel "no clip" — non-tiled layers
      // own their entire screen area, no per-tile fallback clipping
      // applies. The fragment shader's `clip_bounds.x > -1e29` gate
      // skips the discard test entirely. Without this write the
      // shader reads garbage at byte 160 (the sentinel happens to be
      // an unusual value) and discards most fragments — the symptom
      // was the hero map showing only ~1/4 of the world after the
      // per-tile clip mask landed in 9c026b3.
      new Float32Array(uniformData, 160, 4).set([-1e30, 0, 0, 0])
      // zoom + 3-float pad (offsets 176-191) — P3 palette gradient
      // sample reads u.zoom. Pad slots stay zero; total struct size
      // is now 192 bytes (UNIFORM_SIZE constant).
      new Float32Array(uniformData, 176, 4).set([camera.zoom, 0, 0, 0])
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

    // Regenerate graticule if zoom level changed (adaptive spacing).
    // Skip entirely when disabled so the GPU buffer + writeBuffer
    // churn stays out of the hot path for default-off basemaps.
    if (this.graticuleEnabled) {
      const gratZoom = Math.round(camera.zoom)
      if (gratZoom !== this.lastGratZoom) {
        this.initGraticule(gratZoom)
      }
    }

    // Draw graticule grid lines (primary world + copies)
    // Each world copy needs its own uniform buffer (WebGPU batches writeBuffer)
    if (this.graticuleEnabled && this.graticuleBuffer) {
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
        const gratData = new ArrayBuffer(MapRenderer.UNIFORM_SIZE)
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
        // clip_bounds sentinel — same rationale as the polygon path.
        new Float32Array(gratData, 160, 4).set([-1e30, 0, 0, 0])
        const gratOff = this.allocUniformSlot()
        this.stageUniformSlot(gratOff, gratData)

        pass.setBindGroup(0, this.bindGroup, [gratOff])
        pass.draw(this.graticuleVertexCount)
      }
    }

    // pass.end() and submit() are handled by caller
  }
}
