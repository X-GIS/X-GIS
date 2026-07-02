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
  float sun_az;
  float exaggeration;
} U;
float terrain(vec2 p, float t);
float terrain(vec2 p, float t) {
  return (((((sin(((p.x * 3.0) + t)) * cos((p.y * 3.0))) + ((sin(((p.x * 6.1) - (t * 0.7))) * cos((p.y * 5.3))) * 0.5)) + ((sin((p.x * 12.7)) * cos((p.y * 11.1))) * 0.25)) * 0.28) + 0.5);
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
