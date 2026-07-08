#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
layout(std140) uniform Uniforms {
  vec2 origin;
  float span;
  float fp64;
} u;

uniform sampler2D _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
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

vec2 df64_add(vec2 a, vec2 b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  vec2 _v0 = vec2((a.x * _cse0), (a.y * _cse0));
  vec2 _v1 = vec2((b.x * _cse0), (b.y * _cse0));
  vec2 _v2 = df64_twoSum(_v0.x, _v1.x);
  vec2 _v3 = df64_twoSum(_v0.y, _v1.y);
  _v2.y = (_v2.y + _v3.x);
  _v2 = df64_quickTwoSum(_v2.x, _v2.y);
  _v2.y = (_v2.y + _v3.y);
  _v2 = df64_quickTwoSum(_v2.x, _v2.y);
  return _v2;
}

vec2 df64_sub(vec2 a, vec2 b) {
  return df64_add(a, (-b));
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

vec4 fs_stripes_impl(VsOut vo) {
  float _cse1 = (vo.uv.x * u.span);
  float _cse0 = (((vo.uv.x < 0.5) || (u.fp64 < 0.5)) ? fract((df64_narrow(u.origin) + _cse1)) : df64_narrow(df64_fract(df64_add(u.origin, vec2(_cse1, 0.0)))));
  return vec4(_cse0, _cse0, _cse0, 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_stripes_impl(vo);
}
