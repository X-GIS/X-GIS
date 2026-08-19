#version 300 es
precision highp float;
precision highp int;

out vec2 uv;

void main() {
  uint vi = uint(gl_VertexID);
  float _cse0 = ((float((vi & 1u)) * 4.0) - 1.0);
  float _cse1 = ((float((vi >> 1u)) * 4.0) - 1.0);
  gl_Position = vec4(_cse0, _cse1, 0.0, 1.0);
  uv = vec2(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5));
}
