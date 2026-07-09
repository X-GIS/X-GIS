struct Uniforms {
  center: DF64Vec2,
  st_a: DF64Vec2,
  st_b: DF64Vec2,
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
fn fs_loran(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse7 = vec2<f32>(u.st_a.hi.x, u.st_a.lo.x);
  let _cse8 = vec2<f32>(0.0, 0.0);
  let _cse9 = vec2<f32>(u.st_a.hi.y, u.st_a.lo.y);
  let _cse10 = vec2<f32>(u.st_b.hi.x, u.st_b.lo.x);
  let _cse11 = vec2<f32>(u.st_b.hi.y, u.st_b.lo.y);
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  let _cse3 = df64_add(_cse7, _cse8);
  let _cse4 = df64_add(_cse9, _cse8);
  let _cse5 = df64_add(_cse10, _cse8);
  let _cse6 = df64_add(_cse11, _cse8);
  let _v0 = pow(10.0, (-u.zoom_exp));
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((_v2 - 0.5) * _v0);
  let _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  let _v5 = (_cse0 || (u.fp64 < 0.5));
  let _lc0 = df64_add(_cse1, vec2<f32>(_v3, 0.0));
  let _lc1 = df64_add(_cse2, vec2<f32>(_v4, 0.0));
  let _v6 = DF64Vec2(vec2<f32>(_lc0.x, _lc1.x), vec2<f32>(_lc0.y, _lc1.y));
  let _lc2 = df64_sub(df64_add(vec2<f32>(_v6.hi.x, _v6.lo.x), _cse8), _cse3);
  let _lc3 = df64_sub(df64_add(vec2<f32>(_v6.hi.y, _v6.lo.y), _cse8), _cse4);
  let _v7 = df64_sqrt(df64_add(df64_mul(_lc2, _lc2), df64_mul(_lc3, _lc3)));
  let _lc4 = df64_sub(df64_add(vec2<f32>(_v6.hi.x, _v6.lo.x), _cse8), _cse5);
  let _lc5 = df64_sub(df64_add(vec2<f32>(_v6.hi.y, _v6.lo.y), _cse8), _cse6);
  let _v8 = df64_sqrt(df64_add(df64_mul(_lc4, _lc4), df64_mul(_lc5, _lc5)));
  let _v9 = df64_narrow(df64_fract(df64_mul(df64_sub(df64_add(_v7, _cse8), df64_add(_v8, _cse8)), vec2<f32>(0.25, 0.0))));
  let _v10 = df64_narrow(df64_fract(df64_mul(df64_add(_v7, _v8), vec2<f32>(0.0625, 0.0))));
  let _v11 = vec2<f32>((df64_narrow(_cse1) + _v3), (df64_narrow(_cse2) + _v4));
  let _v12 = length((_v11 - vec2<f32>(df64_narrow(_cse7), df64_narrow(_cse9))));
  let _v13 = length((_v11 - vec2<f32>(df64_narrow(_cse10), df64_narrow(_cse11))));
  let _v14 = fract(((_v12 - _v13) * 0.25));
  let _v15 = fract(((_v12 + _v13) * 0.0625));
  let _v16 = select(_v9, _v14, _v5);
  let _v17 = select(_v10, _v15, _v5);
  let _v18 = min(_v16, (1.0 - _v16));
  let _v19 = min(_v17, (1.0 - _v17));
  let _v20 = ((fwidth(_v18) * 1.2) + 0.0001);
  let _v21 = ((fwidth(_v19) * 1.2) + 0.0001);
  let _v22 = (1.0 - smoothstep(0.0, _v20, _v18));
  let _v23 = (1.0 - smoothstep(0.0, _v21, _v19));
  let _v24 = mix(vec3<f32>(0.02, 0.07, 0.13), vec3<f32>(0.04, 0.12, 0.2), vo.uv.y);
  return vec4<f32>((((_v24 + (vec3<f32>(0.0, 0.06, 0.08) * _v16)) + (vec3<f32>(0.25, 0.95, 0.95) * (_v22 * 0.9))) + (vec3<f32>(0.95, 0.7, 0.25) * (_v23 * 0.35))), 1.0);
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

fn df64_twoSqr(a: f32) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = (a * a);
  let _v1 = df64_split(a);
  let _v2 = (((((_v1.x * _v1.x) - _v0) * _cse0) + ((((_v1.x * _v1.y) * 2.0) * _cse0) * _cse0)) + ((((_v1.y * _v1.y) * _cse0) * _cse0) * _cse0));
  return vec2<f32>(_v0, _v2);
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

fn df64_sqrt(a: vec2<f32>) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = (_cse0 / sqrt(a.x));
  let _v1 = (a.x * _v0);
  let _v2 = (df64_twoSqr(_v1) * _cse0);
  let _v3 = df64_sub(a, _v2).x;
  let _v4 = df64_twoProd((_v0 * 0.5), _v3);
  let _v5 = df64_add(vec2<f32>(_v1, 0.0), _v4);
  return select(_v5, vec2<f32>(0.0, 0.0), (a.x == 0.0));
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
