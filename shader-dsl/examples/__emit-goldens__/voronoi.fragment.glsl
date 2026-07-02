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
  float cells;
} U;
vec2 hash2(vec2 c);
vec2 hash2(vec2 c) {
  vec2 _cse0 = vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)));
  return fract((vec2(sin(_cse0.x), sin(_cse0.y)) * 43758.5453));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  float _licm0 = U.time;
  vec2 _cse0 = (vo.uv * U.cells);
  float _av0 = 8.0;
  for (int _v0 = -1; (_v0 <= 1); _v0 = (_v0 + 1)) {
    for (int _v1 = -1; (_v1 <= 1); _v1 = (_v1 + 1)) {
      vec2 _v2 = vec2(float(_v1), float(_v0));
      vec2 _v3 = hash2((floor(_cse0) + _v2));
      _av0 = min(_av0, distance(fract(_cse0), ((_v2 + ((_v3 * 0.5) + 0.25)) + (vec2(sin((_licm0 + (_v3.x * 6.283))), cos((_licm0 + (_v3.y * 6.283)))) * 0.18))));
    }
  }
  return vec4(((vec3((_av0 * _av0)) * vec3(0.35, 0.6, 1.0)) + vec3(0.02, 0.03, 0.06)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
