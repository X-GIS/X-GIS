#version 300 es
precision highp float;
precision highp int;

layout(std140) uniform Uniforms {
  float time;
  vec2 resolution;
  float warp;
} U;
float hash(vec2 p) {
  return fract((sin(dot(p, vec2(127.1, 311.7))) * 43758.5453));
}

float noise(vec2 p) {
  vec2 _v0 = floor(p);
  vec2 _v1 = fract(p);
  vec2 _cse0 = vec2(3.0);
  vec2 _gv0 = ((_v1 * _v1) * (_cse0 - (_v1 * 2.0)));
  float _lc0 = _gv0.x;
  return mix(mix(hash(_v0), hash((_v0 + vec2(1.0, 0.0))), _lc0), mix(hash((_v0 + vec2(0.0, 1.0))), hash((_v0 + vec2(1.0, 1.0))), _lc0), _gv0.y);
}

float fbm(vec2 p) {
  return ((((noise(p) * 0.5) + (noise((p * 2.02)) * 0.25)) + (noise((p * 4.08)) * 0.125)) + (noise((p * 8.2)) * 0.0625));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

void main() {
  vec2 _cse0 = (vec2((((uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((uv.y * 2.0) - 1.0)) * 1.8);
  vec2 _v0 = vec2(fbm(_cse0), fbm((_cse0 + vec2(5.2, 1.3))));
  vec2 _lc0 = (_cse0 + (_v0 * U.warp));
  vec2 _v1 = vec2(fbm(((_lc0 + vec2(1.7, 9.2)) + vec2((U.time * 0.15), (U.time * 0.12)))), fbm((_lc0 + vec2(8.3, 2.8))));
  float _v2 = fbm((_cse0 + (_v1 * U.warp)));
  _ret = vec4((mix(mix(mix(vec3(0.09, 0.12, 0.2), vec3(0.85, 0.83, 0.72), clamp(((_v2 * _v2) * 2.8), 0.0, 1.0)), vec3(0.2, 0.5, 0.55), clamp((length(_v0) * 0.9), 0.0, 1.0)), vec3(0.66, 0.3, 0.2), clamp((smoothstep(0.4, 1.0, _v1.y) * 0.6), 0.0, 1.0)) * ((_v2 * 1.4) + 0.35)), 1.0);
}
