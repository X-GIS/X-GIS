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

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_de_impl(VsOut vo) {
  vec2 _licm0 = vec2(2.0, 0.0);
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
  float _v6 = 1.0;
  if ((_cse0 || (u.fp64 < 0.5))) {
    float _v7 = (df64_narrow(_cse1) + _v3);
    float _v8 = (df64_narrow(_cse2) + _v4);
    float _v9 = 0.0;
    float _v10 = 0.0;
    float _v11 = 0.0;
    float _v12 = 0.0;
    for (uint _v13 = 0u; (_v13 < 160u); _v13 = (_v13 + 1u)) {
      if ((((_v9 * _v9) + (_v10 * _v10)) <= 1000000.0)) {
        float _v14 = ((((_v9 * _v11) - (_v10 * _v12)) * 2.0) + 1.0);
        _v12 = (((_v9 * _v12) + (_v10 * _v11)) * 2.0);
        _v11 = _v14;
        float _v15 = (((_v9 * _v9) - (_v10 * _v10)) + _v7);
        _v10 = (((_v9 * _v10) * 2.0) + _v8);
        _v9 = _v15;
      }
    }
    _v5 = ((_v9 * _v9) + (_v10 * _v10));
    _v6 = ((_v11 * _v11) + (_v12 * _v12));
  } else {
    vec2 _v16 = df64_add(_cse1, vec2(_v3, 0.0));
    vec2 _v17 = df64_add(_cse2, vec2(_v4, 0.0));
    vec2 _v18 = _cse3;
    vec2 _v19 = _cse3;
    float _v20 = 0.0;
    float _v21 = 0.0;
    for (uint _v22 = 0u; (_v22 < 160u); _v22 = (_v22 + 1u)) {
      if ((df64_narrow(df64_add(df64_mul(_v18, _v18), df64_mul(_v19, _v19))) <= 1000000.0)) {
        float _v23 = df64_narrow(_v18);
        float _v24 = df64_narrow(_v19);
        float _v25 = ((((_v23 * _v20) - (_v24 * _v21)) * 2.0) + 1.0);
        _v21 = (((_v23 * _v21) + (_v24 * _v20)) * 2.0);
        _v20 = _v25;
        vec2 _v26 = df64_add(df64_sub(df64_mul(_v18, _v18), df64_mul(_v19, _v19)), _v16);
        _v19 = df64_add(df64_mul(df64_mul(_v18, _v19), _licm0), _v17);
        _v18 = _v26;
      }
    }
    _v5 = df64_narrow(df64_add(df64_mul(_v18, _v18), df64_mul(_v19, _v19)));
    _v6 = ((_v20 * _v20) + (_v21 * _v21));
  }
  float _v27 = sqrt(max(_v5, 1.0));
  float _v28 = (((_v27 * log(_v27)) * 0.5) / sqrt(max(_v6, 1e-30)));
  float _v29 = min((_v28 / (_v0 * 0.012)), 40.0);
  float _v30 = ((_v5 > 1000000.0) ? 1.0 : 0.0);
  float _v31 = (exp(((-_v29) * 1.2)) * _v30);
  float _v32 = (exp(((-_v29) * 0.25)) * _v30);
  return vec4(((vec3(0.02, 0.03, 0.08) + (vec3(0.12, 0.2, 0.42) * _v32)) + (vec3(1.0, 0.85, 0.45) * _v31)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_de_impl(vo);
}
