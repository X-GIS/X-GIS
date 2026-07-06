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
  float swell;
} U;
float hash(vec2 p);
float noise(vec2 p);
float hash(vec2 p) {
  return fract((sin(dot(p, vec2(127.1, 311.7))) * 43758.5453));
}

float noise(vec2 p) {
  vec2 _cse0 = vec2(3.0);
  vec2 _v0 = floor(p);
  vec2 _v1 = fract(p);
  float _lc0 = ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).x;
  return mix(mix(hash(_v0), hash((_v0 + vec2(1.0, 0.0))), _lc0), mix(hash((_v0 + vec2(0.0, 1.0))), hash((_v0 + vec2(1.0, 1.0))), _lc0), ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _licm0 = (U.time * 0.6);
  vec2 _licm1 = vec2((U.time * 0.12), 0.0);
  float _cse0 = (((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y));
  vec3 _cse1 = vec3(1.0, 0.85, 0.6);
  float _v0 = distance(vec2(_cse0, ((vo.uv.y * 2.0) - 1.0)), vec2(0.42, 0.56));
  float _v1 = max((0.58 - vo.uv.y), 0.0008);
  float _v2 = (0.06 / _v1);
  float _av0 = 0.0;
  float _av1 = 1.0;
  float _av2 = 0.5;
  for (uint _v3 = 0u; (_v3 < 4u); _v3 = (_v3 + 1u)) {
    _av0 = (_av0 + (_av2 * noise((((vec2(((_cse0 * _v2) * 0.6), (_v2 + _licm0)) * 3.0) * _av1) + _licm1))));
    _av1 = (_av1 * 2.03);
    _av2 = (_av2 * 0.5);
  }
  float _lc0 = ((_av0 * U.swell) * smoothstep(0.0, 0.05, _v1));
  return vec4(mix(((mix(vec3(0.05, 0.18, 0.28), vec3(0.55, 0.5, 0.45), exp((-(_v1 * 7.0)))) + (vec3(0.3, 0.38, 0.36) * _lc0)) + (_cse1 * clamp(((pow((max((_lc0 - 0.32), 0.0) * 2.6), 3.0) * exp((-(abs((_cse0 - 0.42)) * 2.2)))) * exp((-(_v1 * 2.5)))), 0.0, 1.2))), (mix(vec3(0.83, 0.58, 0.38), vec3(0.12, 0.28, 0.48), smoothstep(0.58, 1.0, vo.uv.y)) + (_cse1 * ((1.0 - smoothstep(0.035, 0.06, _v0)) + (exp((-(_v0 * 4.0))) * 0.35)))), step(0.58, vo.uv.y)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
