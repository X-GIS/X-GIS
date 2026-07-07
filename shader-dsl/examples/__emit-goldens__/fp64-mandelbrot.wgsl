struct Uniforms {
  center: DF64Vec2,
  resolution: vec2<f32>,
  zoom_exp: f32,
  mouse: vec4<f32>,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct DF64Vec2 {
  hi: vec2<f32>,
  lo: vec2<f32>,
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
fn fs_mandel(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = vec2<f32>(4.0, 0.0);
  let _licm1 = vec2<f32>(2.0, 0.0);
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  let _cse3 = vec2<f32>(0.0, 0.0);
  let _v0 = pow(10.0, (-u.zoom_exp));
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((u.resolution.y / u.resolution.x) * 2.0);
  let _v4 = (((((u.mouse.x / u.resolution.x) - 0.5) * _v0) * 2.0) * u.mouse.w);
  let _v5 = (((((u.mouse.y / u.resolution.y) - 0.5) * _v0) * _v3) * u.mouse.w);
  let _v6 = (((_v2 - 0.5) * _v0) + _v4);
  let _v7 = ((((vo.uv.y - 0.5) * _v0) * _v3) + _v5);
  var _v8: f32 = 0.0;
  if (_cse0) {
    let _v9 = (df64_narrow(_cse1) + _v6);
    let _v10 = (df64_narrow(_cse2) + _v7);
    var _v11: f32 = 0.0;
    var _v12: f32 = 0.0;
    for (var _v13: u32 = 0u; (_v13 < 96u); _v13 = (_v13 + 1u)) {
      if ((((_v11 * _v11) + (_v12 * _v12)) <= 4.0)) {
        let _v14 = (((_v11 * _v11) - (_v12 * _v12)) + _v9);
        _v12 = (((_v11 * _v12) * 2.0) + _v10);
        _v11 = _v14;
        _v8 = (_v8 + 1.0);
      }
    }
  } else {
    let _v15 = df64_add(_cse1, vec2<f32>(_v6, 0.0));
    let _v16 = df64_add(_cse2, vec2<f32>(_v7, 0.0));
    var _v17: vec2<f32> = _cse3;
    var _v18: vec2<f32> = _cse3;
    for (var _v19: u32 = 0u; (_v19 < 96u); _v19 = (_v19 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v17, _v17), df64_mul(_v18, _v18)), _licm0)) {
        let _v20 = df64_add(df64_sub(df64_mul(_v17, _v17), df64_mul(_v18, _v18)), _v15);
        _v18 = df64_add(df64_mul(df64_mul(_v17, _v18), _licm1), _v16);
        _v17 = _v20;
        _v8 = (_v8 + 1.0);
      }
    }
  }
  let _v21 = select(0.0, _v8, (_v8 < 96.0));
  let _v22 = fract((_v21 * 0.11));
  let _v23 = ((sqrt((_v21 / 96.0)) * 0.35) + (_v22 * 0.65));
  return vec4<f32>(mix(vec3<f32>(0.02, 0.03, 0.1), vec3<f32>(1.0, 0.83, 0.36), _v23), 1.0);
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

fn df64_split(a: f32) -> vec2<f32> {
  let _v0 = (a * (_fp64.one * 4097.0));
  let _v1 = ((_v0 * _fp64.one) - (_v0 - a));
  let _v2 = ((a * _fp64.one) - _v1);
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

fn df64_le(a: vec2<f32>, b: vec2<f32>) -> bool {
  return ((a.x < b.x) || ((a.x == b.x) && (a.y <= b.y)));
}

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
