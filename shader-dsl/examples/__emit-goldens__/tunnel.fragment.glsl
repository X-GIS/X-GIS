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
  float twist;
} U;
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse0 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _v0 = length(_cse0);
  float _v1 = ((0.3 / max(_v0, 0.001)) + (U.time * 1.4));
  return vec4((((mix(vec3(1.0, 0.62, 0.28), vec3(0.42, 0.3, 0.55), ((sin((_v1 * 0.9)) * 0.5) + 0.5)) * ((smoothstep(-0.6, 0.6, (sin((((atan(_cse0.y, _cse0.x) / 3.14159265) + ((_v1 * U.twist) * 0.08)) * 12.566)) * sin((_v1 * 9.4248)))) * 0.55) + 0.35)) * smoothstep(0.0, 0.55, _v0)) * clamp((1.15 - (_v0 * 0.35)), 0.0, 1.0)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
