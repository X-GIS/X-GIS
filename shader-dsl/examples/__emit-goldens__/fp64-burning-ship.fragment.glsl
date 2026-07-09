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
bool df64_le(vec2 a, vec2 b);
vec2 df64_abs(vec2 a);
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

bool df64_le(vec2 a, vec2 b) {
  return ((a.x < b.x) || ((a.x == b.x) && (a.y <= b.y)));
}

vec2 df64_abs(vec2 a) {
  return ((a.x < 0.0) ? (-a) : a);
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_ship_impl(VsOut vo) {
  vec2 _licm0 = vec2(16.0, 0.0);
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
  float _v6 = 0.0;
  if ((_cse0 || (u.fp64 < 0.5))) {
    float _v7 = (df64_narrow(_cse1) + _v3);
    float _v8 = (df64_narrow(_cse2) + _v4);
    float _v9 = 0.0;
    float _v10 = 0.0;
    for (uint _v11 = 0u; (_v11 < 128u); _v11 = (_v11 + 1u)) {
      if ((((_v9 * _v9) + (_v10 * _v10)) <= 16.0)) {
        float _v12 = (((_v9 * _v9) - (_v10 * _v10)) + _v7);
        _v10 = ((abs((_v9 * _v10)) * 2.0) + _v8);
        _v9 = _v12;
        _v5 = (_v5 + 1.0);
      }
    }
    _v6 = ((_v9 * _v9) + (_v10 * _v10));
  } else {
    vec2 _v13 = df64_add(_cse1, vec2(_v3, 0.0));
    vec2 _v14 = df64_add(_cse2, vec2(_v4, 0.0));
    vec2 _v15 = _cse3;
    vec2 _v16 = _cse3;
    for (uint _v17 = 0u; (_v17 < 128u); _v17 = (_v17 + 1u)) {
      if (df64_le(df64_add(df64_mul(_v15, _v15), df64_mul(_v16, _v16)), _licm0)) {
        vec2 _v18 = df64_add(df64_sub(df64_mul(_v15, _v15), df64_mul(_v16, _v16)), _v13);
        _v16 = df64_add(df64_mul(df64_abs(df64_mul(_v15, _v16)), _licm1), _v14);
        _v15 = _v18;
        _v5 = (_v5 + 1.0);
      }
    }
    _v6 = df64_narrow(df64_add(df64_mul(_v15, _v15), df64_mul(_v16, _v16)));
  }
  float _v19 = ((_v5 - log2(max(log2(max(_v6, 1.0001)), 0.0001))) + 1.0);
  float _v20 = step(127.5, _v5);
  float _v21 = (_v19 / 128.0);
  float _v22 = ((_v21 * _v21) * (3.0 - (_v21 * 2.0)));
  return vec4((mix(mix(vec3(0.06, 0.02, 0.05), vec3(0.95, 0.45, 0.08), _v22), vec3(1.0, 0.93, 0.75), (_v21 * _v21)) * (1.0 - _v20)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_ship_impl(vo);
}
