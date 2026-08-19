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
} U;
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _cse0 = ((sin(((vo.uv.x * 10.0) + U.time)) + sin(((vo.uv.y * 10.0) + U.time))) + sin((((vo.uv.x + vo.uv.y) * 10.0) + (U.time * 0.7))));
  return vec4(((vec3(sin(_cse0), sin((_cse0 + 2.094)), sin((_cse0 + 4.188))) * 0.5) + 0.5), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
