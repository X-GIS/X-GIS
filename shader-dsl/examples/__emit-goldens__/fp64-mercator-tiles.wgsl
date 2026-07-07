struct Uniforms {
  center: DF64Vec2,
  resolution: vec2<f32>,
  tile_z: f32,
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
fn fs_tiles(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = u.tile_z;
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  var _v0: f32 = 1.0;
  for (var _v1: u32 = 0u; (f32(_v1) < _licm0); _v1 = (_v1 + 1u)) {
    _v0 = (_v0 * 2.0);
  }
  let _v2 = (3.0 / _v0);
  let _v3 = (vo.uv.x * 2.0);
  let _v4 = (_v3 - select(1.0, 0.0, _cse0));
  let _v5 = ((_v4 - 0.5) * _v2);
  let _v6 = (((vo.uv.y - 0.5) * _v2) * ((u.resolution.y / u.resolution.x) * 2.0));
  let _v7 = (_cse0 || (u.fp64 < 0.5));
  let _v8 = df64_mul(df64_add(_cse1, vec2<f32>(_v5, 0.0)), vec2<f32>(_v0, 0.0));
  let _v9 = df64_mul(df64_add(_cse2, vec2<f32>(_v6, 0.0)), vec2<f32>(_v0, 0.0));
  let _v10 = df64_narrow(df64_floor(_v8));
  let _v11 = df64_narrow(df64_floor(_v9));
  let _v12 = df64_narrow(df64_fract(_v8));
  let _v13 = df64_narrow(df64_fract(_v9));
  let _v14 = (df64_narrow(df64_fract(df64_mul(df64_add(df64_floor(_v8), df64_floor(_v9)), vec2<f32>(0.5, 0.0)))) * 2.0);
  let _v15 = ((df64_narrow(_cse1) + _v5) * _v0);
  let _v16 = ((df64_narrow(_cse2) + _v6) * _v0);
  let _v17 = floor(_v15);
  let _v18 = floor(_v16);
  let _v19 = fract(_v15);
  let _v20 = fract(_v16);
  let _v21 = (fract(((_v17 + _v18) * 0.5)) * 2.0);
  let _v22 = select(_v10, _v17, _v7);
  let _v23 = select(_v11, _v18, _v7);
  let _v24 = select(_v12, _v19, _v7);
  let _v25 = select(_v13, _v20, _v7);
  let _v26 = select(_v14, _v21, _v7);
  let _v27 = fract((sin(dot(vec2<f32>(_v22, _v23), vec2<f32>(127.1, 311.7))) * 43758.5453));
  let _v28 = (mix(vec3<f32>(0.78, 0.84, 0.88), vec3<f32>(0.9, 0.87, 0.78), _v27) * mix(0.88, 1.0, _v26));
  let _v29 = mix(0.92, 1.05, ((_v24 * 0.6) + (_v25 * 0.4)));
  let _v30 = min(min(_v24, (1.0 - _v24)), min(_v25, (1.0 - _v25)));
  let _v31 = (3.0 / (u.resolution.x * 0.5));
  let _v32 = smoothstep(0.0, ((_v31 * 1.6) + 1e-9), _v30);
  let _v33 = step(_v30, (_v31 * 6.0));
  return vec4<f32>((((_v28 * _v29) * mix(0.45, 1.0, _v32)) - (vec3<f32>(0.05, 0.04, 0.02) * _v33)), 1.0);
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
