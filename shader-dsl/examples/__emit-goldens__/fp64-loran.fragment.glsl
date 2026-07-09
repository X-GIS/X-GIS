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
vec2 df64_twoSqr(float a);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
vec2 df64_mul(vec2 a, vec2 b);
vec2 df64_sqrt(vec2 a);
vec2 df64_floor(vec2 a);
vec2 df64_fract(vec2 a);
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

vec2 df64_twoSqr(float a) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (a * a);
  vec2 _v1 = df64_split(a);
  float _v2 = (((((_v1.x * _v1.x) - _v0) * _cse0) + ((((_v1.x * _v1.y) * 2.0) * _cse0) * _cse0)) + ((((_v1.y * _v1.y) * _cse0) * _cse0) * _cse0));
  return vec2(_v0, _v2);
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

vec2 df64_sqrt(vec2 a) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (_cse0 / sqrt(a.x));
  float _v1 = (a.x * _v0);
  vec2 _v2 = (df64_twoSqr(_v1) * _cse0);
  float _v3 = df64_sub(a, _v2).x;
  vec2 _v4 = df64_twoProd((_v0 * 0.5), _v3);
  vec2 _v5 = df64_add(vec2(_v1, 0.0), _v4);
  return ((a.x == 0.0) ? vec2(0.0, 0.0) : _v5);
}

vec2 df64_floor(vec2 a) {
  float _v0 = floor(a.x);
  return ((_v0 == a.x) ? df64_quickTwoSum(_v0, floor(a.y)) : vec2(_v0, 0.0));
}

vec2 df64_fract(vec2 a) {
  return df64_sub(a, df64_floor(a));
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_loran_impl(VsOut vo) {
  vec2 _cse14 = vec2(12000000.0, 0.0);
  vec2 _cse15 = vec2(34000000.0, 0.0);
  vec2 _cse16 = vec2(19000000.0, 0.0);
  vec2 _cse17 = vec2(26000000.0, 0.0);
  DF64Vec2 _cse12 = DF64Vec2(vec2(_cse14.x, _cse15.x), vec2(_cse14.y, _cse15.y));
  DF64Vec2 _cse13 = DF64Vec2(vec2(_cse16.x, _cse17.x), vec2(_cse16.y, _cse17.y));
  vec2 _cse8 = _cse12.hi;
  vec2 _cse9 = _cse12.lo;
  vec2 _cse10 = _cse13.hi;
  vec2 _cse11 = _cse13.lo;
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(u.center.hi.x, u.center.lo.x);
  vec2 _cse2 = vec2(u.center.hi.y, u.center.lo.y);
  vec2 _cse3 = vec2(_cse8.x, _cse9.x);
  vec2 _cse4 = vec2(_cse8.y, _cse9.y);
  vec2 _cse5 = vec2(_cse10.x, _cse11.x);
  vec2 _cse6 = vec2(_cse10.y, _cse11.y);
  vec2 _cse7 = vec2(0.0, 0.0);
  float _v0 = pow(10.0, (-u.zoom_exp));
  float _v1 = (vo.uv.x * 2.0);
  float _v2 = (_v1 - (_cse0 ? 0.0 : 1.0));
  float _v3 = ((_v2 - 0.5) * _v0);
  float _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  bool _v5 = (_cse0 || (u.fp64 < 0.5));
  vec2 _lc0 = df64_add(_cse1, vec2(_v3, 0.0));
  vec2 _lc1 = df64_add(_cse2, vec2(_v4, 0.0));
  DF64Vec2 _v6 = DF64Vec2(vec2(_lc0.x, _lc1.x), vec2(_lc0.y, _lc1.y));
  vec2 _lc2 = df64_sub(vec2(_v6.hi.x, _v6.lo.x), _cse3);
  vec2 _lc3 = df64_sub(vec2(_v6.hi.y, _v6.lo.y), _cse4);
  vec2 _v7 = df64_sqrt(df64_add(df64_mul(_lc2, _lc2), df64_mul(_lc3, _lc3)));
  vec2 _lc4 = df64_sub(vec2(_v6.hi.x, _v6.lo.x), _cse5);
  vec2 _lc5 = df64_sub(vec2(_v6.hi.y, _v6.lo.y), _cse6);
  vec2 _v8 = df64_sqrt(df64_add(df64_mul(_lc4, _lc4), df64_mul(_lc5, _lc5)));
  float _v9 = df64_narrow(df64_fract(df64_mul(df64_sub(df64_add(_v7, _cse7), df64_add(_v8, _cse7)), vec2(0.25, 0.0))));
  float _v10 = df64_narrow(df64_fract(df64_mul(df64_add(_v7, _v8), vec2(0.0625, 0.0))));
  vec2 _v11 = vec2((df64_narrow(_cse1) + _v3), (df64_narrow(_cse2) + _v4));
  float _v12 = length((_v11 - vec2(12000000.0, 34000000.0)));
  float _v13 = length((_v11 - vec2(19000000.0, 26000000.0)));
  float _v14 = fract(((_v12 - _v13) * 0.25));
  float _v15 = fract(((_v12 + _v13) * 0.0625));
  float _v16 = (_v5 ? _v14 : _v9);
  float _v17 = (_v5 ? _v15 : _v10);
  float _v18 = min(_v16, (1.0 - _v16));
  float _v19 = min(_v17, (1.0 - _v17));
  float _v20 = ((fwidth(_v18) * 1.2) + 0.0001);
  float _v21 = ((fwidth(_v19) * 1.2) + 0.0001);
  float _v22 = (1.0 - smoothstep(0.0, _v20, _v18));
  float _v23 = (1.0 - smoothstep(0.0, _v21, _v19));
  vec3 _v24 = mix(vec3(0.02, 0.07, 0.13), vec3(0.04, 0.12, 0.2), vo.uv.y);
  return vec4((((_v24 + (vec3(0.0, 0.06, 0.08) * _v16)) + (vec3(0.25, 0.95, 0.95) * (_v22 * 0.9))) + (vec3(0.95, 0.7, 0.25) * (_v23 * 0.35))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_loran_impl(vo);
}
