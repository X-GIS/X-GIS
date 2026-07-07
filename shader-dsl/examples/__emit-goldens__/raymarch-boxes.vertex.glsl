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
  float speed;
  vec4 mouse;
} U;
float scene(vec3 p);
vec3 palette(float t);
float scene(vec3 p) {
  vec3 _v0 = (mod(p, 2.6) - vec3(1.3));
  return (length(max((abs(_v0) - vec3(0.62)), vec3(0.0, 0.0, 0.0))) - 0.14);
}

vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
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
