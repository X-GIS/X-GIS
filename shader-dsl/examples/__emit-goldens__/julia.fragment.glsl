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
  vec2 _v0 = (vec2(((vo.uv.x * 2.0) - 1.0), ((vo.uv.y * 2.0) - 1.0)) * U.zoom);
  vec2 _v1 = mix(vec2(((cos((U.time * 0.31)) * 0.39) - 0.4), (sin((U.time * 0.41)) * 0.39)), vec2(((((U.mouse.x / U.resolution.x) * 2.0) - 1.0) * 0.8), ((((U.mouse.y / U.resolution.y) * 2.0) - 1.0) * 0.8)), U.mouse.w);
  float _v2 = 0.0;
  for (uint _v3 = 0u; (_v3 < 96u); _v3 = (_v3 + 1u)) {
    if ((dot(_v0, _v0) > 4.0)) {
      break;
    }
    _v0 = vec2((((_v0.x * _v0.x) - (_v0.y * _v0.y)) + _v1.x), (((_v0.x * _v0.y) * 2.0) + _v1.y));
    _v2 = (_v2 + 1.0);
  }
  float _lc0 = (_v2 / 96.0);
  return vec4((palette((_lc0 + (U.time * 0.05))) * _lc0), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
