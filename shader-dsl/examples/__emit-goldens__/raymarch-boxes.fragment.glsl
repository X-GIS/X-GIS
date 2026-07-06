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
  float speed;
} U;
float scene(vec3 p);
vec3 palette(float t);
float scene(vec3 p) {
  vec3 _v0 = ((p - (vec3(2.6) * floor((p / 2.6)))) - vec3(1.3));
  return (length(max((abs(_v0) - vec3(0.62)), vec3(0.0, 0.0, 0.0))) - 0.14);
}

vec3 palette(float t) {
  return (vec3(0.5) + (cos(((t + vec3(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse0 = vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  vec3 _cse1 = vec3(0.0015, 0.0, 0.0);
  vec3 _cse2 = vec3(0.0, 0.0015, 0.0);
  vec3 _cse3 = vec3(0.0, 0.0, 0.0015);
  vec3 _v0 = vec3((sin((U.time * 0.23)) * 0.4), (cos((U.time * 0.2)) * 0.4), (-(U.time * U.speed)));
  vec3 _v1 = normalize(vec3(_cse0.x, _cse0.y, -1.6));
  float _av0 = 0.0;
  float _av1 = 0.0;
  for (uint _v2 = 0u; (_v2 < 90u); _v2 = (_v2 + 1u)) {
    float _v3 = scene((_v0 + (_v1 * _av1)));
    if ((_v3 < 0.002)) {
      _av0 = 1.0;
      break;
    }
    _av1 = (_av1 + (_v3 * 0.9));
    if ((_av1 > 30.0)) {
      break;
    }
  }
  vec3 _v4 = (vec3(0.04, 0.05, 0.09) + (vec3(0.02, 0.04, 0.08) * vo.uv.y));
  vec3 _av2 = (_v4 + vec3(0.0, 0.0, 0.0));
  if ((_av0 > 0.5)) {
    vec3 _v5 = (_v0 + (_v1 * _av1));
    vec3 _v6 = normalize(vec3((scene((_v5 + _cse1)) - scene((_v5 - _cse1))), (scene((_v5 + _cse2)) - scene((_v5 - _cse2))), (scene((_v5 + _cse3)) - scene((_v5 - _cse3)))));
    vec3 _lc0 = floor((_v5 / 2.6));
    _av2 = mix(_v4, (palette(fract((sin((((_lc0.x * 12.9898) + (_lc0.y * 78.233)) + (_lc0.z * 37.719))) * 43758.5453))) * ((max(dot(_v6, normalize(vec3(0.5, 0.8, 0.3))), 0.0) * 0.8) + 0.16)), exp((-(_av1 * 0.09))));
  }
  return vec4(_av2, 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
