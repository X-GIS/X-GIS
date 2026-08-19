#version 300 es
precision highp float;
precision highp int;

out vec2 uv;

void main() {
  uint idx = uint(gl_VertexID);
  vec2 _av0 = vec2(-1.0, -1.0);
  if ((idx == 1u)) {
    _av0 = vec2(3.0, -1.0);
  } else if ((idx == 2u)) {
    _av0 = vec2(-1.0, 3.0);
  }
  gl_Position = vec4(_av0, 0.0, 1.0);
  uv = vec2(((_av0.x + 1.0) * 0.5), ((_av0.y + 1.0) * 0.5));
}
