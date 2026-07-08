struct Uniforms {
  resolution: vec2<f32>,
  half_width: f32,
  fp64: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var _fp64: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs_cancel(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(1.0, 0.0);
  let _cse2 = vec2<f32>(7.0, 0.0);
  let _cse3 = vec2<f32>(21.0, 0.0);
  let _cse4 = vec2<f32>(35.0, 0.0);
  let _v0 = u.half_width;
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((_v2 - 0.5) * (_v0 * 2.0));
  let _v4 = (_cse0 || (u.fp64 < 0.5));
  let _v5 = df64_add(_cse1, vec2<f32>(_v3, 0.0));
  let _v6 = df64_mul(_v5, _v5);
  let _v7 = df64_mul(_v6, _v5);
  let _v8 = df64_mul(_v6, _v6);
  let _v9 = df64_mul(_v8, _v5);
  let _v10 = df64_mul(_v7, _v7);
  let _v11 = df64_mul(_v10, _v5);
  let _v12 = df64_narrow(df64_sub(df64_add(df64_sub(df64_add(df64_sub(df64_add(df64_sub(_v11, df64_mul(_v10, _cse2)), df64_mul(_v9, _cse3)), df64_mul(_v8, _cse4)), df64_mul(_v7, _cse4)), df64_mul(_v6, _cse3)), df64_mul(_v5, _cse2)), _cse1));
  let _v13 = (1.0 + _v3);
  let _v14 = (_v13 * _v13);
  let _v15 = (_v14 * _v13);
  let _v16 = (_v14 * _v14);
  let _v17 = (_v16 * _v13);
  let _v18 = (_v15 * _v15);
  let _v19 = (_v18 * _v13);
  let _v20 = (((((((_v19 - (_v18 * 7.0)) + (_v17 * 21.0)) - (_v16 * 35.0)) + (_v15 * 35.0)) - (_v14 * 21.0)) + (_v13 * 7.0)) - 1.0);
  let _v21 = select(_v12, _v20, _v4);
  let _v22 = (pow(_v0, 7.0) * 1.3);
  let _v23 = (_v21 / _v22);
  let _v24 = (_v3 * _v3);
  let _v25 = ((((_v24 * _v24) * _v24) * _v3) / _v22);
  let _v26 = ((vo.uv.y - 0.5) * 2.0);
  let _v27 = (2.0 / u.resolution.y);
  let _v28 = fract((_v2 * 10.0));
  let _v29 = fract(((_v26 + 1.0) * 5.0));
  let _v30 = min(_v28, (1.0 - _v28));
  let _v31 = min(_v29, (1.0 - _v29));
  let _v32 = (30.0 / u.resolution.x);
  let _v33 = (15.0 / u.resolution.y);
  let _v34 = ((1.0 - smoothstep(0.0, _v32, _v30)) + (1.0 - smoothstep(0.0, _v33, _v31)));
  let _v35 = mix(vec3<f32>(0.96, 0.94, 0.88), vec3<f32>(0.72, 0.78, 0.86), (min(_v34, 1.0) * 0.45));
  let _v36 = step(_v26, _v23);
  let _v37 = mix(_v35, vec3<f32>(0.62, 0.74, 0.9), (_v36 * 0.5));
  let _v38 = (1.0 - smoothstep((_v27 * 1.2), (_v27 * 3.0), abs((_v23 - _v26))));
  let _v39 = mix(_v37, vec3<f32>(0.13, 0.16, 0.3), (_v38 * 0.85));
  let _v40 = (1.0 - smoothstep((_v27 * 0.8), (_v27 * 2.2), abs((_v25 - _v26))));
  let _v41 = mix(_v39, vec3<f32>(0.8, 0.25, 0.2), (_v40 * 0.65));
  let _lc0 = (_v27 * 1.5);
  let _v42 = min(smoothstep(0.0, _lc0, abs(_v26)), smoothstep(0.0, _lc0, (abs((_v2 - 0.5)) * 2.0)));
  let _v43 = mix(vec3<f32>(0.35, 0.33, 0.3), _v41, _v42);
  return vec4<f32>(_v43, 1.0);
}

fn df64_twoSum(a: f32, b: f32) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = (a + b);
  let _v1 = (((_v0 * _cse0) - a) * _cse0);
  let _v2 = (((((a - ((_v0 - _v1) * _cse0)) * _cse0) * _cse0) * _cse0) + (b - _v1));
  return vec2<f32>(_v0, _v2);
}

fn df64_quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = ((a + b) * _cse0);
  let _v1 = (b - ((_v0 - a) * _cse0));
  return vec2<f32>(_v0, _v1);
}

fn df64_split(a: f32) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = (a * (_cse0 * 4097.0));
  let _v1 = ((_v0 * _cse0) - (_v0 - a));
  let _v2 = ((a * _cse0) - _v1);
  return vec2<f32>(_v1, _v2);
}

fn df64_twoProd(a: f32, b: f32) -> vec2<f32> {
  let _v0 = (a * b);
  let _v1 = df64_split(a);
  let _v2 = df64_split(b);
  let _v3 = (((((_v1.x * _v2.x) - _v0) + (_v1.x * _v2.y)) + (_v1.y * _v2.x)) + (_v1.y * _v2.y));
  return vec2<f32>(_v0, _v3);
}

fn df64_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var _v0: vec2<f32> = df64_twoSum(a.x, b.x);
  let _v1 = df64_twoSum(a.y, b.y);
  _v0.y = (_v0.y + _v1.x);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + _v1.y);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  return _v0;
}

fn df64_sub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return df64_add(a, (-b));
}

fn df64_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var _v0: vec2<f32> = df64_twoProd(a.x, b.x);
  _v0.y = (_v0.y + (a.x * b.y));
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
