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
fn fs_newton(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = vec2<f32>(2.0, 0.0);
  let _licm1 = vec2<f32>(0.0, 0.0);
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  let _cse3 = df64_add(vec2<f32>(1.0, 0.0), _licm1);
  let _cse4 = vec2<f32>(3.0, 0.0);
  let _v0 = pow(10.0, (-u.zoom_exp));
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((_v2 - 0.5) * _v0);
  let _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  var _v5: f32 = 0.0;
  var _v6: f32 = 0.0;
  var _v7: f32 = 0.0;
  if ((_cse0 || (u.fp64 < 0.5))) {
    var _v8: f32 = (df64_narrow(_cse1) + _v3);
    var _v9: f32 = (df64_narrow(_cse2) + _v4);
    for (var _v10: u32 = 0u; (_v10 < 48u); _v10 = (_v10 + 1u)) {
      let _v11 = ((_v8 * _v8) - (_v9 * _v9));
      let _v12 = ((_v8 * _v9) * 2.0);
      let _v13 = (((_v11 * _v8) - (_v12 * _v9)) - 1.0);
      let _v14 = ((_v11 * _v9) + (_v12 * _v8));
      let _v15 = (_v11 * 3.0);
      let _v16 = (_v12 * 3.0);
      let _v17 = (1.0 / ((_v15 * _v15) + (_v16 * _v16)));
      let _v18 = (((_v13 * _v15) + (_v14 * _v16)) * _v17);
      let _v19 = (((_v14 * _v15) - (_v13 * _v16)) * _v17);
      _v8 = (_v8 - _v18);
      _v9 = (_v9 - _v19);
      if ((((_v18 * _v18) + (_v19 * _v19)) > 1e-14)) {
        _v7 = (_v7 + 1.0);
      }
    }
    _v5 = _v8;
    _v6 = _v9;
  } else {
    var _v20: vec2<f32> = df64_add(_cse1, vec2<f32>(_v3, 0.0));
    var _v21: vec2<f32> = df64_add(_cse2, vec2<f32>(_v4, 0.0));
    for (var _v22: u32 = 0u; (_v22 < 48u); _v22 = (_v22 + 1u)) {
      let _v23 = df64_sub(df64_mul(_v20, _v20), df64_mul(_v21, _v21));
      let _v24 = df64_mul(df64_mul(_v20, _v21), _licm0);
      let _v25 = df64_sub(df64_sub(df64_mul(_v23, _v20), df64_mul(_v24, _v21)), _cse3);
      let _v26 = df64_add(df64_mul(_v23, _v21), df64_mul(_v24, _v20));
      let _v27 = df64_mul(_v23, _cse4);
      let _v28 = df64_mul(_v24, _cse4);
      let _v29 = df64_div(_cse3, df64_add(df64_mul(_v27, _v27), df64_mul(_v28, _v28)));
      let _v30 = df64_mul(df64_add(df64_mul(_v25, _v27), df64_mul(_v26, _v28)), _v29);
      let _v31 = df64_mul(df64_sub(df64_mul(_v26, _v27), df64_mul(_v25, _v28)), _v29);
      _v20 = df64_sub(df64_add(_v20, _licm1), df64_add(_v30, _licm1));
      _v21 = df64_sub(df64_add(_v21, _licm1), df64_add(_v31, _licm1));
      if ((df64_narrow(df64_add(df64_mul(_v30, _v30), df64_mul(_v31, _v31))) > 1e-14)) {
        _v7 = (_v7 + 1.0);
      }
    }
    _v5 = df64_narrow(_v20);
    _v6 = df64_narrow(_v21);
  }
  let _lc0 = (_v5 - 1.0);
  let _v32 = ((_lc0 * _lc0) + (_v6 * _v6));
  let _lc1 = (_v5 + 0.5);
  let _lc2 = (_v6 - 0.8660254037844386);
  let _v33 = ((_lc1 * _lc1) + (_lc2 * _lc2));
  let _lc3 = (_v5 + 0.5);
  let _lc4 = (_v6 + 0.8660254037844386);
  let _v34 = ((_lc3 * _lc3) + (_lc4 * _lc4));
  let _v35 = select(select(vec3<f32>(0.98, 0.78, 0.22), vec3<f32>(0.2, 0.66, 0.88), (_v33 <= _v34)), vec3<f32>(0.91, 0.34, 0.22), ((_v32 <= _v33) && (_v32 <= _v34)));
  let _v36 = (1.0 - (_v7 / 48.0));
  return vec4<f32>((_v35 * mix(0.25, 1.0, _v36)), 1.0);
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

fn df64_div(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let _v0 = (textureLoad(_fp64, vec2<i32>(0, 0), 0).x / b.x);
  let _v1 = (a * _v0);
  let _v2 = df64_sub(a, df64_mul(b, _v1)).x;
  let _v3 = df64_twoProd(_v0, _v2);
  return df64_add(_v1, _v3);
}

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
