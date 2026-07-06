struct Uniforms {
  center: DF64Vec2,
  resolution: vec2<f32>,
  zoom_exp: f32,
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
  let _v3 = ((_v2 - 0.5) * _v0);
  let _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  var _v5: f32 = 0.0;
  if (_cse0) {
    let _v6 = (df64_narrow(_cse1) + _v3);
    let _v7 = (df64_narrow(_cse2) + _v4);
    var _v8: f32 = 0.0;
    var _v9: f32 = 0.0;
    for (var _v10: u32 = 0u; (_v10 < 96u); _v10 = (_v10 + 1u)) {
      if ((((_v8 * _v8) + (_v9 * _v9)) <= 4.0)) {
        let _v11 = (((_v8 * _v8) - (_v9 * _v9)) + _v6);
        _v9 = (((_v8 * _v9) * 2.0) + _v7);
        _v8 = _v11;
        _v5 = (_v5 + 1.0);
      }
    }
  } else {
    let _v12 = df64_add(_cse1, vec2<f32>(_v3, 0.0));
    let _v13 = df64_add(_cse2, vec2<f32>(_v4, 0.0));
    var _v14: vec2<f32> = _cse3;
    var _v15: vec2<f32> = _cse3;
    for (var _v16: u32 = 0u; (_v16 < 96u); _v16 = (_v16 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v14, _v14), df64_mul(_v15, _v15)), _licm0)) {
        let _v17 = df64_add(df64_sub(df64_mul(_v14, _v14), df64_mul(_v15, _v15)), _v12);
        _v15 = df64_add(df64_mul(df64_mul(_v14, _v15), _licm1), _v13);
        _v14 = _v17;
        _v5 = (_v5 + 1.0);
      }
    }
  }
  let _v18 = select(0.0, _v5, (_v5 < 96.0));
  let _v19 = fract((_v18 * 0.11));
  let _v20 = ((sqrt((_v18 / 96.0)) * 0.35) + (_v19 * 0.65));
  return vec4<f32>(mix(vec3<f32>(0.02, 0.03, 0.1), vec3<f32>(1.0, 0.83, 0.36), _v20), 1.0);
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
