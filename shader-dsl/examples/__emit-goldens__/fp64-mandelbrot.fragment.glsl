#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};

struct DF64Vec2 {
  vec2 hi;
  vec2 lo;
};
layout(std140) uniform Uniforms {
  DF64Vec2 center;
  vec2 resolution;
  float zoom_exp;
  vec4 mouse;
} u;

layout(std140) uniform Fp64Guard {
  float one;
} _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_split(float a);
vec2 df64_twoProd(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
vec2 df64_mul(vec2 a, vec2 b);
bool df64_le(vec2 a, vec2 b);
float df64_narrow(vec2 a);
vec2 df64_twoSum(float a, float b) {
  float _v0 = (a + b);
  float _v1 = (((_v0 * _fp64.one) - a) * _fp64.one);
  float _v2 = (((((a - ((_v0 - _v1) * _fp64.one)) * _fp64.one) * _fp64.one) * _fp64.one) + (b - _v1));
  return vec2(_v0, _v2);
}

vec2 df64_quickTwoSum(float a, float b) {
  float _v0 = ((a + b) * _fp64.one);
  float _v1 = (b - ((_v0 - a) * _fp64.one));
  return vec2(_v0, _v1);
}

vec2 df64_split(float a) {
  float _v0 = (a * (_fp64.one * 4097.0));
  float _v1 = ((_v0 * _fp64.one) - (_v0 - a));
  float _v2 = ((a * _fp64.one) - _v1);
  return vec2(_v1, _v2);
}

vec2 df64_twoProd(float a, float b) {
  float _v0 = (a * b);
  vec2 _v1 = df64_split(a);
  vec2 _v2 = df64_split(b);
  float _v3 = (((((_v1.x * _v2.x) - _v0) + (_v1.x * _v2.y)) + (_v1.y * _v2.x)) + (_v1.y * _v2.y));
  return vec2(_v0, _v3);
}

vec2 df64_add(vec2 a, vec2 b) {
  vec2 _v0 = df64_twoSum(a.x, b.x);
  vec2 _v1 = df64_twoSum(a.y, b.y);
  _v0.y = (_v0.y + _v1.x);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + _v1.y);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  return _v0;
}

vec2 df64_sub(vec2 a, vec2 b) {
  return df64_add(a, (-b));
}

vec2 df64_mul(vec2 a, vec2 b) {
  vec2 _v0 = df64_twoProd(a.x, b.x);
  _v0.y = (_v0.y + (a.x * b.y));
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

bool df64_le(vec2 a, vec2 b) {
  return ((a.x < b.x) || ((a.x == b.x) && (a.y <= b.y)));
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_mandel_impl(VsOut vo) {
  vec2 _licm0 = vec2(4.0, 0.0);
  vec2 _licm1 = vec2(2.0, 0.0);
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(u.center.hi.x, u.center.lo.x);
  vec2 _cse2 = vec2(u.center.hi.y, u.center.lo.y);
  vec2 _cse3 = vec2(0.0, 0.0);
  float _v0 = pow(10.0, (-u.zoom_exp));
  float _v1 = (vo.uv.x * 2.0);
  float _v2 = (_v1 - (_cse0 ? 0.0 : 1.0));
  float _v3 = ((u.resolution.y / u.resolution.x) * 2.0);
  float _v4 = (((((u.mouse.x / u.resolution.x) - 0.5) * _v0) * 2.0) * u.mouse.w);
  float _v5 = (((((u.mouse.y / u.resolution.y) - 0.5) * _v0) * _v3) * u.mouse.w);
  float _v6 = (((_v2 - 0.5) * _v0) + _v4);
  float _v7 = ((((vo.uv.y - 0.5) * _v0) * _v3) + _v5);
  float _v8 = 0.0;
  if (_cse0) {
    float _v9 = (df64_narrow(_cse1) + _v6);
    float _v10 = (df64_narrow(_cse2) + _v7);
    float _v11 = 0.0;
    float _v12 = 0.0;
    for (uint _v13 = 0u; (_v13 < 96u); _v13 = (_v13 + 1u)) {
      if ((((_v11 * _v11) + (_v12 * _v12)) <= 4.0)) {
        float _v14 = (((_v11 * _v11) - (_v12 * _v12)) + _v9);
        _v12 = (((_v11 * _v12) * 2.0) + _v10);
        _v11 = _v14;
        _v8 = (_v8 + 1.0);
      }
    }
  } else {
    vec2 _v15 = df64_add(_cse1, vec2(_v6, 0.0));
    vec2 _v16 = df64_add(_cse2, vec2(_v7, 0.0));
    vec2 _v17 = _cse3;
    vec2 _v18 = _cse3;
    for (uint _v19 = 0u; (_v19 < 96u); _v19 = (_v19 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v17, _v17), df64_mul(_v18, _v18)), _licm0)) {
        vec2 _v20 = df64_add(df64_sub(df64_mul(_v17, _v17), df64_mul(_v18, _v18)), _v15);
        _v18 = df64_add(df64_mul(df64_mul(_v17, _v18), _licm1), _v16);
        _v17 = _v20;
        _v8 = (_v8 + 1.0);
      }
    }
  }
  float _v21 = ((_v8 < 96.0) ? _v8 : 0.0);
  float _v22 = fract((_v21 * 0.11));
  float _v23 = ((sqrt((_v21 / 96.0)) * 0.35) + (_v22 * 0.65));
  return vec4(mix(vec3(0.02, 0.03, 0.1), vec3(1.0, 0.83, 0.36), _v23), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_mandel_impl(vo);
}
