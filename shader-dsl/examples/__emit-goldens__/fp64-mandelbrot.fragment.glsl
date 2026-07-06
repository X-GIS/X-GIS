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
  float _v3 = ((_v2 - 0.5) * _v0);
  float _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  float _v5 = 0.0;
  if (_cse0) {
    float _v6 = (df64_narrow(_cse1) + _v3);
    float _v7 = (df64_narrow(_cse2) + _v4);
    float _v8 = 0.0;
    float _v9 = 0.0;
    for (uint _v10 = 0u; (_v10 < 96u); _v10 = (_v10 + 1u)) {
      if ((((_v8 * _v8) + (_v9 * _v9)) <= 4.0)) {
        float _v11 = (((_v8 * _v8) - (_v9 * _v9)) + _v6);
        _v9 = (((_v8 * _v9) * 2.0) + _v7);
        _v8 = _v11;
        _v5 = (_v5 + 1.0);
      }
    }
  } else {
    vec2 _v12 = df64_add(_cse1, vec2(_v3, 0.0));
    vec2 _v13 = df64_add(_cse2, vec2(_v4, 0.0));
    vec2 _v14 = _cse3;
    vec2 _v15 = _cse3;
    for (uint _v16 = 0u; (_v16 < 96u); _v16 = (_v16 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v14, _v14), df64_mul(_v15, _v15)), _licm0)) {
        vec2 _v17 = df64_add(df64_sub(df64_mul(_v14, _v14), df64_mul(_v15, _v15)), _v12);
        _v15 = df64_add(df64_mul(df64_mul(_v14, _v15), _licm1), _v13);
        _v14 = _v17;
        _v5 = (_v5 + 1.0);
      }
    }
  }
  float _v18 = ((_v5 < 96.0) ? _v5 : 0.0);
  float _v19 = fract((_v18 * 0.11));
  float _v20 = ((sqrt((_v18 / 96.0)) * 0.35) + (_v19 * 0.65));
  return vec4(mix(vec3(0.02, 0.03, 0.1), vec3(1.0, 0.83, 0.36), _v20), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_mandel_impl(vo);
}
