#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
layout(std140) uniform Uniforms {
  vec4 top;
  vec4 bottom;
  float mix_bias;
} u;
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_gradient_impl(VsOut vo) {
  return vec4(mix(u.bottom.rgb, u.top.rgb, (vo.uv.y + u.mix_bias)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_gradient_impl(vo);
}
