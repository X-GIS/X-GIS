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
