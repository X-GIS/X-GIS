// baseline: b8f978b1af3eae70c409855ede44565ea26e5416
// fixture: syn-match10
// variant.key: syn-match10
// pick: false
// note: Synthetic — 10-arm match chain at the matchExpr ≥10-arm perf-gate boundary.
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
    var _v0: vec2<f32>;
    if ((proj_params.x < 1.5)) {
      _v0 = proj_equirectangular_d((unwrap_lon_near_keep(((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - (ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0))), 0.0, sign((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)))) + wrap_lon_delta(((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - proj_params.y))), lat_deg);
    } else {
      _v0 = proj_natural_earth_d(_cse0, lat_deg);
      _v0.x = (_v0.x + (((floor(((((unwrap_lon_near_keep(((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - (ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0))), 0.0, sign((lon_deg - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)))) + wrap_lon_delta(((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)) - proj_params.y))) - _cse0) / 360.0) + 0.5)) * 2.0) * PI) * EARTH_R));
    }
    _v0.x = (_v0.x + _cse1);
    return _v0;
  }
  if ((proj_params.x > 5.5)) {
    var _v1: vec2<f32> = proj_oblique_mercator_d(unwrap_rad_near(_cse2.x, oblique_rot((ref_lon - (floor((((ref_lon - proj_params.y) + 180.0) / 360.0)) * 360.0)), proj_params.z, proj_params.y, proj_params.z).x), _cse2.y);
    _v1.x = (_v1.x + _cse1);
    return _v1;
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
  let _cse0 = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  let _cse1 = (((project(abs_lon, abs_lat, u.proj_params) - u.tile_origin_merc) - u.cam_h) - u.cam_l);
  let _cse2 = flat_rel(abs_lon, abs_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse3 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  var _av0: vec4<f32> = _cse0;
  if ((u.proj_params.x < 0.5)) {
    _av0 = (u.mvp * vec4<f32>((_cse1.x + (((floor(((((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)) + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R)), _cse1.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    _av0 = (u.mvp * vec4<f32>(_cse2.x, _cse2.y, 0.0, 1.0));
  } else {
    _av0 = (u.mvp * vec4<f32>((((pos_h + pos_l) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
  _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  return VertexOutput(vec4<f32>(apply_log_depth(_av0, u.log_depth_fc).x, apply_log_depth(_av0, u.log_depth_fc).y, (apply_log_depth(_av0, u.log_depth_fc).z - (u.layer_depth_offset * apply_log_depth(_av0, u.log_depth_fc).w)), apply_log_depth(_av0, u.log_depth_fc).w), 0.0, u32(feature_id), _cse3, _av0.w, 1.0, ((abs_lon * DEG2RAD) * EARTH_R), (log(tan(((PI / 4.0) + ((_cse3 * DEG2RAD) / 2.0)))) * EARTH_R), 0.0, _cse0);
}

@vertex
fn vs_main_ecef(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) true_lat: f32) -> VertexOutput {
  let _cse0 = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  let _cse1 = ((vec2<f32>(abs_lon, abs_lat) - u.cam_h) - u.cam_l);
  let _cse2 = flat_rel(((abs_lon + u.tile_origin_merc.x) / (DEG2RAD * EARTH_R)), true_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse3 = (abs_lat + u.tile_origin_merc.y);
  var _av0: vec4<f32> = _cse0;
  if ((u.proj_params.x < 0.5)) {
    _av0 = (u.mvp * vec4<f32>(_cse1.x, _cse1.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    _av0 = (u.mvp * vec4<f32>(_cse2.x, _cse2.y, 0.0, 1.0));
  } else {
    _av0 = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
  _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  return VertexOutput(vec4<f32>(apply_log_depth(_av0, u.log_depth_fc).x, apply_log_depth(_av0, u.log_depth_fc).y, (apply_log_depth(_av0, u.log_depth_fc).z - (u.layer_depth_offset * apply_log_depth(_av0, u.log_depth_fc).w)), apply_log_depth(_av0, u.log_depth_fc).w), 0.0, u32(feature_id), clamp((inv_merc_lat_rad(_cse3) / DEG2RAD), (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT), _av0.w, 1.0, (abs_lon + u.tile_origin_merc.x), _cse3, 0.0, _cse0);
}

@vertex
fn vs_main_ecef_extruded(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) face_normal: vec3<f32>, @location(6) wall_height: f32, @location(7) is_top: f32) -> VertexOutput {
  let _cse0 = (((project(abs_lon, abs_lat, u.proj_params) - u.tile_origin_merc) - u.cam_h) - u.cam_l);
  let _cse1 = (wall_height * is_top);
  let _cse2 = flat_rel(abs_lon, abs_lat, u.proj_params, ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)));
  let _cse3 = (1.0 - u.light_dir_ecef.w);
  let _cse4 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  var _av0: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if ((u.proj_params.x < 0.5)) {
    _av0 = (u.mvp * vec4<f32>((_cse0.x + (((floor(((((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R)) + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R)), _cse0.y, _cse1, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    _av0 = (u.mvp * vec4<f32>(_cse2.x, _cse2.y, _cse1, 1.0));
  } else {
    _av0 = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z)) + vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z)), 1.0));
  }
  _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
  _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  var _av1: f32 = clamp(dot(face_normal, u.light_dir_ecef.xyz), 0.0, 1.0);
  _av1 = mix(_cse3, max(((1.0 - (((u.fill_color.rgb.x * 0.2126) + (u.fill_color.rgb.y * 0.7152)) + (u.fill_color.rgb.z * 0.0722))) + u.light_dir_ecef.w), 1.0), _av1);
  if (((abs(face_normal.z) < 0.5) && (u.cam_ecef_off_l.w != 0.0))) {
    _av1 = (_av1 * clamp((is_top * sqrt((max(wall_height, 1.0) / 150.0))), mix(0.7, 0.98, _cse3), 1.0));
  }
  let _v0 = clamp((((u.fill_color.rgb + vec3<f32>(0.03)) * _av1) * unpack4x8unorm(u.light_color_packed).xyz), vec3<f32>(0.0), vec3<f32>(1.0));
  return VertexOutput(vec4<f32>(apply_log_depth(_av0, u.log_depth_fc).x, apply_log_depth(_av0, u.log_depth_fc).y, (apply_log_depth(_av0, u.log_depth_fc).z - (u.layer_depth_offset * apply_log_depth(_av0, u.log_depth_fc).w)), apply_log_depth(_av0, u.log_depth_fc).w), 0.0, u32(feature_id), _cse4, _av0.w, is_top, ((abs_lon * DEG2RAD) * EARTH_R), (log(tan(((PI / 4.0) + ((_cse4 * DEG2RAD) / 2.0)))) * EARTH_R), _cse1, vec4<f32>(_v0, u.fill_color.w));
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
  var _mcS10: vec4f = vec4f(0.78, 0.78, 0.78, 1.0);
  if (field0_id == 0u) { _mcS10 = vec4f(0.78, 0.91, 0.74, 1.00); }
  else if (field0_id == 1u) { _mcS10 = vec4f(0.92, 0.86, 0.65, 1.00); }
  else if (field0_id == 2u) { _mcS10 = vec4f(0.84, 0.80, 0.70, 1.00); }
  else if (field0_id == 3u) { _mcS10 = vec4f(0.69, 0.85, 0.69, 1.00); }
  else if (field0_id == 4u) { _mcS10 = vec4f(0.95, 0.78, 0.78, 1.00); }
  else if (field0_id == 5u) { _mcS10 = vec4f(0.71, 0.78, 0.83, 1.00); }
  else if (field0_id == 6u) { _mcS10 = vec4f(0.87, 0.74, 0.62, 1.00); }
  else if (field0_id == 7u) { _mcS10 = vec4f(0.62, 0.74, 0.87, 1.00); }
  else if (field0_id == 8u) { _mcS10 = vec4f(0.81, 0.67, 0.55, 1.00); }
  else if (field0_id == 9u) { _mcS10 = vec4f(0.55, 0.81, 0.67, 1.00); }
  out.color = _mcS10;
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
  out.color = vec4<f32>(u.stroke_color.rgb, (u.stroke_color.w * alpha_scale));
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  out.depth = compute_log_frag_depth(input.view_w, u.log_depth_fc);
  return out;
}

@fragment
fn fs_overdraw() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 0.0);
}

