#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
layout(std140) uniform Uniforms {
  float time;
  vec2 resolution;
  vec2 epoch;
  float speed;
  float fp64;
} U;

uniform sampler2D _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_split(float a);
vec2 df64_twoProd(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
vec2 df64_mul(vec2 a, vec2 b);
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
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
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

vec4 fs_clock_impl(VsOut vo) {
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2((U.resolution.x * 0.5), U.resolution.y);
  float _v0 = df64_narrow(df64_fract(df64_mul(df64_add(U.epoch, vec2(U.time, 0.0)), vec2(U.speed, 0.0))));
  float _v1 = fract(((df64_narrow(U.epoch) + U.time) * U.speed));
  bool _v2 = (_cse0 || (U.fp64 < 0.5));
  float _v3 = (_v2 ? _v1 : _v0);
  float _v4 = (vo.uv.x * 2.0);
  float _v5 = (_v4 - (_cse0 ? 0.0 : 1.0));
  vec2 _lc0 = vec2(_v5, vo.uv.y);
  vec2 _v6 = vec2((((_lc0.x * 2.0) - 1.0) * (_cse1.x / _cse1.y)), ((_lc0.y * 2.0) - 1.0));
  float _v7 = length(_v6);
  float _v8 = fract((0.25 - (atan(_v6.y, _v6.x) / 6.283185307179586)));
  float _v9 = (2.0 / U.resolution.y);
  float _v10 = (1.0 - smoothstep((_v9 * 1.5), (_v9 * 3.0), (abs((_v7 - 0.82)) - 0.012)));
  float _v11 = ((-abs((fract((_v8 * 12.0)) - 0.5))) + 0.5);
  float _v12 = (((1.0 - smoothstep(0.0, 0.035, _v11)) * smoothstep(0.62, 0.66, _v7)) * (1.0 - smoothstep(0.78, 0.8, _v7)));
  float _v13 = fract(((_v3 - _v8) + 1.0));
  float _v14 = (((1.0 - smoothstep(0.0, 0.006, min(_v13, (1.0 - _v13)))) * step(_v7, 0.6)) * smoothstep(0.05, 0.1, _v7));
  float _v15 = ((exp((_v13 * -5.0)) * 0.35) * step(_v7, 0.58));
  float _v16 = (1.0 - smoothstep((_v9 * 2.0), (_v9 * 5.0), _v7));
  vec3 _v17 = mix(vec3(0.03, 0.045, 0.08), vec3(0.05, 0.075, 0.12), _v7);
  return vec4((((((_v17 + (vec3(0.85, 0.9, 1.0) * (_v10 * 0.35))) + (vec3(0.8, 0.85, 0.95) * (_v12 * 0.5))) + (vec3(1.0, 0.72, 0.2) * _v14)) + (vec3(1.0, 0.6, 0.15) * _v15)) + (vec3(1.0, 0.85, 0.5) * _v16)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_clock_impl(vo);
}
