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
  float fp64;
} u;

uniform sampler2D _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_split(float a);
vec2 df64_twoProd(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
vec2 df64_mul(vec2 a, vec2 b);
vec2 df64_div(vec2 a, vec2 b);
float df64_narrow(vec2 a);
vec2 df64_twoSum(float a, float b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (a + b);
  float _v1 = (((_v0 * _cse0) - a) * _cse0);
  float _v2 = (((((a - ((_v0 - _v1) * _cse0)) * _cse0) * _cse0) * _cse0) + (b - _v1));
  return vec2(_v0, _v2);
}

vec2 df64_quickTwoSum(float a, float b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = ((a + b) * _cse0);
  float _v1 = (b - ((_v0 - a) * _cse0));
  return vec2(_v0, _v1);
}

vec2 df64_split(float a) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (a * (_cse0 * 4097.0));
  float _v1 = ((_v0 * _cse0) - (_v0 - a));
  float _v2 = ((a * _cse0) - _v1);
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

vec2 df64_div(vec2 a, vec2 b) {
  float _v0 = (texelFetch(_fp64, ivec2(0, 0), 0).x / b.x);
  vec2 _v1 = (a * _v0);
  float _v2 = df64_sub(a, df64_mul(b, _v1)).x;
  vec2 _v3 = df64_twoProd(_v0, _v2);
  return df64_add(_v1, _v3);
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_newton_impl(VsOut vo) {
  vec2 _licm0 = vec2(2.0, 0.0);
  vec2 _licm1 = vec2(0.0, 0.0);
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(u.center.hi.x, u.center.lo.x);
  vec2 _cse2 = vec2(u.center.hi.y, u.center.lo.y);
  vec2 _cse3 = df64_add(vec2(1.0, 0.0), _licm1);
  vec2 _cse4 = vec2(3.0, 0.0);
  float _v0 = pow(10.0, (-u.zoom_exp));
  float _v1 = (vo.uv.x * 2.0);
  float _v2 = (_v1 - (_cse0 ? 0.0 : 1.0));
  float _v3 = ((_v2 - 0.5) * _v0);
  float _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  float _v5 = 0.0;
  float _v6 = 0.0;
  float _v7 = 0.0;
  if ((_cse0 || (u.fp64 < 0.5))) {
    float _v8 = (df64_narrow(_cse1) + _v3);
    float _v9 = (df64_narrow(_cse2) + _v4);
    for (uint _v10 = 0u; (_v10 < 48u); _v10 = (_v10 + 1u)) {
      float _v11 = ((_v8 * _v8) - (_v9 * _v9));
      float _v12 = ((_v8 * _v9) * 2.0);
      float _v13 = (((_v11 * _v8) - (_v12 * _v9)) - 1.0);
      float _v14 = ((_v11 * _v9) + (_v12 * _v8));
      float _v15 = (_v11 * 3.0);
      float _v16 = (_v12 * 3.0);
      float _v17 = (1.0 / ((_v15 * _v15) + (_v16 * _v16)));
      float _v18 = (((_v13 * _v15) + (_v14 * _v16)) * _v17);
      float _v19 = (((_v14 * _v15) - (_v13 * _v16)) * _v17);
      _v8 = (_v8 - _v18);
      _v9 = (_v9 - _v19);
      if ((((_v18 * _v18) + (_v19 * _v19)) > 1e-14)) {
        _v7 = (_v7 + 1.0);
      }
    }
    _v5 = _v8;
    _v6 = _v9;
  } else {
    vec2 _v20 = df64_add(_cse1, vec2(_v3, 0.0));
    vec2 _v21 = df64_add(_cse2, vec2(_v4, 0.0));
    for (uint _v22 = 0u; (_v22 < 48u); _v22 = (_v22 + 1u)) {
      vec2 _v23 = df64_sub(df64_mul(_v20, _v20), df64_mul(_v21, _v21));
      vec2 _v24 = df64_mul(df64_mul(_v20, _v21), _licm0);
      vec2 _v25 = df64_sub(df64_sub(df64_mul(_v23, _v20), df64_mul(_v24, _v21)), _cse3);
      vec2 _v26 = df64_add(df64_mul(_v23, _v21), df64_mul(_v24, _v20));
      vec2 _v27 = df64_mul(_v23, _cse4);
      vec2 _v28 = df64_mul(_v24, _cse4);
      vec2 _v29 = df64_div(_cse3, df64_add(df64_mul(_v27, _v27), df64_mul(_v28, _v28)));
      vec2 _v30 = df64_mul(df64_add(df64_mul(_v25, _v27), df64_mul(_v26, _v28)), _v29);
      vec2 _v31 = df64_mul(df64_sub(df64_mul(_v26, _v27), df64_mul(_v25, _v28)), _v29);
      _v20 = df64_sub(df64_add(_v20, _licm1), df64_add(_v30, _licm1));
      _v21 = df64_sub(df64_add(_v21, _licm1), df64_add(_v31, _licm1));
      if ((df64_narrow(df64_add(df64_mul(_v30, _v30), df64_mul(_v31, _v31))) > 1e-14)) {
        _v7 = (_v7 + 1.0);
      }
    }
    _v5 = df64_narrow(_v20);
    _v6 = df64_narrow(_v21);
  }
  float _lc0 = (_v5 - 1.0);
  float _v32 = ((_lc0 * _lc0) + (_v6 * _v6));
  float _lc1 = (_v5 + 0.5);
  float _lc2 = (_v6 - 0.8660254037844386);
  float _v33 = ((_lc1 * _lc1) + (_lc2 * _lc2));
  float _lc3 = (_v5 + 0.5);
  float _lc4 = (_v6 + 0.8660254037844386);
  float _v34 = ((_lc3 * _lc3) + (_lc4 * _lc4));
  vec3 _v35 = (((_v32 <= _v33) && (_v32 <= _v34)) ? vec3(0.91, 0.34, 0.22) : ((_v33 <= _v34) ? vec3(0.2, 0.66, 0.88) : vec3(0.98, 0.78, 0.22)));
  float _v36 = (1.0 - (_v7 / 48.0));
  return vec4((_v35 * mix(0.25, 1.0, _v36)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_newton_impl(vo);
}
