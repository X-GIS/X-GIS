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
fn fs_julia(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = vec2<f32>(16.0, 0.0);
  let _licm1 = vec2<f32>(-0.800000011920929, 1.1920929132713809e-8);
  let _licm2 = vec2<f32>(2.0, 0.0);
  let _licm3 = vec2<f32>(0.15600000321865082, -3.218650901359865e-9);
  let _cse0 = (vo.uv.x < 0.5);
  let _cse1 = vec2<f32>(u.center.hi.x, u.center.lo.x);
  let _cse2 = vec2<f32>(u.center.hi.y, u.center.lo.y);
  let _v0 = pow(10.0, (-u.zoom_exp));
  let _v1 = (vo.uv.x * 2.0);
  let _v2 = (_v1 - select(1.0, 0.0, _cse0));
  let _v3 = ((_v2 - 0.5) * _v0);
  let _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  var _v5: f32 = 0.0;
  var _v6: f32 = 0.0;
  if ((_cse0 || (u.fp64 < 0.5))) {
    var _v7: f32 = (df64_narrow(_cse1) + _v3);
    var _v8: f32 = (df64_narrow(_cse2) + _v4);
    for (var _v9: u32 = 0u; (_v9 < 128u); _v9 = (_v9 + 1u)) {
      if ((((_v7 * _v7) + (_v8 * _v8)) <= 16.0)) {
        let _v10 = (((_v7 * _v7) - (_v8 * _v8)) + -0.8);
        _v8 = (((_v7 * _v8) * 2.0) + 0.156);
        _v7 = _v10;
        _v5 = (_v5 + 1.0);
      }
    }
    _v6 = ((_v7 * _v7) + (_v8 * _v8));
  } else {
    var _v11: vec2<f32> = df64_add(_cse1, vec2<f32>(_v3, 0.0));
    var _v12: vec2<f32> = df64_add(_cse2, vec2<f32>(_v4, 0.0));
    for (var _v13: u32 = 0u; (_v13 < 128u); _v13 = (_v13 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v11, _v11), df64_mul(_v12, _v12)), _licm0)) {
        let _v14 = df64_add(df64_sub(df64_mul(_v11, _v11), df64_mul(_v12, _v12)), _licm1);
        _v12 = df64_add(df64_mul(df64_mul(_v11, _v12), _licm2), _licm3);
        _v11 = _v14;
        _v5 = (_v5 + 1.0);
      }
    }
    _v6 = df64_narrow(df64_add(df64_mul(_v11, _v11), df64_mul(_v12, _v12)));
  }
  let _v15 = ((_v5 - log2(max(log2(max(_v6, 1.0001)), 0.0001))) + 1.0);
  let _v16 = step(127.5, _v5);
  let _v17 = (_v15 / 128.0);
  return vec4<f32>((((vec3<f32>(0.5) + (cos(((vec3<f32>(0.0, 0.25, 0.6) + (_v17 * 5.5)) + 2.2)) * 0.5)) * mix(0.35, 1.0, _v17)) * (1.0 - _v16)), 1.0);
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
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  var _v0: vec2<f32> = df64_twoProd(a.x, b.x);
  _v0.y = (_v0.y + ((a.x * b.y) * _cse0));
  _v0.y = (_v0.y + (((a.y * b.x) * _cse0) * _cse0));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

fn df64_le(a: vec2<f32>, b: vec2<f32>) -> bool {
  return ((a.x < b.x) || ((a.x == b.x) && (a.y <= b.y)));
}

fn df64_narrow(a: vec2<f32>) -> f32 {
  return (a.x + a.y);
}
