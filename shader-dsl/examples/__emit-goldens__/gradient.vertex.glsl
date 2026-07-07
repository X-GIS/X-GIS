#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
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
