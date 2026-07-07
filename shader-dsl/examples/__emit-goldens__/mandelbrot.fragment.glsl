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
  float zoom;
  vec4 mouse;
} U;
vec3 palette(float t);
vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _cse4 = (U.resolution.x / U.resolution.y);
  vec2 _cse3 = vec2((((vo.uv.x * 2.0) - 1.0) * _cse4), ((vo.uv.y * 2.0) - 1.0));
  vec2 _cse0 = vec2((U.mouse.x / U.resolution.x), (U.mouse.y / U.resolution.y));
  float _cse1 = _cse3.x;
  float _cse2 = _cse3.y;
  float _v0 = (exp((-(U.zoom + ((sin((U.time * 0.2)) * 0.75) + 0.75)))) * 2.4);
  vec2 _v1 = ((vec2((((_cse0.x * 2.0) - 1.0) * _cse4), ((_cse0.y * 2.0) - 1.0)) * _v0) * U.mouse.w);
  vec2 _v2 = vec2(0.0, 0.0);
  float _v3 = 0.0;
  for (uint _v4 = 0u; (_v4 < 120u); _v4 = (_v4 + 1u)) {
    if ((dot(_v2, _v2) > 16.0)) {
      break;
    }
    vec2 _lc0 = vec2((((_cse1 * _v0) - 0.7453) + _v1.x), (((_cse2 * _v0) + 0.1127) + _v1.y));
    _v2 = vec2((((_v2.x * _v2.x) - (_v2.y * _v2.y)) + _lc0.x), (((_v2.x * _v2.y) * 2.0) + _lc0.y));
    _v3 = (_v3 + 1.0);
  }
  float _v5 = dot(_v2, _v2);
  return vec4((palette(((((_v3 - log2(max(log2(max(_v5, 1.0001)), 0.0001))) + 1.0) * 0.035) + (U.time * 0.02))) * (1.0 - step(119.5, _v3))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
