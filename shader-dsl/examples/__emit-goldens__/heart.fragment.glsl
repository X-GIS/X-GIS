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
  float beat;
} U;
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse0 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _v0 = (pow(abs(sin(((U.time * 3.14159) * U.beat))), 8.0) * 0.12);
  float _v1 = (0.72 + _v0);
  float _v2 = ((_cse0.x * 1.3) / _v1);
  float _v3 = (((_cse0.y + 0.08) * 1.3) / _v1);
  float _v4 = (_v2 * _v2);
  float _v5 = ((_v4 + (_v3 * _v3)) - 1.0);
  float _v6 = (((_v5 * _v5) * _v5) - (((_v4 * _v3) * _v3) * _v3));
  float _v7 = (fwidth(_v6) * 1.6);
  return vec4(mix(((vec3(0.05, 0.04, 0.07) * (1.0 - (vo.uv.y * 0.35))) + (vec3(0.7, 0.08, 0.16) * (exp((-(max(_v6, 0.0) * 2.2))) * ((_v0 * 3.0) + 0.35)))), mix(vec3(0.55, 0.03, 0.1), vec3(0.95, 0.15, 0.25), clamp((-_v6), 0.0, 1.0)), (1.0 - smoothstep((-_v7), _v7, _v6))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
