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
  float cells;
} U;
vec2 hash2(vec2 c);
vec2 hash2(vec2 c) {
  vec2 _cse0 = vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)));
  return fract((vec2(sin(_cse0.x), sin(_cse0.y)) * 43758.5453));
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
