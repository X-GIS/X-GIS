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
  float count;
} U;
vec3 palette(float t);
vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _licm0 = U.count;
  vec2 _licm1 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _licm2 = U.time;
  float _cse0 = (_licm2 * 0.03);
  float _v0 = 0.0;
  float _v1 = 0.0;
  for (uint _v2 = 0u; (float(_v2) < _licm0); _v2 = (_v2 + 1u)) {
    float _lc0 = float(_v2);
    vec2 _v3 = (_licm1 - vec2((sin(((_licm2 * ((_lc0 * 0.13) + 0.5)) + (_lc0 * 2.4))) * 0.55), (cos(((_licm2 * ((_lc0 * 0.11) + 0.4)) + (_lc0 * 1.7))) * 0.42)));
    float _v4 = (0.055 / (dot(_v3, _v3) + 0.003));
    _v0 = (_v0 + _v4);
    _v1 = (_v1 + (_v4 * float(_v2)));
  }
  vec3 _lc1 = palette((((_v1 / max(_v0, 0.0001)) * 0.15) + _cse0));
  return vec4(mix((vec3(0.03, 0.04, 0.08) + (_lc1 * (_v0 * 0.08))), _lc1, smoothstep(0.95, 1.15, _v0)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
