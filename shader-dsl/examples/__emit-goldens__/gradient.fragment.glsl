#version 300 es
precision highp float;
precision highp int;

layout(std140) uniform Uniforms {
  vec4 top;
  vec4 bottom;
  float mix_bias;
} u;
in vec2 uv;
layout(location = 0) out vec4 _ret;

void main() {
  _ret = vec4(mix(u.bottom.rgb, u.top.rgb, (uv.y + u.mix_bias)), 1.0);
}
