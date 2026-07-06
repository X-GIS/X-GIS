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
  float tiles;
} U;
float hash(vec2 p);
vec3 palette(float t);
float hash(vec2 p) {
  return fract((sin(dot(p, vec2(127.1, 311.7))) * 43758.5453));
}

vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse0 = (vec2((vo.uv.x * (U.resolution.x / U.resolution.y)), vo.uv.y) * U.tiles);
  vec2 _cse1 = vec2(1.0, 1.0);
  vec2 _v0 = floor(_cse0);
  vec2 _v1 = fract(_cse0);
  float _v2 = hash(_v0);
  vec2 _v3 = vec2(mix(_v1.x, (1.0 - _v1.x), step(0.5, _v2)), _v1.y);
  float _v4 = min(abs((length(_v3) - 0.5)), abs((length((_v3 - _cse1)) - 0.5)));
  float _v5 = (fwidth(_v4) * 1.4);
  return vec4(mix(vec3(0.04, 0.05, 0.09), (palette(((hash((_v0 + vec2(7.7, 3.1))) * 0.4) + (U.time * 0.05))) * ((sin(((mix(atan((_v3.y - 1.0), (_v3.x - 1.0)), atan(_v3.y, _v3.x), step(abs((length(_v3) - 0.5)), abs((length((_v3 - _cse1)) - 0.5)))) * 6.0) + (U.time * 2.5))) * 0.35) + 0.65)), (1.0 - smoothstep((0.13 - _v5), (0.13 + _v5), _v4))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
