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
  float segments;
} U;
float hash(vec2 p);
float noise(vec2 p);
float fbm(vec2 p);
vec3 palette(float t);
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

float fbm(vec2 p) {
  return ((((noise(p) * 0.5) + (noise((p * 2.02)) * 0.25)) + (noise((p * 4.08)) * 0.125)) + (noise((p * 8.2)) * 0.0625));
}

vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse0 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  float _v0 = length(_cse0);
  float _v1 = atan(_cse0.y, _cse0.x);
  float _v2 = (6.2831853 / U.segments);
  float _v3 = abs((mod(_v1, _v2) - (_v2 * 0.5)));
  float _v4 = fbm((((vec2(cos(_v3), sin(_v3)) * _v0) * 3.0) + vec2((U.time * 0.12), (-(U.time * 0.09)))));
  return vec4(((palette(((((_v4 * 0.7) + (((sin(((_v0 * 9.0) - (U.time * 0.8))) * 0.5) + 0.5) * 0.15)) + (_v0 * 0.3)) - (U.time * 0.03))) * ((_v4 * 0.9) + 0.35)) * (1.0 - smoothstep(0.55, 1.25, _v0))), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
