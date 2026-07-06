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
  float density;
} U;
float hash(vec2 p);
float hash(vec2 p) {
  return fract((sin(dot(p, vec2(127.1, 311.7))) * 43758.5453));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse2 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _licm0 = U.time;
  vec2 _licm1 = vec2(12.3, 45.6);
  vec2 _licm2 = vec2(78.9, 1.2);
  vec3 _licm3 = vec3(0.75, 0.85, 1.0);
  vec3 _licm4 = vec3(1.0, 0.9, 0.75);
  float _licm5 = (0.92 - (U.density * 0.25));
  float _cse0 = _cse2.x;
  float _cse1 = _cse2.y;
  vec3 _v0 = vec3(0.0, 0.0, 0.0);
  for (uint _v1 = 0u; (_v1 < 3u); _v1 = (_v1 + 1u)) {
    float _lc0 = float(_v1);
    vec2 _v2 = floor(((vec2((_cse0 + (_licm0 * ((_lc0 * 0.014) + 0.01))), _cse1) * ((_lc0 * 14.0) + 18.0)) + (_lc0 * 37.7)));
    float _v3 = hash(_v2);
    float _lc1 = float(_v1);
    float _v4 = (1.0 - smoothstep(0.0, (0.06 - (_lc1 * 0.012)), distance(fract(((vec2((_cse0 + (_licm0 * ((_lc1 * 0.014) + 0.01))), _cse1) * ((_lc1 * 14.0) + 18.0)) + (_lc1 * 37.7))), ((vec2(hash((_v2 + _licm1)), hash((_v2 + _licm2))) * 0.7) + 0.15))));
    _v0 = (_v0 + (mix(_licm3, _licm4, _v3) * ((((_v4 * _v4) * ((sin(((_licm0 * ((_v3 * 4.0) + 2.0)) + (_v3 * 40.0))) * 0.4) + 0.6)) * step(_licm5, _v3)) * (1.0 - (float(_v1) * 0.25)))));
  }
  float _v5 = (_cse1 + (_cse0 * 0.35));
  return vec4((_v0 + (vec3(0.09, 0.11, 0.16) * exp((-((_v5 * _v5) * 6.0))))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
