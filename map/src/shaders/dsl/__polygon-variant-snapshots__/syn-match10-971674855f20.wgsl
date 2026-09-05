// baseline: aca4c11997b0d5d3cf0a67d14b3a65d6b1c5caee
// fixture: syn-match10
// variant.key: syn-match10
// pick: false
// note: Synthetic — 10-arm match chain at the matchExpr ≥10-arm perf-gate boundary.
const PI: f32 = 3.14159265;
const EARTH_R: f32 = 6378137.0;
const EARTH_E2: f32 = 0.0066943799901413165;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;
const DEG2RAD: f32 = 0.01745329;

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
  pattern_active: u32,
  cam_ecef_off_h: vec4<f32>,
  cam_ecef_off_l: vec4<f32>,
  light_dir_ecef: vec4<f32>,
  globe_eye: vec4<f32>,
  input_f32_0: f32,
  input_f32_1: f32,
  input_f32_2: f32,
  input_f32_3: f32,
  input_f32_4: f32,
  input_f32_5: f32,
  input_f32_6: f32,
  input_f32_7: f32,
  input_color_0: vec4<f32>,
  input_color_1: vec4<f32>,
  input_color_2: vec4<f32>,
  input_color_3: vec4<f32>,
  tile_ecef_center_h: vec4<f32>,
  tile_ecef_center_l: vec4<f32>,
  cam_ecef_center_h: vec4<f32>,
  cam_ecef_center_l: vec4<f32>,
  tile_origin_merc_hl: vec4<f32>,
  cam_merc_center_hl: vec4<f32>,
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
  @location(9) shade_geom: vec2<f32>,
  @location(10) seam_x: f32,
  @location(11) @interpolate(flat) seam_x_flat: f32,
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

fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  return vec2<f32>((radians(lon_deg) * EARTH_R), (log(tan(((PI * 0.25) + (radians(clamp(lat_deg, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT)) * 0.5)))) * EARTH_R));
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
  return vec2<f32>((radians(lon_rel) * EARTH_R), (radians(lat_deg) * EARTH_R));
}

fn proj_natural_earth_d(lon_rel: f32, lat_deg: f32) -> vec2<f32> {
  let _cse2 = radians(lat_deg);
  let _cse1 = (_cse2 * _cse2);
  let _cse0 = (_cse1 * _cse1);
  return vec2<f32>(((radians(lon_rel) * (((0.8707 - (_cse1 * 0.131979)) + (_cse0 * 0.013791)) - ((_cse1 * _cse0) * 0.0081435))) * EARTH_R), ((_cse2 * (1.007226 + (_cse1 * (0.015085 + (_cse1 * ((-0.044475 + (_cse1 * 0.028874)) - (_cse0 * 0.005916))))))) * EARTH_R));
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
  let _cse3 = radians(lat_deg);
  let _cse0 = cos(_cse3);
  let _cse1 = (radians(lon_deg) - radians(clon));
  let _cse2 = radians(clat);
  return vec2<f32>(((EARTH_R * _cse0) * sin(_cse1)), (EARTH_R * ((cos(_cse2) * sin(_cse3)) - ((sin(_cse2) * _cse0) * cos(_cse1)))));
}

fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse9 = radians(lat_deg);
  let _cse4 = cos(_cse9);
  let _cse10 = (radians(lon_deg) - radians(clon));
  let _cse2 = (_cse4 * sin(_cse10));
  let _cse11 = radians(clat);
  let _cse5 = cos(_cse11);
  let _cse6 = sin(_cse9);
  let _cse7 = sin(_cse11);
  let _cse8 = cos(_cse10);
  let _cse3 = ((_cse5 * _cse6) - ((_cse7 * _cse4) * _cse8));
  let _cse1 = sqrt(((_cse2 * _cse2) + (_cse3 * _cse3)));
  let _cse0 = (EARTH_R * (atan2(_cse1, ((_cse7 * _cse6) + ((_cse5 * _cse4) * _cse8))) / max(_cse1, 1e-12)));
  return vec2<f32>((_cse0 * _cse2), (_cse0 * _cse3));
}

fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse7 = radians(clat);
  let _cse2 = sin(_cse7);
  let _cse8 = radians(lat_deg);
  let _cse3 = sin(_cse8);
  let _cse4 = cos(_cse7);
  let _cse5 = cos(_cse8);
  let _cse9 = (radians(lon_deg) - radians(clon));
  let _cse6 = cos(_cse9);
  let _cse1 = ((_cse2 * _cse3) + ((_cse4 * _cse5) * _cse6));
  if ((_cse1 < -0.9)) {
    return vec2<f32>(1000000000000000.0, 1000000000000000.0);
  }
  let _cse0 = (EARTH_R * (2.0 / (1.0 + _cse1)));
  return vec2<f32>(((_cse0 * _cse5) * sin(_cse9)), (_cse0 * ((_cse4 * _cse3) - ((_cse2 * _cse5) * _cse6))));
}

fn oblique_rot(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse5 = radians(lat_deg);
  let _cse0 = cos(_cse5);
  let _cse1 = sin(_cse5);
  let _cse6 = radians(clat);
  let _cse2 = sin(_cse6);
  let _cse3 = cos(_cse6);
  let _cse7 = (radians(lon_deg) - radians(clon));
  let _cse4 = cos(_cse7);
  return vec2<f32>(atan2((_cse0 * sin(_cse7)), ((_cse1 * _cse2) + ((_cse0 * _cse3) * _cse4))), asin(clamp(((_cse1 * _cse3) - ((_cse0 * _cse2) * _cse4)), -1.0, 1.0)));
}

fn proj_oblique_mercator_d(lam_rot: f32, phi_rot: f32) -> vec2<f32> {
  let _cse0 = radians(89.9999);
  return vec2<f32>((EARTH_R * lam_rot), (EARTH_R * log(tan(((PI * 0.25) + (clamp(phi_rot, (-_cse0), _cse0) * 0.5))))));
}

fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let _cse0 = oblique_rot(lon_deg, lat_deg, clon, clat);
  return proj_oblique_mercator_d(_cse0.x, _cse0.y);
}

fn proj_globe(lon_deg: f32, lat_deg: f32) -> vec3<f32> {
  let _cse4 = radians(lat_deg);
  let _cse3 = sin(_cse4);
  let _cse2 = (EARTH_R / sqrt((1.0 - ((EARTH_E2 * _cse3) * _cse3))));
  let _cse0 = (_cse2 * cos(_cse4));
  let _cse1 = radians(lon_deg);
  return vec3<f32>((_cse0 * cos(_cse1)), (_cse0 * sin(_cse1)), ((_cse2 * (1.0 - EARTH_E2)) * _cse3));
}

fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let _cse0 = radians(clat);
  let _cse1 = radians(lat_deg);
  return ((sin(_cse0) * sin(_cse1)) + ((cos(_cse0) * cos(_cse1)) * cos((radians(lon_deg) - radians(clon)))));
}

fn globe_eye_horizon_cos(lon_deg: f32, lat_deg: f32, globe_eye: vec4<f32>) -> f32 {
  let _cse0 = proj_globe(lon_deg, lat_deg);
  return (dot(normalize(vec3<f32>((_cse0.x / EARTH_R), (_cse0.y / EARTH_R), ((_cse0.z * inverseSqrt((1.0 - EARTH_E2))) / EARTH_R))), globe_eye.xyz) - globe_eye.w);
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
  let _cse7 = floor((((ref_lon - proj_params.y) + 180.0) / 360.0));
  let _cse0 = (((_cse7 * 2.0) * PI) * EARTH_R);
  if (((proj_params.x > 0.5) && (proj_params.x < 2.5))) {
    var _v0: vec2<f32>;
    let _cse6 = (_cse7 * 360.0);
    let _cse4 = (lon_deg - _cse6);
    let _cse5 = (ref_lon - _cse6);
    let _cse3 = (unwrap_lon_near_keep((_cse4 - _cse5), 0.0, sign(_cse4)) + wrap_lon_delta((_cse5 - proj_params.y)));
    if ((proj_params.x < 1.5)) {
      _v0 = proj_equirectangular_d(_cse3, lat_deg);
      _v0.x = (_v0.x + _cse0);
    } else {
      let _cse1 = wrap_lon_delta(_cse3);
      _v0 = proj_natural_earth_d(_cse1, lat_deg);
      _v0.x = (_v0.x + (((floor((((_cse3 - _cse1) / 360.0) + 0.5)) + _cse7) * proj_natural_earth_d(180.0, lat_deg).x) * 2.0));
    }
    return _v0;
  }
  if ((proj_params.x > 5.5)) {
    let _cse2 = oblique_rot(lon_deg, lat_deg, proj_params.y, proj_params.z);
    var _v1: vec2<f32> = proj_oblique_mercator_d(unwrap_rad_near(_cse2.x, 0.0), _cse2.y);
    _v1.x = (_v1.x + _cse0);
    return _v1;
  }
  return project(lon_deg, lat_deg, proj_params);
}

fn flat_rel(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32> {
  return (project_geom(lon_deg, lat_deg, proj_params, ref_lon) - project(proj_params.y, proj_params.z, proj_params));
}

fn needs_backface_cull(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, globe_eye: vec4<f32>) -> f32 {
  if ((proj_params.x > 2.5)) {
    let _cse0 = center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z);
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
    if ((globe_eye.w > 0.0)) {
      return globe_eye_horizon_cos(lon_deg, lat_deg, globe_eye);
    }
    return _cse0;
  }
  return 1.0;
}

fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, globe_eye: vec4<f32>) -> f32 {
  if ((proj_params.x > 2.5)) {
    let _cse1 = center_cos_c(lon_deg, lat_deg, proj_params.y, proj_params.z);
    let _cse0 = smoothstep(0.0, 0.02, _cse1);
    if ((proj_params.x < 3.5)) {
      return _cse0;
    }
    if ((proj_params.x < 4.5)) {
      return smoothstep(-0.85, -0.83, _cse1);
    }
    if ((proj_params.x < 5.5)) {
      return smoothstep(-0.8, -0.78, _cse1);
    }
    if ((proj_params.x < 6.5)) {
      return 1.0;
    }
    if ((globe_eye.w > 0.0)) {
      return smoothstep(0.0, (0.02 * (1.0 - globe_eye.w)), globe_eye_horizon_cos(lon_deg, lat_deg, globe_eye));
    }
    return _cse0;
  }
  return 1.0;
}

fn inv_merc_lat_rad(merc_y_m: f32) -> f32 {
  return ((2.0 * atan(exp((merc_y_m / EARTH_R)))) - (PI * 0.5));
}

fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32> {
  return vec4<f32>(pos.x, pos.y, ((log2(max(0.000001, (pos.w + 1.0))) * fc) * pos.w), pos.w);
}

fn dequant_ecef(q_xy: vec4<u32>, q_z: vec2<u32>, scale: f32, half: f32) -> vec3<f32> {
  return vec3<f32>(((((f32(q_xy.x) * 65536.0) + f32(q_xy.y)) * scale) - half), ((((f32(q_xy.z) * 65536.0) + f32(q_xy.w)) * scale) - half), ((((f32(q_z.x) * 65536.0) + f32(q_z.y)) * scale) - half));
}

fn polygon_cos_c_fragment(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  return needs_backface_cull((abs_merc_x / (DEG2RAD * EARTH_R)), degrees(inv_merc_lat_rad(abs_merc_y)), u.proj_params, u.globe_eye);
}

fn polygon_rim_alpha(abs_merc_x: f32, abs_merc_y: f32) -> f32 {
  return rim_alpha((abs_merc_x / (DEG2RAD * EARTH_R)), degrees(inv_merc_lat_rad(abs_merc_y)), u.proj_params, u.globe_eye);
}

fn compute_log_frag_depth(view_w: f32, fc: f32) -> f32 {
  return (log2(max(0.000001, (view_w + 1.0))) * fc);
}

@vertex
fn vs_main(@location(0) pos_h: vec3<f32>, @location(1) pos_l: vec3<f32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32) -> VertexOutput {
  var _v0: f32 = 0.0;
  let _cse0 = (u.cam_ecef_center_h.w > 0.5);
  let cam_rel_h = select(u.cam_h, vec2<f32>((u.cam_merc_center_hl.x - u.tile_origin_merc_hl.x), (u.cam_merc_center_hl.y - u.tile_origin_merc_hl.y)), _cse0);
  let cam_rel_l = select(u.cam_l, vec2<f32>((u.cam_merc_center_hl.z - u.tile_origin_merc_hl.z), (u.cam_merc_center_hl.w - u.tile_origin_merc_hl.w)), _cse0);
  let _cse1 = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var _av0: vec4<f32> = _cse1;
  let _cse6 = ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / (DEG2RAD * EARTH_R));
  if ((u.proj_params.x < 0.5)) {
    let _cse2 = (project(abs_lon, abs_lat, u.proj_params) - u.tile_origin_merc);
    let _lc0 = ((_cse2 - cam_rel_h) - cam_rel_l);
    _av0 = (u.mvp * vec4<f32>((_lc0.x + (((floor(((_cse6 + 180.0) / 360.0)) * 2.0) * PI) * EARTH_R)), _lc0.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    let _cse5 = flat_rel(abs_lon, abs_lat, u.proj_params, _cse6);
    let _cse3 = _cse5.x;
    _av0 = (u.mvp * vec4<f32>(_cse3, _cse5.y, 0.0, 1.0));
    _v0 = _cse3;
  } else {
    let rtc_off_h = select(vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z), (vec3<f32>(u.tile_ecef_center_h.x, u.tile_ecef_center_h.y, u.tile_ecef_center_h.z) - vec3<f32>(u.cam_ecef_center_h.x, u.cam_ecef_center_h.y, u.cam_ecef_center_h.z)), _cse0);
    let rtc_off_l = select(vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z), (vec3<f32>(u.tile_ecef_center_l.x, u.tile_ecef_center_l.y, u.tile_ecef_center_l.z) - vec3<f32>(u.cam_ecef_center_l.x, u.cam_ecef_center_l.y, u.cam_ecef_center_l.z)), _cse0);
    _av0 = (u.mvp * vec4<f32>((((pos_h + pos_l) + rtc_off_h) + rtc_off_l), 1.0));
  }
  if ((u.pattern_active == 0u)) {
    _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
    _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  }
  let _v1 = apply_log_depth(_av0, u.log_depth_fc);
  let _cse4 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  return VertexOutput(vec4<f32>(_v1.x, _v1.y, (_v1.z - (u.layer_depth_offset * _v1.w)), _v1.w), 0.0, u32(feature_id), _cse4, _av0.w, 1.0, (radians(abs_lon) * EARTH_R), (log(tan(((PI * 0.25) + (radians(_cse4) * 0.5)))) * EARTH_R), 0.0, _cse1, vec2<f32>(0.0, 0.0), _v0, _v0);
}

@vertex
fn vs_main_ecef(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) true_lat: f32) -> VertexOutput {
  var _v0: f32 = 0.0;
  let _cse0 = (u.cam_ecef_center_h.w > 0.5);
  let cam_rel_h = select(u.cam_h, vec2<f32>((u.cam_merc_center_hl.x - u.tile_origin_merc_hl.x), (u.cam_merc_center_hl.y - u.tile_origin_merc_hl.y)), _cse0);
  let cam_rel_l = select(u.cam_l, vec2<f32>((u.cam_merc_center_hl.z - u.tile_origin_merc_hl.z), (u.cam_merc_center_hl.w - u.tile_origin_merc_hl.w)), _cse0);
  let _cse1 = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var _av0: vec4<f32> = _cse1;
  let _cse6 = vec2<f32>(abs_lon, abs_lat);
  if ((u.proj_params.x < 0.5)) {
    let _lc0 = ((_cse6 - cam_rel_h) - cam_rel_l);
    _av0 = (u.mvp * vec4<f32>(_lc0.x, _lc0.y, 0.0, 1.0));
  } else if ((u.proj_params.x < 6.5)) {
    let _cse2 = _cse6.x;
    let _cse3 = vec4<f32>(u.proj_params.x, 0.0, u.proj_params.z, u.proj_params.w);
    let _cse7 = (DEG2RAD * EARTH_R);
    let _cse4 = (((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / _cse7) - u.proj_params.y);
    let _gv0 = flat_rel((((_cse2 - cam_rel_h.x) - cam_rel_l.x) / _cse7), true_lat, _cse3, _cse4);
    _av0 = (u.mvp * vec4<f32>(_gv0.x, _gv0.y, 0.0, 1.0));
    _v0 = _gv0.x;
  } else {
    let rtc_off_h = select(vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z), (vec3<f32>(u.tile_ecef_center_h.x, u.tile_ecef_center_h.y, u.tile_ecef_center_h.z) - vec3<f32>(u.cam_ecef_center_h.x, u.cam_ecef_center_h.y, u.cam_ecef_center_h.z)), _cse0);
    let rtc_off_l = select(vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z), (vec3<f32>(u.tile_ecef_center_l.x, u.tile_ecef_center_l.y, u.tile_ecef_center_l.z) - vec3<f32>(u.cam_ecef_center_l.x, u.cam_ecef_center_l.y, u.cam_ecef_center_l.z)), _cse0);
    _av0 = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + rtc_off_h) + rtc_off_l), 1.0));
  }
  if ((u.pattern_active == 0u)) {
    _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
    _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  }
  let _v1 = apply_log_depth(_av0, u.log_depth_fc);
  let _cse5 = (abs_lat + u.tile_origin_merc.y);
  return VertexOutput(vec4<f32>(_v1.x, _v1.y, (_v1.z - (u.layer_depth_offset * _v1.w)), _v1.w), 0.0, u32(feature_id), clamp(degrees(inv_merc_lat_rad(_cse5)), (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT), _av0.w, 1.0, (abs_lon + u.tile_origin_merc.x), _cse5, 0.0, _cse1, vec2<f32>(0.0, 0.0), _v0, _v0);
}

@vertex
fn vs_main_ecef_extruded(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>, @location(2) feature_id: f32, @location(3) abs_lon: f32, @location(4) abs_lat: f32, @location(5) face_normal: vec3<f32>, @location(6) wall_height: f32, @location(7) is_top: f32, @location(8) wall_base: f32, @location(9) local_merc: vec2<f32>) -> VertexOutput {
  var _v0: f32 = 0.0;
  let _cse0 = (u.cam_ecef_center_h.w > 0.5);
  let cam_rel_h = select(u.cam_h, vec2<f32>((u.cam_merc_center_hl.x - u.tile_origin_merc_hl.x), (u.cam_merc_center_hl.y - u.tile_origin_merc_hl.y)), _cse0);
  let cam_rel_l = select(u.cam_l, vec2<f32>((u.cam_merc_center_hl.z - u.tile_origin_merc_hl.z), (u.cam_merc_center_hl.w - u.tile_origin_merc_hl.w)), _cse0);
  var _av0: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  let _cse1 = (wall_base + (max((wall_height - wall_base), 0.0) * is_top));
  let _cse9 = clamp(abs_lat, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let _cse2 = radians(_cse9);
  let _cse3 = (u.proj_params.x < 6.5);
  if ((u.proj_params.x < 0.5)) {
    let _lc0 = ((local_merc - cam_rel_h) - cam_rel_l);
    _av0 = (u.mvp * vec4<f32>(_lc0.x, _lc0.y, (_cse1 / cos(_cse2)), 1.0));
  } else if (_cse3) {
    let _cse4 = vec4<f32>(u.proj_params.x, 0.0, u.proj_params.z, u.proj_params.w);
    let _cse10 = (DEG2RAD * EARTH_R);
    let _cse5 = (((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / _cse10) - u.proj_params.y);
    let _gv0 = flat_rel((((local_merc.x - cam_rel_h.x) - cam_rel_l.x) / _cse10), abs_lat, _cse4, _cse5);
    _av0 = (u.mvp * vec4<f32>(_gv0.x, _gv0.y, _cse1, 1.0));
    _v0 = _gv0.x;
  } else {
    let rtc_off_h = select(vec3<f32>(u.cam_ecef_off_h.x, u.cam_ecef_off_h.y, u.cam_ecef_off_h.z), (vec3<f32>(u.tile_ecef_center_h.x, u.tile_ecef_center_h.y, u.tile_ecef_center_h.z) - vec3<f32>(u.cam_ecef_center_h.x, u.cam_ecef_center_h.y, u.cam_ecef_center_h.z)), _cse0);
    let rtc_off_l = select(vec3<f32>(u.cam_ecef_off_l.x, u.cam_ecef_off_l.y, u.cam_ecef_off_l.z), (vec3<f32>(u.tile_ecef_center_l.x, u.tile_ecef_center_l.y, u.tile_ecef_center_l.z) - vec3<f32>(u.cam_ecef_center_l.x, u.cam_ecef_center_l.y, u.cam_ecef_center_l.z)), _cse0);
    _av0 = (u.mvp * vec4<f32>(((dequant_ecef(q_xy, q_z, u.tile_dequant_scale, u.tile_dequant_half) + rtc_off_h) + rtc_off_l), 1.0));
  }
  if ((u.pattern_active == 0u)) {
    _av0.x = (_av0.x + (u.fill_translate_x * _av0.w));
    _av0.y = (_av0.y - (u.fill_translate_y * _av0.w));
  }
  let _v1 = apply_log_depth(_av0, u.log_depth_fc);
  let _cse6 = radians(abs_lon);
  let _v2 = sin(_cse6);
  let _v3 = cos(_cse6);
  let _cse7 = radians(abs_lat);
  let _v4 = sin(_cse7);
  let _v5 = cos(_cse7);
  let _v6 = ((face_normal.x * _v3) + (face_normal.y * _v2));
  let _v7 = vec3<f32>(((face_normal.y * _v3) - (face_normal.x * _v2)), ((face_normal.z * _v5) - (_v4 * _v6)), ((_v5 * _v6) + (face_normal.z * _v4)));
  let d_geom = clamp(dot(select(face_normal, _v7, _cse3), u.light_dir_ecef.xyz), 0.0, 1.0);
  let _cse8 = (1.0 - u.light_dir_ecef.w);
  let vgrad_factor = select(1.0, clamp(((is_top + wall_base) * sqrt((max(wall_height, 0.0) / 150.0))), mix(0.7, 0.98, _cse8), 1.0), ((abs(_v7.z) < 0.5) && (u.cam_ecef_off_l.w != 0.0)));
  let _v8 = clamp((((u.fill_color.rgb + vec3<f32>(0.03)) * (mix(_cse8, max(((1.0 - (((u.fill_color.rgb.x * 0.2126) + (u.fill_color.rgb.y * 0.7152)) + (u.fill_color.rgb.z * 0.0722))) + u.light_dir_ecef.w), 1.0), d_geom) * vgrad_factor)) * unpack4x8unorm(u.light_color_packed).xyz), vec3<f32>(0.0), vec3<f32>(1.0));
  return VertexOutput(vec4<f32>(_v1.x, _v1.y, (_v1.z - (u.layer_depth_offset * _v1.w)), _v1.w), 0.0, u32(feature_id), _cse9, _av0.w, is_top, (_cse6 * EARTH_R), (log(tan(((PI * 0.25) + (_cse2 * 0.5)))) * EARTH_R), (wall_height * is_top), vec4<f32>(_v8, u.fill_color.w), vec2<f32>(d_geom, vgrad_factor), _v0, _v0);
}

@fragment
fn fs_fill(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((u.proj_params.x > 0.5)) {
    if ((abs((input.seam_x - input.seam_x_flat)) > ((PI * EARTH_R) * 0.125))) {
      discard;
    }
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
  let _cse0 = (input.feat_id & 65535u);
  out.depth = (compute_log_frag_depth(input.view_w, u.log_depth_fc) + select(0.0, ((f32((((_cse0 ^ (_cse0 >> 7u)) ^ (_cse0 << 3u)) & 1023u)) - 512.0) * 1.5e-8), (input.feat_id != 0u)));
  return out;
}

@fragment
fn fs_fill_pattern(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((u.proj_params.x > 0.5)) {
    if ((abs((input.seam_x - input.seam_x_flat)) > ((PI * EARTH_R) * 0.125))) {
      discard;
    }
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
  let _cse2 = vec2<f32>(fract((input.abs_merc_x / max(u.fill_translate_x, 1.0))), fract((input.abs_merc_y / max(u.fill_translate_y, 1.0))));
  let _cse0 = textureSample(sprite_atlas, sprite_samp, vec2<f32>((u.fill_color.x + (_cse2.x * (u.fill_color.z - u.fill_color.x))), (u.fill_color.y + (_cse2.y * (u.fill_color.w - u.fill_color.y)))));
  out.color = vec4<f32>(_cse0.rgb, (_cse0.w * u.opacity));
  out.color.w = (out.color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  let _cse1 = (input.feat_id & 65535u);
  out.depth = (compute_log_frag_depth(input.view_w, u.log_depth_fc) + select(0.0, ((f32((((_cse1 ^ (_cse1 >> 7u)) ^ (_cse1 << 3u)) & 1023u)) - 512.0) * 1.5e-8), (input.feat_id != 0u)));
  return out;
}

@fragment
fn fs_oit_translucent(input: VertexOutput) -> OitFragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((u.proj_params.x > 0.5)) {
    if ((abs((input.seam_x - input.seam_x_flat)) > ((PI * EARTH_R) * 0.125))) {
      discard;
    }
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
  let _cse0 = (u.fill_color.w * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  if ((_cse0 <= 0.001)) {
    discard;
  }
  return OitFragmentOutput((vec4<f32>(((u.fill_color.rgb * min(1.0, ((0.6 + (0.4 * input.wall_blend)) + select(0.0, 0.05, (input.wall_blend >= 0.999))))) * _cse0), _cse0) * clamp((0.03 / (0.00001 + pow((max(input.view_w, 0.001) / 200.0), 4.0))), 0.01, 3000.0)), _cse0);
}

@fragment
fn fs_fill_extrude(input: VertexOutput) -> FragmentOutput {
  if ((polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y) < 0.0)) {
    discard;
  }
  if ((abs(input.abs_lat) > (MERCATOR_LAT_LIMIT + 0.5))) {
    discard;
  }
  if ((u.proj_params.x > 0.5)) {
    if ((abs((input.seam_x - input.seam_x_flat)) > ((PI * EARTH_R) * 0.125))) {
      discard;
    }
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
  let v_ext_color = input.v_color;
  out.color = v_ext_color;
  out.color = (out.color * polygon_rim_alpha(input.abs_merc_x, input.abs_merc_y));
  let _cse0 = (input.feat_id & 65535u);
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
  if ((u.proj_params.x > 0.5)) {
    if ((abs((input.seam_x - input.seam_x_flat)) > ((PI * EARTH_R) * 0.125))) {
      discard;
    }
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

