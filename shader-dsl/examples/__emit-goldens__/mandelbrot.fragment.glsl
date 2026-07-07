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
} U;
vec3 palette(float t);
vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse2 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _cse0 = _cse2.x;
  float _cse1 = _cse2.y;
  float _v0 = (exp((-(U.zoom + ((sin((U.time * 0.2)) * 0.75) + 0.75)))) * 2.4);
  vec2 _v1 = vec2(0.0, 0.0);
  float _v2 = 0.0;
  for (uint _v3 = 0u; (_v3 < 120u); _v3 = (_v3 + 1u)) {
    if ((dot(_v1, _v1) > 16.0)) {
      break;
    }
    vec2 _lc0 = vec2(((_cse0 * _v0) - 0.7453), ((_cse1 * _v0) + 0.1127));
    _v1 = vec2((((_v1.x * _v1.x) - (_v1.y * _v1.y)) + _lc0.x), (((_v1.x * _v1.y) * 2.0) + _lc0.y));
    _v2 = (_v2 + 1.0);
  }
  float _v4 = dot(_v1, _v1);
  return vec4((palette(((((_v2 - log2(max(log2(max(_v4, 1.0001)), 0.0001))) + 1.0) * 0.035) + (U.time * 0.02))) * (1.0 - step(119.5, _v2))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
