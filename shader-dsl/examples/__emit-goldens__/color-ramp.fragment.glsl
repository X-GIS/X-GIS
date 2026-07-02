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
  float bands;
} U;
vec3 ramp(float x);
vec3 ramp(float x) {
  return mix(mix(mix(mix(vec3(0.99, 0.95, 0.74), vec3(0.99, 0.8, 0.45), smoothstep(0.0, 0.25, x)), vec3(0.96, 0.5, 0.24), smoothstep(0.25, 0.5, x)), vec3(0.84, 0.19, 0.15), smoothstep(0.5, 0.75, x)), vec3(0.5, 0.0, 0.05), smoothstep(0.75, 1.0, x));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _cse3 = clamp((((sin(((vo.uv.x * 6.2832) + (U.time * 0.5))) * 0.3) + 0.5) + (sin(((vo.uv.y * 6.2832) - (U.time * 0.35))) * 0.2)), 0.0, 1.0);
  float _cse2 = (_cse3 * U.bands);
  vec3 _cse0 = ramp(_cse3);
  float _cse1 = fract(_cse2);
  return vec4(mix(_cse0, (_cse0 * 0.2), clamp(((1.0 - smoothstep(0.0, (fwidth(_cse2) * 1.2), min(_cse1, (1.0 - _cse1)))) * smoothstep(0.5, 1.5, U.bands)), 0.0, 1.0)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
