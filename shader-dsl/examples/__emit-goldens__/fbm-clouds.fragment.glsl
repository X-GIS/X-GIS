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
  float octaves;
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
  float _licm0 = U.octaves;
  vec2 _licm1 = vec2((U.time * 0.08), 0.0);
  float _av0 = 0.0;
  vec2 _av1 = vec2((vo.uv.x * 3.0), (vo.uv.y * 3.0));
  float _av2 = 0.55;
  for (uint _v0 = 0u; (float(_v0) < _licm0); _v0 = (_v0 + 1u)) {
    _av0 = (_av0 + (_av2 * noise((_av1 + _licm1))));
    _av1 = (_av1 * 2.02);
    _av2 = (_av2 * 0.5);
  }
  return vec4(mix(vec3(0.2, 0.42, 0.72), vec3(0.97, 0.97, 1.0), clamp(_av0, 0.0, 1.0)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
