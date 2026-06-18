// baseline: b0ed99d96cebee92acc41fa58995f0b4d4361331
// fixture: syn-zoom3
// variant.key: syn-zoom3
// pick: false
// note: Synthetic — 3-stop zoom-interpolated fill with consts + nested mix().
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;

fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32> {
  let z = ((log2(max(0.000001, (pos.w + 1.0))) * fc) * pos.w);
  return vec4<f32>(pos.x, pos.y, z, pos.w);
}

fn compute_log_frag_depth(view_w: f32, fc: f32) -> f32 {
  return (log2(max(0.000001, (view_w + 1.0))) * fc);
}

fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = clamp(lat_deg, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let x = ((lon_deg * DEG2RAD) * EARTH_R);
  let y = (log(tan(((PI / 4.0) + ((lat * DEG2RAD) / 2.0)))) * EARTH_R);
  return vec2<f32>(x, y);
}

fn wrap_lon_delta(d: f32) -> f32 {
  if ((d > 180.0)) {
    return (d - (ceil(((d - 180.0) / 360.0)) * 360.0));
  }
  if ((d < -180.0)) {
    return (d + (ceil((((-d) - 180.0) / 360.0)) * 360.0));
  }
  return d;
}

fn proj_equirectangular_d(lon_rel: f32, lat_deg: f32) -> vec2<f32> {
  return vec2<f32>(((lon_rel * DEG2RAD) * EARTH_R), ((lat_deg * DEG2RAD) * EARTH_R));
}

fn proj_natural_earth_d(lon_rel: f32, lat_deg: f32) -> vec2<f32> {
  let lat = (lat_deg * DEG2RAD);
  let lat2 = (lat * lat);
  let lat4 = (lat2 * lat2);
  let lat6 = (lat2 * lat4);
  let x_scale = (((0.8707 - (lat2 * 0.131979)) + (lat4 * 0.013791)) - (lat6 * 0.0081435));
  let y_val = (lat * (1.007226 + (lat2 * (0.015085 + (lat2 * ((-0.044475 + (lat2 * 0.028874)) - (lat4 * 0.005916)))))));
  return vec2<f32>((((lon_rel * DEG2RAD) * x_scale) * EARTH_R), (y_val * EARTH_R));
}

fn proj_equirectangular(lon_deg: f32, lat_deg: f32, clon: f32) -> vec2<f32> {
  return proj_equirectangular_d(wrap_lon_delta((lon_deg - clon)), lat_deg);
}

fn proj_natural_earth(lon_deg: f32, lat_deg: f32, clon: f32) -> vec2<f32> {
  return proj_natural_earth_d(wrap_lon_delta((lon_deg - clon)), lat_deg);
}

fn unwrap_lon_near(value: f32, ref_v: f32) -> f32 {
  return (value - (floor((((value - ref_v) + 180.0) / 360.0)) * 360.0));
}

fn unwrap_lon_near_keep(value: f32, ref_v: f32, keep_sign: f32) -> f32 {
  return (value - (floor(((((value - ref_v) + 180.0) - (keep_sign * 0.0001)) / 360.0)) * 360.0));
}

fn unwrap_rad_near(value: f32, ref_v: f32) -> f32 {
  let two_pi = (PI * 2.0);
  return (value - (floor((((value - ref_v) + PI) / two_pi)) * two_pi));
}

fn proj_orthographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let l0 = (clon * DEG2RAD);
  let p0 = (clat * DEG2RAD);
  let x = ((EARTH_R * cos(phi)) * sin((lam - l0)));
  let y = (EARTH_R * ((cos(p0) * sin(phi)) - ((sin(p0) * cos(phi)) * cos((lam - l0)))));
  return vec2<f32>(x, y);
}

fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let l0 = (clon * DEG2RAD);
  let p0 = (clat * DEG2RAD);
  let cos_c = ((sin(p0) * sin(phi)) + ((cos(p0) * cos(phi)) * cos((lam - l0))));
  let c = acos(clamp(cos_c, -1.0, 1.0));
  if ((c < 0.0001)) {
    return vec2<f32>(0.0, 0.0);
  }
  let k = (c / sin(c));
  let x = (((EARTH_R * k) * cos(phi)) * sin((lam - l0)));
  let y = ((EARTH_R * k) * ((cos(p0) * sin(phi)) - ((sin(p0) * cos(phi)) * cos((lam - l0)))));
  return vec2<f32>(x, y);
}

fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let l0 = (clon * DEG2RAD);
  let p0 = (clat * DEG2RAD);
  let cos_c = ((sin(p0) * sin(phi)) + ((cos(p0) * cos(phi)) * cos((lam - l0))));
  if ((cos_c < -0.9)) {
    return vec2<f32>(1000000000000000.0, 1000000000000000.0);
  }
  let k = (2.0 / (1.0 + cos_c));
  let x = (((EARTH_R * k) * cos(phi)) * sin((lam - l0)));
  let y = ((EARTH_R * k) * ((cos(p0) * sin(phi)) - ((sin(p0) * cos(phi)) * cos((lam - l0)))));
  return vec2<f32>(x, y);
}

fn oblique_rot(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let l0 = (clon * DEG2RAD);
  let p0 = (clat * DEG2RAD);
  let d_lam = (lam - l0);
  let phi_rot = asin(clamp(((sin(phi) * cos(p0)) - ((cos(phi) * sin(p0)) * cos(d_lam))), -1.0, 1.0));
  let lam_rot = atan2((cos(phi) * sin(d_lam)), ((sin(phi) * sin(p0)) + ((cos(phi) * cos(p0)) * cos(d_lam))));
  return vec2<f32>(lam_rot, phi_rot);
}

fn proj_oblique_mercator_d(lam_rot: f32, phi_rot: f32) -> vec2<f32> {
  let phi_clamped = clamp(phi_rot, (-(89.9999 * DEG2RAD)), (89.9999 * DEG2RAD));
  let x = (EARTH_R * lam_rot);
  let y = (EARTH_R * log(tan(((PI / 4.0) + (phi_clamped / 2.0)))));
  return vec2<f32>(x, y);
}

fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let r = oblique_rot(lon_deg, lat_deg, clon, clat);
  return proj_oblique_mercator_d(r.x, r.y);
}

fn proj_globe(lon_deg: f32, lat_deg: f32) -> vec3<f32> {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let cphi = cos(phi);
  return vec3<f32>(((EARTH_R * cphi) * cos(lam)), ((EARTH_R * cphi) * sin(lam)), (EARTH_R * sin(phi)));
}

fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let lam = (lon_deg * DEG2RAD);
  let phi = (lat_deg * DEG2RAD);
  let l0 = (clon * DEG2RAD);
  let p0 = (clat * DEG2RAD);
  return ((sin(p0) * sin(phi)) + ((cos(p0) * cos(phi)) * cos((lam - l0))));
}

fn project(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> vec2<f32> {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if ((t < 0.5)) {
    return proj_mercator(lon_deg, lat_deg);
  } else if ((t < 1.5)) {
    return proj_equirectangular(lon_deg, lat_deg, clon);
  } else if ((t < 2.5)) {
    return proj_natural_earth(lon_deg, lat_deg, clon);
  } else if ((t < 3.5)) {
    return proj_orthographic(lon_deg, lat_deg, clon, clat);
  } else if ((t < 4.5)) {
    return proj_azimuthal_equidistant(lon_deg, lat_deg, clon, clat);
  } else if ((t < 5.5)) {
    return proj_stereographic(lon_deg, lat_deg, clon, clat);
  } else {
    return proj_oblique_mercator(lon_deg, lat_deg, clon, clat);
  }
}

fn project_geom(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32> {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if (((t > 0.5) && (t < 2.5))) {
    let wo = floor((((ref_lon - clon) + 180.0) / 360.0));
    let lon_primary = (lon_deg - (wo * 360.0));
    let ref_primary = (ref_lon - (wo * 360.0));
    let ref_d = wrap_lon_delta((ref_primary - clon));
    let lon_rel_ref = unwrap_lon_near_keep((lon_primary - ref_primary), 0.0, sign(lon_primary));
    let d = (lon_rel_ref + ref_d);
    let world_off_m = (((wo * 2.0) * PI) * EARTH_R);
    var p: vec2<f32>;
    if ((t < 1.5)) {
      p = proj_equirectangular_d(d, lat_deg);
    } else {
      let dw = wrap_lon_delta(d);
      let k = floor((((d - dw) / 360.0) + 0.5));
      p = proj_natural_earth_d(dw, lat_deg);
      p.x = (p.x + (((k * 2.0) * PI) * EARTH_R));
    }
    p.x = (p.x + world_off_m);
    return p;
  }
  if ((t > 5.5)) {
    let wo = floor((((ref_lon - clon) + 180.0) / 360.0));
    let lon_primary = (lon_deg - (wo * 360.0));
    let ref_primary = (ref_lon - (wo * 360.0));
    let r = oblique_rot(lon_primary, lat_deg, clon, clat);
    let ref_r = oblique_rot(ref_primary, clat, clon, clat);
    let lam_u = unwrap_rad_near(r.x, ref_r.x);
    var p: vec2<f32> = proj_oblique_mercator_d(lam_u, r.y);
    p.x = (p.x + (((wo * 2.0) * PI) * EARTH_R));
    return p;
  }
  return project(lon_deg, lat_deg, proj_params);
}

fn flat_rel(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32> {
  let pv = project_geom(lon_deg, lat_deg, proj_params, ref_lon);
  let cv = project(proj_params.y, proj_params.z, proj_params);
  return (pv - cv);
}

fn needs_backface_cull(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32 {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if ((t > 2.5)) {
    let cc = center_cos_c(lon_deg, lat_deg, clon, clat);
    if ((t < 3.5)) {
      return cc;
    }
    if ((t < 4.5)) {
      return select(-1.0, 1.0, (cc > -0.85));
    }
    if ((t < 5.5)) {
      return select(-1.0, 1.0, (cc > -0.8));
    }
    if ((t < 6.5)) {
      return 1.0;
    }
    return cc;
  }
  return 1.0;
}

fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32 {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if ((t > 2.5)) {
    let cc = center_cos_c(lon_deg, lat_deg, clon, clat);
    if ((t < 3.5)) {
      return smoothstep(0.0, 0.02, cc);
    }
    if ((t < 4.5)) {
      return smoothstep(-0.85, -0.83, cc);
    }
    if ((t < 5.5)) {
      return smoothstep(-0.8, -0.78, cc);
    }
    if ((t < 6.5)) {
      return 1.0;
    }
    return smoothstep(0.0, 0.02, cc);
  }
  return 1.0;
}

fn inv_merc_lat_rad(merc_y_m: f32) -> f32 {
  return ((2.0 * atan(exp((merc_y_m / EARTH_R)))) - (PI / 2.0));
}

struct Uniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  proj_params: vec4<f32>,
  cam_h: vec2<f32>,
  cam_l: vec2<f32>,
  tile_origin_merc: vec2<f32>,
  opacity: f32,
  log_depth_fc: f32,
  pick_id: u32,
  layer_depth_offset: f32,
  tile_extent_m: f32,
  extrude_height_m: f32,
  clip_bounds: vec4<f32>,
  zoom: f32,
  extrude_base_m: f32,
  fill_translate_x: f32,
  fill_translate_y: f32,
  tile_dequant_scale: f32,
  tile_dequant_half: f32,
  cam_ecef_off_h: vec4<f32>,
  cam_ecef_off_l: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) cos_c: f32,
  @location(1) @interpolate(flat) feat_id: u32,
  @location(2) abs_lat: f32,
  @location(3) view_w: f32,
  @location(4) wall_blend: f32,
  @location(5) abs_merc_x: f32,
  @location(6) abs_merc_y: f32,
  @location(7) world_z: f32,
  @location(8) v_color: vec4<f32>,
}

struct OitFragmentOutput {
  @location(0) accum: vec4<f32>,
  @location(1) revealage: f32,
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(5) var sprite_atlas: texture_2d<f32>;
@group(0) @binding(6) var sprite_samp: sampler;

// ── Specialized constants ──
const Z3_0: vec4<f32> = vec4<f32>(1.0, 0.0, 0.0, 1.0);
const Z3_1: vec4<f32> = vec4<f32>(0.0, 1.0, 0.0, 1.0);
const Z3_2: vec4<f32> = vec4<f32>(0.0, 0.0, 1.0, 1.0);

fn dequant_ecef(q_xy: vec4<u32>, q_z: vec2<u32>, scale: f32, half: f32) -> vec3<f32> {
  let qx = ((f32(q_xy.x) * 65536.0) + f32(q_xy.y));
  let qy = ((f32(q_xy.z) * 65536.0) + f32(q_xy.w));
  let qz = ((f32(q_z.x) * 65536.0) + f32(q_z.y));
  return vec3<f32>(((qx * scale) - half), ((qy * scale) - half), ((qz * scale) - half));
}

fn polygon_cos_c_fragment(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  let abs_lon = (abs_merc_x / (DEG2RAD * EARTH_R));
  let lat_rad = inv_merc_lat_rad(abs_merc_y);
  let abs_lat = (lat_rad / DEG2RAD);
  return needs_backface_cull(abs_lon, abs_lat, u.proj_params);
}

fn polygon_rim_alpha(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  let abs_lon = (abs_merc_x / (DEG2RAD * EARTH_R));
  let lat_rad = inv_merc_lat_rad(abs_merc_y);
  let abs_lat = (lat_rad / DEG2RAD);
  return rim_alpha(abs_lon, abs_lat, u.proj_params);
}

@vertex
fn vs_main(@location(0) pos_h: vec3<f32>, @location(1) pos_l: vec3<f32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32) -> VertexOutput {
  let ecef_rtc = (pos_h + pos_l);
  let abs_merc_x = ((abs_lon * DEG2RAD) * EARTH_R);
  let abs_lat_clamped = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let abs_merc_y = (log(tan(((PI / 4.0) + ((abs_lat_clamped * DEG2RAD) / 2.0)))) * EARTH_R);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    let p2d = project(abs_lon, abs_lat, u.proj_params);
    let rel2d = (((p2d - u.tile_origin_merc) - u.cam_h) - u.cam_l);
    let tile_ref_lon = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
    let wo = floor(((tile_ref_lon + 180.0) / 360.0));
    let world_off_m = (((wo * 2.0) * PI) * EARTH_R);
    clip = (u.mvp * vec4<f32>((rel2d.x + world_off_m), rel2d.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    let tile_ref_lon = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
    let rel2d_geom = flat_rel(abs_lon, abs_lat, u.proj_params, tile_ref_lon);
    clip = (u.mvp * vec4<f32>(rel2d_geom.x, rel2d_geom.y, 0.0, 1.0));
  } else {
    let ecef_cam = ((ecef_rtc + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z));
    clip = (u.mvp * vec4<f32>(ecef_cam, 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  out.wall_blend = 1.0;
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  out.world_z = 0.0;
  out.v_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return out;
}

@vertex
fn vs_main_ecef(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) true_lat: f32) -> VertexOutput {
  let ecef_rtc = dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half);
  let abs_merc_x = (abs_lon + u.tile_origin_merc.x);
  let abs_merc_y = (abs_lat + u.tile_origin_merc.y);
  let abs_lat_clamped = clamp((inv_merc_lat_rad(abs_merc_y) / DEG2RAD), (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    let rel2d_local = ((vec2<f32>(abs_lon, abs_lat) - u.cam_h) - u.cam_l);
    clip = (u.mvp * vec4<f32>(rel2d_local.x, rel2d_local.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    let tile_ref_lon = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
    let rel2d_geom = flat_rel((abs_merc_x / (DEG2RAD * EARTH_R)), true_lat, u.proj_params, tile_ref_lon);
    clip = (u.mvp * vec4<f32>(rel2d_geom.x, rel2d_geom.y, 0.0, 1.0));
  } else {
    let ecef_cam = ((ecef_rtc + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z));
    clip = (u.mvp * vec4<f32>(ecef_cam, 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  out.wall_blend = 1.0;
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  out.world_z = 0.0;
  out.v_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return out;
}

@vertex
fn vs_main_ecef_extruded(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) face_normal: vec3<f32>, @location(6) wall_height: f32, @location(7) is_top: f32) -> VertexOutput {
  let ecef_rtc = dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half);
  let abs_merc_x = ((abs_lon * DEG2RAD) * EARTH_R);
  let abs_lat_clamped = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let abs_merc_y = (log(tan(((PI / 4.0) + ((abs_lat_clamped * DEG2RAD) / 2.0)))) * EARTH_R);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    let z_plane = (wall_height * is_top);
    let p2d = project(abs_lon, abs_lat, u.proj_params);
    let rel2d = (((p2d - u.tile_origin_merc) - u.cam_h) - u.cam_l);
    let tile_ref_lon = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
    let wo = floor(((tile_ref_lon + 180.0) / 360.0));
    let world_off_m = (((wo * 2.0) * PI) * EARTH_R);
    clip = (u.mvp * vec4<f32>((rel2d.x + world_off_m), rel2d.y, z_plane, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    let tile_ref_lon = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
    let rel2d_geom = flat_rel(abs_lon, abs_lat, u.proj_params, tile_ref_lon);
    let z_plane_geom = (wall_height * is_top);
    clip = (u.mvp * vec4<f32>(rel2d_geom.x, rel2d_geom.y, z_plane_geom, 1.0));
  } else {
    let ecef_cam = ((ecef_rtc + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z));
    clip = (u.mvp * vec4<f32>(ecef_cam, 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = abs_lat_clamped;
  out.wall_blend = is_top;
  out.abs_merc_x = abs_merc_x;
  out.abs_merc_y = abs_merc_y;
  out.world_z = (wall_height * is_top);
  let color_rgb = u.fill_color.rgb;
  let opacity = u.fill_color.w;
  let colorvalue = (((color_rgb.x * 0.2126) + (color_rgb.y * 0.7152)) + (color_rgb.z * 0.0722));
  let ambient = vec3<f32>(0.03);
  let lit_color_rgb = (color_rgb + ambient);
  let LIGHT_POS = vec3<f32>(0.288, -0.498, 0.996);
  let LIGHT_INTENSITY = 0.5;
  let LIGHT_COLOR = vec3<f32>(1.0);
  var directional: f32 = clamp(dot(face_normal, LIGHT_POS), 0.0, 1.0);
  directional = mix((1.0 - LIGHT_INTENSITY), max(((1.0 - colorvalue) + LIGHT_INTENSITY), 1.0), directional);
  let vgrad_on = (u.cam_ecef_off_l.w != 0.0);
  let is_wall = ((abs(face_normal.z) < 0.5) && vgrad_on);
  let t_top = is_top;
  if (is_wall) {
    let h_for_grad = max(wall_height, 1.0);
    let vgrad = clamp((t_top * sqrt((h_for_grad / 150.0))), mix(0.7, 0.98, (1.0 - LIGHT_INTENSITY)), 1.0);
    directional = (directional * vgrad);
  }
  let shaded_rgb = clamp(((lit_color_rgb * directional) * LIGHT_COLOR), vec3<f32>(0.0), vec3<f32>(1.0));
  out.v_color = vec4<f32>(shaded_rgb, opacity);
  return out;
}

@fragment
fn fs_fill(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > MERCATOR_LAT_LIMIT)) {
    discard;
  }
  let _clip_valid = (((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y));
  if (_clip_valid) {
    if ((input.abs_merc_x < u.clip_bounds.x)) {
      discard;
    }
    if ((input.abs_merc_x > u.clip_bounds.z)) {
      discard;
    }
    if ((input.abs_merc_y < u.clip_bounds.y)) {
      discard;
    }
    if ((input.abs_merc_y > u.clip_bounds.w)) {
      discard;
    }
  }
  var out: FragmentOutput;
  let v_shade = (0.6 + (0.4 * input.wall_blend));
  let roof_bonus = select(0.0, 0.05, (input.wall_blend >= 0.999));
  let wall_shade = min(1.0, (v_shade + roof_bonus));
  out.color = mix(Z3_0, mix(Z3_1, Z3_2, clamp((u.zoom - 12.0) / 4.0, 0.0, 1.0)), clamp((u.zoom - 8.0) / 4.0, 0.0, 1.0));
  if ((u.cam_ecef_off_h.w != 0.0)) {
    out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  }
  let base_depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  let id_lo = (input.feat_id & 65535u);
  let mixed = (((id_lo ^ (id_lo >> 7u)) ^ (id_lo << 3u)) & 1023u);
  let jitter = select(0.0, ((f32(mixed) - 512.0) * 1.5e-8), (input.feat_id != 0u));
  out.depth = (base_depth + jitter);
  return out;
}

@fragment
fn fs_fill_pattern(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > MERCATOR_LAT_LIMIT)) {
    discard;
  }
  let _clip_valid = (((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y));
  if (_clip_valid) {
    if ((input.abs_merc_x < u.clip_bounds.x)) {
      discard;
    }
    if ((input.abs_merc_x > u.clip_bounds.z)) {
      discard;
    }
    if ((input.abs_merc_y < u.clip_bounds.y)) {
      discard;
    }
    if ((input.abs_merc_y > u.clip_bounds.w)) {
      discard;
    }
  }
  var out: FragmentOutput;
  let repeat_x = max(u.fill_translate_x, 1.0);
  let repeat_y = max(u.fill_translate_y, 1.0);
  let uv_local = vec2<f32>(fract((input.abs_merc_x / repeat_x)), fract((input.abs_merc_y / repeat_y)));
  let u0 = u.fill_color.x;
  let v0 = u.fill_color.y;
  let u1 = u.fill_color.z;
  let v1 = u.fill_color.w;
  let atlas_uv = vec2<f32>((u0 + (uv_local.x * (u1 - u0))), (v0 + (uv_local.y * (v1 - v0))));
  let sampled = textureSample(sprite_atlas, sprite_samp, atlas_uv);
  out.color = vec4<f32>(sampled.rgb, (sampled.w * u.opacity));
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  let base_depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  let id_lo = (input.feat_id & 65535u);
  let mixed = (((id_lo ^ (id_lo >> 7u)) ^ (id_lo << 3u)) & 1023u);
  let jitter = select(0.0, ((f32(mixed) - 512.0) * 1.5e-8), (input.feat_id != 0u));
  out.depth = (base_depth + jitter);
  return out;
}

@fragment
fn fs_oit_translucent(input: VertexOutput) -> OitFragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > MERCATOR_LAT_LIMIT)) {
    discard;
  }
  let _clip_valid = (((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y));
  if (_clip_valid) {
    if ((input.abs_merc_x < u.clip_bounds.x)) {
      discard;
    }
    if ((input.abs_merc_x > u.clip_bounds.z)) {
      discard;
    }
    if ((input.abs_merc_y < u.clip_bounds.y)) {
      discard;
    }
    if ((input.abs_merc_y > u.clip_bounds.w)) {
      discard;
    }
  }
  let v_shade = (0.6 + (0.4 * input.wall_blend));
  let roof_bonus = select(0.0, 0.05, (input.wall_blend >= 0.999));
  let wall_shade = min(1.0, (v_shade + roof_bonus));
  let rgb = (u.fill_color.rgb * wall_shade);
  let a = (u.fill_color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  if ((a <= 0.001)) {
    discard;
  }
  let z = max(input.view_w, 0.001);
  let w = clamp((0.03 / (0.00001 + pow((z / 200.0), 4.0))), 0.01, 3000.0);
  var out: OitFragmentOutput;
  out.accum = (vec4<f32>((rgb * a), a) * w);
  out.revealage = a;
  return out;
}

@fragment
fn fs_fill_extrude(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > MERCATOR_LAT_LIMIT)) {
    discard;
  }
  let _clip_valid = (((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y));
  if (_clip_valid) {
    if ((input.abs_merc_x < u.clip_bounds.x)) {
      discard;
    }
    if ((input.abs_merc_x > u.clip_bounds.z)) {
      discard;
    }
    if ((input.abs_merc_y < u.clip_bounds.y)) {
      discard;
    }
    if ((input.abs_merc_y > u.clip_bounds.w)) {
      discard;
    }
  }
  var out: FragmentOutput;
  let rim = polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y);
  out.color = (input.v_color * rim);
  let base_depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  let id_lo = (input.feat_id & 65535u);
  let mixed = (((id_lo ^ (id_lo >> 7u)) ^ (id_lo << 3u)) & 1023u);
  let jitter = select(0.0, ((f32(mixed) - 512.0) * 1.5e-8), (input.feat_id != 0u));
  out.depth = (base_depth + jitter);
  return out;
}

@fragment
fn fs_stroke(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > MERCATOR_LAT_LIMIT)) {
    discard;
  }
  let _clip_valid = (((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y));
  if (_clip_valid) {
    if ((input.abs_merc_x < u.clip_bounds.x)) {
      discard;
    }
    if ((input.abs_merc_x > u.clip_bounds.z)) {
      discard;
    }
    if ((input.abs_merc_y < u.clip_bounds.y)) {
      discard;
    }
    if ((input.abs_merc_y > u.clip_bounds.w)) {
      discard;
    }
  }
  let alpha_scale = select(0.4, 1.0, (input.feat_id > 0u));
  var out: FragmentOutput;
  out.color = vec4<f32>(u.stroke_color.rgb, (u.stroke_color.w * alpha_scale));
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  out.depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  return out;
}

@fragment
fn fs_overdraw() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 0.0);
}

