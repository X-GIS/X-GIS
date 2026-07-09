struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  epoch: vec2<f32>,
  speed: f32,
  fp64: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var _fp64: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs_clock(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>((U.resolution.x * 0.5), U.resolution.y);
  let _v0 = df64_narrow(df64_fract(df64_mul(df64_add(U.epoch, vec2<f32>(U.time, 0.0)), vec2<f32>(U.speed, 0.0))));
  let _v1 = fract(((df64_narrow(U.epoch) + U.time) * U.speed));
  let _v2 = (_cse0 || (U.fp64 < 0.5));
  let _v3 = select(_v0, _v1, _v2);
  let _v4 = (vo.uv.x * 2.0);
  let _v5 = (_v4 - select(1.0, 0.0, _cse0));
  let _lc0 = vec2<f32>(_v5, vo.uv.y);
  let _v6 = vec2<f32>((((_lc0.x * 2.0) - 1.0) * (_cse1.x / _cse1.y)), ((_lc0.y * 2.0) - 1.0));
  let _v7 = length(_v6);
  let _v8 = fract((0.25 - (atan2(_v6.y, _v6.x) / 6.283185307179586)));
  let _v9 = (2.0 / U.resolution.y);
  let _v10 = (1.0 - smoothstep((_v9 * 1.5), (_v9 * 3.0), (abs((_v7 - 0.82)) - 0.012)));
  let _v11 = ((-abs((fract((_v8 * 12.0)) - 0.5))) + 0.5);
  let _v12 = (((1.0 - smoothstep(0.0, 0.035, _v11)) * smoothstep(0.62, 0.66, _v7)) * (1.0 - smoothstep(0.78, 0.8, _v7)));
  let _v13 = fract(((_v3 - _v8) + 1.0));
  let _v14 = (((1.0 - smoothstep(0.0, 0.006, min(_v13, (1.0 - _v13)))) * step(_v7, 0.6)) * smoothstep(0.05, 0.1, _v7));
  let _v15 = ((exp((_v13 * -5.0)) * 0.35) * step(_v7, 0.58));
  let _v16 = (1.0 - smoothstep((_v9 * 2.0), (_v9 * 5.0), _v7));
  let _v17 = mix(vec3<f32>(0.03, 0.045, 0.08), vec3<f32>(0.05, 0.075, 0.12), _v7);
  return vec4<f32>((((((_v17 + (vec3<f32>(0.85, 0.9, 1.0) * (_v10 * 0.35))) + (vec3<f32>(0.8, 0.85, 0.95) * (_v12 * 0.5))) + (vec3<f32>(1.0, 0.72, 0.2) * _v14)) + (vec3<f32>(1.0, 0.6, 0.15) * _v15)) + (vec3<f32>(1.0, 0.85, 0.5) * _v16)), 1.0);
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
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

fn df64_floor(a: vec2<f32>) -> vec2<f32> {
  let _v0 = floor(a.x);
  return select(vec2<f32>(_v0, 0.0), df64_quickTwoSum(_v0, floor(a.y)), (_v0 == a.x));
}

fn df64_fract(a: vec2<f32>) -> vec2<f32> {
  return df64_sub(a, df64_floor(a));
}

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
