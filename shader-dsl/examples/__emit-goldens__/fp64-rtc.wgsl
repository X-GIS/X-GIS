struct Uniforms {
  center: DF64Vec2,
  resolution: vec2<f32>,
  zoom_exp: f32,
  fp64: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct DF64Vec2 {
  hi: vec2<f32>,
  lo: vec2<f32>,
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
fn fs_rtc(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(0.0, 0.0);
  let _cse3 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  let _v0 = pow(10.0, (-u.zoom_exp));
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((_v2 - 0.5) * _v0);
  let _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  let _v5 = (_cse0 || (u.fp64 < 0.5));
  let _v6 = df64_narrow(df64_sub(df64_add(_cse1, vec2<f32>(_v3, 0.0)), df64_add(vec2<f32>(100000000.0, 3.700000047683716), _cse2)));
  let _v7 = df64_narrow(df64_sub(df64_add(_cse3, vec2<f32>(_v4, 0.0)), df64_add(vec2<f32>(50000004.0, -1.7000000476837158), _cse2)));
  let _v8 = ((df64_narrow(_cse1) + _v3) - 100000003.7);
  let _v9 = ((df64_narrow(_cse3) + _v4) - 50000002.3);
  let _v10 = select(_v6, _v8, _v5);
  let _v11 = select(_v7, _v9, _v5);
  let _v12 = (_v0 * 0.125);
  let _v13 = length(vec2<f32>(_v10, _v11));
  let _v14 = (_v0 / (u.resolution.x * 0.5));
  let _v15 = (((-abs((fract((_v13 / _v12)) - 0.5))) + 0.5) * _v12);
  let _v16 = (1.0 - smoothstep(0.0, ((_v14 * 1.6) + 1e-9), _v15));
  let _v17 = (1.0 - smoothstep(0.0, ((_v14 * 1.4) + 1e-9), min(abs(_v10), abs(_v11))));
  let _v18 = exp((-(_v13 / ((_v14 * 6.0) + 1e-9))));
  let _v19 = max(0.0, (1.0 - (_v13 / (_v0 * 0.75))));
  let _v20 = mix(vec3<f32>(0.01, 0.04, 0.02), vec3<f32>(0.02, 0.09, 0.045), _v19);
  return vec4<f32>((((_v20 + (vec3<f32>(0.1, 0.75, 0.3) * (_v16 * 0.8))) + (vec3<f32>(0.12, 0.9, 0.4) * (_v17 * 0.55))) + (vec3<f32>(1.0, 0.45, 0.25) * _v18)), 1.0);
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

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
