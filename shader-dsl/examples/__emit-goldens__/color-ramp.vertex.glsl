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
  float bands;
} U;
vec3 ramp(float x);
vec3 ramp(float x) {
  return mix(mix(mix(mix(vec3(0.99, 0.95, 0.74), vec3(0.99, 0.8, 0.45), smoothstep(0.0, 0.25, x)), vec3(0.96, 0.5, 0.24), smoothstep(0.25, 0.5, x)), vec3(0.84, 0.19, 0.15), smoothstep(0.5, 0.75, x)), vec3(0.5, 0.0, 0.05), smoothstep(0.75, 1.0, x));
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
