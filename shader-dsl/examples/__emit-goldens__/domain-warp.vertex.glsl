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
  float warp;
} U;
float hash(vec2 p);
float noise(vec2 p);
float fbm(vec2 p);
float hash(vec2 p) {
  return fract((sin(dot(p, vec2(127.1, 311.7))) * 43758.5453));
}

float noise(vec2 p) {
  vec2 _cse0 = vec2(3.0);
  vec2 _v0 = floor(p);
  vec2 _v1 = fract(p);
  float _lc0 = ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).x;
  return mix(mix(hash(_v0), hash((_v0 + vec2(1.0, 0.0))), _lc0), mix(hash((_v0 + vec2(0.0, 1.0))), hash((_v0 + vec2(1.0, 1.0))), _lc0), ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).y);
}

float fbm(vec2 p) {
  return ((((noise(p) * 0.5) + (noise((p * 2.02)) * 0.25)) + (noise((p * 4.08)) * 0.125)) + (noise((p * 8.2)) * 0.0625));
}
out vec2 uv;

VsOut vs_impl(uint vi) {
  float _cse0 = ((float((vi & 1u)) * 4.0) - 1.0);
  float _cse1 = ((float((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4(_cse0, _cse1, 0.0, 1.0), vec2(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

void main() {
  VsOut _out = vs_impl(uint(gl_VertexID));
  gl_Position = _out.pos;
  uv = _out.uv;
}
