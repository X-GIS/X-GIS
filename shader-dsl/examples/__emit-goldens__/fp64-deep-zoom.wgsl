struct Uniforms {
  origin: vec2<f32>,
  span: f32,
  fp64: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct Fp64Guard {
  one: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> _fp64: Fp64Guard;

@vertex
fn vs_full(@builtin(vertex_index) idx: u32) -> VsOut {
  var _av0: vec2<f32> = vec2<f32>(-1.0, -1.0);
  if ((idx == 1u)) {
    _av0 = vec2<f32>(3.0, -1.0);
  } else if ((idx == 2u)) {
    _av0 = vec2<f32>(-1.0, 3.0);
  }
  return VsOut(vec4<f32>(_av0, 0.0, 1.0), vec2<f32>(((_av0.x + 1.0) * 0.5), ((_av0.y + 1.0) * 0.5)));
}

@fragment
fn fs_stripes(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse1 = (vo.uv.x * u.span);
  let _cse0 = select(df64_narrow(df64_fract(df64_add(u.origin, vec2<f32>(_cse1, 0.0)))), fract((df64_narrow(u.origin) + _cse1)), ((vo.uv.x < 0.5) || (u.fp64 < 0.5)));
  return vec4<f32>(_cse0, _cse0, _cse0, 1.0);
}

fn df64_twoSum(a: f32, b: f32) -> vec2<f32> {
  let _v0 = (a + b);
  let _v1 = (((_v0 * _fp64.one) - a) * _fp64.one);
  let _v2 = (((((a - ((_v0 - _v1) * _fp64.one)) * _fp64.one) * _fp64.one) * _fp64.one) + (b - _v1));
  return vec2<f32>(_v0, _v2);
}

fn df64_quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let _v0 = ((a + b) * _fp64.one);
  let _v1 = (b - ((_v0 - a) * _fp64.one));
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
