// baseline: 3576e61298e1c83db40496a4ef053417c7057deb
// fixture: demotiles-stroke-match
// variant.key: demotiles-stroke-match
// pick: false
// note: MapLibre demotiles-shape — 5-arm stroke match (regional palette).
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;

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
  light_color_packed: u32,
  _pad_light_align: u32,
  cam_ecef_off_h: vec4<f32>,
  cam_ecef_off_l: vec4<f32>,
  light_dir_ecef: vec4<f32>,
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

@group(0) @binding(1) var<storage, read> feat_data: array<f32>;

fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32> {
  return vec4<f32>(pos.x, pos.y, ((log2(max(0.000001, (pos.w + 1.0))) * fc) * pos.w), pos.w);
}

fn compute_log_frag_depth(view_w: f32, fc: f32) -> f32 {
  return (log2(max(0.000001, (view_w + 1.0))) * fc);
}

fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  return vec2<f32>(((lon_deg * DEG2RAD) * EARTH_R), (log(tan(((PI / 4.0) + ((clamp(lat_deg, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT) * DEG2RAD) / 2.0)))) * EARTH_R));
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
  let _cse0 = (((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * ((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)));
  return vec2<f32>((((lon_rel * DEG2RAD) * (((0.8707 - (((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * 0.131979)) + (_cse0 * 0.013791)) - ((((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * _cse0) * 0.0081435))) * EARTH_R), (((lat_deg * DEG2RAD) * (1.007226 + (((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * (0.015085 + (((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * ((-0.044475 + (((lat_deg * DEG2RAD) * (lat_deg * DEG2RAD)) * 0.028874)) - (_cse0 * 0.005916))))))) * EARTH_R));
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
  let _cse0 = (PI * 2.0);
  return (value - (floor((((value - ref_v) + PI) / _cse0)) * _cse0));
}

fn proj_orthographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = cos((lat_deg * DEG2RAD));
  let _cse1 = ((lon_deg * DEG2RAD) - (clon * DEG2RAD));
  let _cse2 = (clat * DEG2RAD);
  return vec2<f32>(((EARTH_R * _cse0) * sin(_cse1)), (EARTH_R * ((cos(_cse2) * sin((lat_deg * DEG2RAD))) - ((sin(_cse2) * _cse0) * cos(_cse1)))));
}

fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = (EARTH_R * (acos(clamp(((sin((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) + ((cos((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD))))), -1.0, 1.0)) / sin(acos(clamp(((sin((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) + ((cos((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD))))), -1.0, 1.0)))));
  if ((acos(clamp(((sin((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) + ((cos((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD))))), -1.0, 1.0)) < 0.0001)) {
    return vec2<f32>(0.0, 0.0);
  }
  return vec2<f32>(((_cse0 * cos((lat_deg * DEG2RAD))) * sin(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))), (_cse0 * ((cos((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) - ((sin((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))))));
}

fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = (EARTH_R * (2.0 / (1.0 + ((sin((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) + ((cos((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD))))))));
  if ((((sin((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) + ((cos((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD))))) < -0.9)) {
    return vec2<f32>(1000000000000000.0, 1000000000000000.0);
  }
  return vec2<f32>(((_cse0 * cos((lat_deg * DEG2RAD))) * sin(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))), (_cse0 * ((cos((clat * DEG2RAD)) * sin((lat_deg * DEG2RAD))) - ((sin((clat * DEG2RAD)) * cos((lat_deg * DEG2RAD))) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))))));
}

fn oblique_rot(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = cos((lat_deg * DEG2RAD));
  let _cse1 = sin((lat_deg * DEG2RAD));
  let _cse2 = sin((clat * DEG2RAD));
  let _cse3 = cos((clat * DEG2RAD));
  let _cse4 = cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD)));
  return vec2<f32>(atan2((_cse0 * sin(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))), ((_cse1 * _cse2) + ((_cse0 * _cse3) * _cse4))), asin(clamp(((_cse1 * _cse3) - ((_cse0 * _cse2) * _cse4)), -1.0, 1.0)));
}

fn proj_oblique_mercator_d(lam_rot: f32, phi_rot: f32) -> vec2<f32> {
  let _cse0 = (89.9999 * DEG2RAD);
  return vec2<f32>((EARTH_R * lam_rot), (EARTH_R * log(tan(((PI / 4.0) + (clamp(phi_rot, (-_cse0), _cse0) / 2.0))))));
}

fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = oblique_rot(lon_deg, lat_deg, clon, clat);
  return proj_oblique_mercator_d(_cse0.x, _cse0.y);
}

fn proj_globe(lon_deg: f32, lat_deg: f32) -> vec3<f32> {
  let _cse0 = (EARTH_R * cos((lat_deg * DEG2RAD)));
  let _cse1 = (lon_deg * DEG2RAD);
  return vec3<f32>((_cse0 * cos(_cse1)), (_cse0 * sin(_cse1)), (EARTH_R * sin((lat_deg * DEG2RAD))));
}

fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let _cse0 = (clat * DEG2RAD);
  let _cse1 = (lat_deg * DEG2RAD);
  return ((sin(_cse0) * sin(_cse1)) + ((cos(_cse0) * cos(_cse1)) * cos(((lon_deg * DEG2RAD) - (clon * DEG2RAD)))));
}

fn project(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> vec2<f32> {
  if ((proj_params.x < 0.5)) {
    return proj_mercator(lon_deg, lat_deg);
  } else if ((proj_params.x < 1.5)) {
    return proj_equirectangular(lon_deg, lat_deg, proj_params.y);
  } else if ((proj_params.x < 2.5)) {
    return proj_natural_earth(lon_deg, lat_deg, proj_params.y);
  } else if ((proj_params.x < 3.5)) {
    return proj_orthographic(lon_deg, lat_deg, proj_params.y, proj_params.z);
  } else if ((proj_params.x < 4.5)) {
    return proj_azimuthal_equidistant(lon_deg, lat_deg, proj_params.y, proj_params.z);
  } else if ((proj_params.x < 5.5)) {
    return proj_stereographic(lon_deg, lat_deg, proj_params.y, proj_params.z);
  } else {
    return proj_oblique_mercator(lon_deg, lat_deg, proj_params.y, proj_params.z);
  }
}

fn project_geom(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32> {
  let _cse0 = wrap_lon_delta((unwrap_lon_near_keep(((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - (ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0))), 0.0, sign((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)))) + wrap_lon_delta(((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - proj_params.y))));
  let _cse1 = (((floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R);
  let _cse2 = oblique_rot((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)), lat_deg, proj_params.y, proj_params.z);
  if (((proj_params.x > 0.5) && (proj_params.x < 2.5))) {
    var p: vec2<f32>;
    if ((proj_params.x < 1.5)) {
      p = proj_equirectangular_d((unwrap_lon_near_keep(((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - (ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0))), 0.0, sign((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)))) + wrap_lon_delta(((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - proj_params.y))), lat_deg);
    } else {
      p = proj_natural_earth_d(_cse0, lat_deg);
      p.x = (p.x + (((floor(((((unwrap_lon_near_keep(((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - (ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0))), 0.0, sign((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)))) + wrap_lon_delta(((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - proj_params.y))) - _cse0) / 360.0) + 0.5)) * 2.0) * PI) * EARTH_R));
    }
    p.x = (p.x + _cse1);
    return p;
  }
  if ((proj_params.x > 5.5)) {
    var p: vec2<f32> = proj_oblique_mercator_d(unwrap_rad_near(_cse2.x, oblique_rot((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)), proj_params.z, proj_params.y, proj_params.z).x), _cse2.y);
    p.x = (p.x + _cse1);
    return p;
  }
  return project(lon_deg, lat_deg, proj_params);
}

fn flat_rel(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32> {
  return (project_geom(lon_deg, lat_deg, proj_params, ref_lon) - project(proj_params.y, proj_params.z, proj_params));
}

fn needs_backface_cull(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32 {
  let _cse0 = center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z);
  if ((proj_params.x > 2.5)) {
    if ((proj_params.x < 3.5)) {
      return _cse0;
    }
    if ((proj_params.x < 4.5)) {
      return select(-1.0, 1.0, (_cse0 > -0.85));
    }
    if ((proj_params.x < 5.5)) {
      return select(-1.0, 1.0, (_cse0 > -0.8));
    }
    if ((proj_params.x < 6.5)) {
      return 1.0;
    }
    return _cse0;
  }
  return 1.0;
}

fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32 {
  let _cse0 = smoothstep(0.0, 0.02, center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z));
  if ((proj_params.x > 2.5)) {
    if ((proj_params.x < 3.5)) {
      return _cse0;
    }
    if ((proj_params.x < 4.5)) {
      return smoothstep(-0.85, -0.83, center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z));
    }
    if ((proj_params.x < 5.5)) {
      return smoothstep(-0.8, -0.78, center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z));
    }
    if ((proj_params.x < 6.5)) {
      return 1.0;
    }
    return _cse0;
  }
  return 1.0;
}

fn inv_merc_lat_rad(merc_y_m: f32) -> f32 {
  return ((2.0 * atan(exp((merc_y_m / EARTH_R)))) - (PI / 2.0));
}

fn dequant_ecef(q_xy: vec4<u32>, q_z: vec2<u32>, scale: f32, half: f32) -> vec3<f32> {
  return vec3<f32>(((((f32(q_xy.x) * 65536.0) + f32(q_xy.y)) * scale) - half), ((((f32(q_xy.z) * 65536.0) + f32(q_xy.w)) * scale) - half), ((((f32(q_z.x) * 65536.0) + f32(q_z.y)) * scale) - half));
}

fn polygon_cos_c_fragment(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  return needs_backface_cull((abs_merc_x / (DEG2RAD * EARTH_R)), (inv_merc_lat_rad(abs_merc_y) / DEG2RAD), u.proj_params);
}

fn polygon_rim_alpha(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  return rim_alpha((abs_merc_x / (DEG2RAD * EARTH_R)), (inv_merc_lat_rad(abs_merc_y) / DEG2RAD), u.proj_params);
}

@vertex
fn vs_main(@location(0) pos_h: vec3<f32>, @location(1) pos_l: vec3<f32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32) -> VertexOutput {
  let _cse0 = (((project(abs_lon, abs_lat, u.proj_params) - u.tile_origin_merc) - u.cam_h) - u.cam_l);
  let _cse1 = flat_rel(abs_lon, abs_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse2 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    clip = (u.mvp * vec4<f32>((_cse0.x + (((floor(((((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)) + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R)), _cse0.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    clip = (u.mvp * vec4<f32>(_cse1.x, _cse1.y, 0.0, 1.0));
  } else {
    clip = (u.mvp * vec4<f32>((((pos_h + pos_l) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = _cse2;
  out.wall_blend = 1.0;
  out.abs_merc_x = ((abs_lon * DEG2RAD) * EARTH_R);
  out.abs_merc_y = (log(tan(((PI / 4.0) + ((_cse2 * DEG2RAD) / 2.0)))) * EARTH_R);
  out.world_z = 0.0;
  out.v_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return out;
}

@vertex
fn vs_main_ecef(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) true_lat: f32) -> VertexOutput {
  let _cse0 = ((vec2<f32>(abs_lon, abs_lat) - u.cam_h) - u.cam_l);
  let _cse1 = flat_rel(((abs_lon + u.tile_origin_merc.x) / (DEG2RAD * EARTH_R)), true_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse2 = (abs_lat + u.tile_origin_merc.y);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    clip = (u.mvp * vec4<f32>(_cse0.x, _cse0.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    clip = (u.mvp * vec4<f32>(_cse1.x, _cse1.y, 0.0, 1.0));
  } else {
    clip = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = clamp((inv_merc_lat_rad(_cse2) / DEG2RAD), (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  out.wall_blend = 1.0;
  out.abs_merc_x = (abs_lon + u.tile_origin_merc.x);
  out.abs_merc_y = _cse2;
  out.world_z = 0.0;
  out.v_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return out;
}

@vertex
fn vs_main_ecef_extruded(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) face_normal: vec3<f32>, @location(6) wall_height: f32, @location(7) is_top: f32) -> VertexOutput {
  let _cse0 = (((project(abs_lon, abs_lat, u.proj_params) - u.tile_origin_merc) - u.cam_h) - u.cam_l);
  let _cse1 = (wall_height * is_top);
  let _cse2 = flat_rel(abs_lon, abs_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse3 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let _cse4 = (1.0 - u.light_dir_ecef.w);
  var out: VertexOutput;
  var clip: vec4<f32>;
  if ((u.proj_params.x < 0.5)) {
    clip = (u.mvp * vec4<f32>((_cse0.x + (((floor(((((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)) + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R)), _cse0.y, _cse1, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    clip = (u.mvp * vec4<f32>(_cse2.x, _cse2.y, _cse1, 1.0));
  } else {
    clip = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  clip.x = (clip.x + (u.fill_translate_x * clip.w));
  clip.y = (clip.y - (u.fill_translate_y * clip.w));
  out.position = apply_log_depth(clip, u.log_depth_fc);
  out.position.z = (out.position.z - (u.layer_depth_offset * out.position.w));
  out.view_w = clip.w;
  out.cos_c = 0.0;
  out.feat_id = u32(feature_id);
  out.abs_lat = _cse3;
  out.wall_blend = is_top;
  out.abs_merc_x = ((abs_lon * DEG2RAD) * EARTH_R);
  out.abs_merc_y = (log(tan(((PI / 4.0) + ((_cse3 * DEG2RAD) / 2.0)))) * EARTH_R);
  out.world_z = _cse1;
  var directional: f32 = clamp(dot(face_normal, u.light_dir_ecef.xyz), 0.0, 1.0);
  directional = mix(_cse4, max(((1.0 - (((u.fill_color.rgb.x * 0.2126) + (u.fill_color.rgb.y * 0.7152)) + (u.fill_color.rgb.z * 0.0722))) + u.light_dir_ecef.w), 1.0), directional);
  if (((abs(face_normal.z) < 0.5) && (u.cam_ecef_off_l.w != 0.0))) {
    directional = (directional * clamp((is_top * sqrt((max(wall_height, 1.0) / 150.0))), mix(0.7, 0.98, _cse4), 1.0));
  }
  let shaded_rgb = clamp((((u.fill_color.rgb + vec3<f32>(0.03)) * directional) * unpack4x8unorm(u.light_color_packed).xyz), vec3<f32>(0.0), vec3<f32>(1.0));
  out.v_color = vec4<f32>(shaded_rgb, u.fill_color.w);
  return out;
}

@fragment
fn fs_fill(input: VertexOutput) -> FragmentOutput {
  let _cse0 = (input.feat_id & 65535u);
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y))) {
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
  let wall_shade = min(1.0, ((0.6 + (0.4 * input.wall_blend)) + select(0.0, 0.05, (input.wall_blend >= 0.999))));
  out.color = vec4<f32>((u.fill_color.rgb * wall_shade), u.fill_color.w);
  if ((u.cam_ecef_off_h.w != 0.0)) {
    out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  }
  out.depth = (compute_log_frag_depth(input.view_w, u.log_depth_fc) + select(0.0, ((f32((((_cse0 ^ (_cse0 >> 7u)) ^ (_cse0 << 3u)) & 1023u)) - 512.0) * 1.5e-8), (input.feat_id != 0u)));
  return out;
}

@fragment
fn fs_fill_pattern(input: VertexOutput) -> FragmentOutput {
  let _cse0 = textureSample(sprite_atlas, sprite_samp, vec2<f32>((u.fill_color.x + (vec2<f32>(fract((input.abs_merc_x / max(u.fill_translate_x, 1.0))), fract((input.abs_merc_y / max(u.fill_translate_y, 1.0)))).x * (u.fill_color.z - u.fill_color.x))), (u.fill_color.y + (vec2<f32>(fract((input.abs_merc_x / max(u.fill_translate_x, 1.0))), fract((input.abs_merc_y / max(u.fill_translate_y, 1.0)))).y * (u.fill_color.w - u.fill_color.y)))));
  let _cse1 = (input.feat_id & 65535u);
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y))) {
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
  out.color = vec4<f32>(_cse0.rgb, (_cse0.w * u.opacity));
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  out.depth = (compute_log_frag_depth(input.view_w, u.log_depth_fc) + select(0.0, ((f32((((_cse1 ^ (_cse1 >> 7u)) ^ (_cse1 << 3u)) & 1023u)) - 512.0) * 1.5e-8), (input.feat_id != 0u)));
  return out;
}

@fragment
fn fs_oit_translucent(input: VertexOutput) -> OitFragmentOutput {
  let _cse0 = (u.fill_color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y))) {
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
  if ((_cse0 <= 0.001)) {
    discard;
  }
  return OitFragmentOutput((vec4<f32>(((u.fill_color.rgb * min(1.0, ((0.6 + (0.4 * input.wall_blend)) + select(0.0, 0.05, (input.wall_blend >= 0.999))))) * _cse0), _cse0) * clamp((0.03 / (0.00001 + pow((max(input.view_w, 0.001) / 200.0), 4.0))), 0.01, 3000.0)), _cse0);
}

@fragment
fn fs_fill_extrude(input: VertexOutput) -> FragmentOutput {
  let _cse0 = (input.feat_id & 65535u);
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y))) {
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
  out.color = (input.v_color * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  out.depth = (compute_log_frag_depth(input.view_w, u.log_depth_fc) + select(0.0, ((f32((((_cse0 ^ (_cse0 >> 7u)) ^ (_cse0 << 3u)) & 1023u)) - 512.0) * 1.5e-8), (input.feat_id != 0u)));
  return out;
}

@fragment
fn fs_stroke(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((((u.clip_bounds.x > -1e+29) && (u.clip_bounds.z > u.clip_bounds.x)) && (u.clip_bounds.w > u.clip_bounds.y))) {
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
  var _mcSD: vec4f = vec4f(0.78, 0.78, 0.78, 1.0);
  if (field0_id == 0u) { _mcSD = vec4f(0.78, 0.91, 0.74, 1.00); }
  else if (field0_id == 1u) { _mcSD = vec4f(0.92, 0.86, 0.65, 1.00); }
  else if (field0_id == 2u) { _mcSD = vec4f(0.84, 0.80, 0.70, 1.00); }
  else if (field0_id == 3u) { _mcSD = vec4f(0.69, 0.85, 0.69, 1.00); }
  else if (field0_id == 4u) { _mcSD = vec4f(0.95, 0.78, 0.78, 1.00); }
  out.color = _mcSD;
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  out.depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  return out;
}

@fragment
fn fs_overdraw() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 0.0);
}

