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
  float spacing;
} U;
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _cse3 = ((vo.uv.y * 180.0) - 90.0);
  float _cse0 = abs(_cse3);
  float _cse1 = (((vo.uv.x * 360.0) - 180.0) + (U.time * 8.0));
  float _cse2 = fwidth(_cse3);
  return vec4(mix(mix(mix(vec3(0.05, 0.13, 0.24), vec3(0.03, 0.07, 0.14), (_cse0 / 90.0)), vec3(0.55, 0.72, 0.86), clamp(max((1.0 - smoothstep(0.0, (fwidth(_cse1) * 1.5), (abs((fract(((_cse1 / U.spacing) + 0.5)) - 0.5)) * U.spacing))), (1.0 - smoothstep(0.0, (_cse2 * 1.5), (abs((fract(((_cse3 / U.spacing) + 0.5)) - 0.5)) * U.spacing)))), 0.0, 1.0)), vec3(0.96, 0.84, 0.45), clamp((1.0 - smoothstep(0.0, (_cse2 * 3.0), _cse0)), 0.0, 1.0)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
