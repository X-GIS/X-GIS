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
out vec2 uv;

VsOut vs_full_impl(uint idx) {
  vec2 _av0 = vec2(-1.0, -1.0);
  if ((idx == 1u)) {
    _av0 = vec2(3.0, -1.0);
  } else if ((idx == 2u)) {
    _av0 = vec2(-1.0, 3.0);
  }
  return VsOut(vec4(_av0, 0.0, 1.0), vec2(((_av0.x + 1.0) * 0.5), ((_av0.y + 1.0) * 0.5)));
}

void main() {
  VsOut _out = vs_full_impl(uint(gl_VertexID));
  gl_Position = _out.pos;
  uv = _out.uv;
}
