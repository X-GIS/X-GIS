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
  vec4 mouse;
} U;
float scene(vec3 p);
vec3 palette(float t);
float scene(vec3 p) {
  vec3 _v0 = (mod(p, 2.6) - vec3(1.3));
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
  float _v2 = ((((U.mouse.x / U.resolution.x) - 0.5) * 1.6) * U.mouse.w);
  float _v3 = (((U.mouse.y / U.resolution.y) - 0.5) * U.mouse.w);
  float _v4 = cos(_v2);
  float _v5 = sin(_v2);
  float _v6 = cos(_v3);
  float _v7 = sin(_v3);
  float _v8 = ((_v1.x * _v4) + (_v1.z * _v5));
  float _v9 = ((_v1.z * _v4) - (_v1.x * _v5));
  float _v10 = ((_v1.y * _v6) - (_v9 * _v7));
  float _v11 = ((_v9 * _v6) + (_v1.y * _v7));
  vec3 _v12 = vec3(_v8, _v10, _v11);
  float _av0 = 0.0;
  float _av1 = 0.0;
  for (uint _v13 = 0u; (_v13 < 90u); _v13 = (_v13 + 1u)) {
    float _v14 = scene((_v0 + (_v12 * _av1)));
    if ((_v14 < 0.002)) {
      _av0 = 1.0;
      break;
    }
    _av1 = (_av1 + (_v14 * 0.9));
    if ((_av1 > 30.0)) {
      break;
    }
  }
  vec3 _v15 = (vec3(0.04, 0.05, 0.09) + (vec3(0.02, 0.04, 0.08) * vo.uv.y));
  vec3 _av2 = (_v15 + vec3(0.0, 0.0, 0.0));
  if ((_av0 > 0.5)) {
    vec3 _v16 = (_v0 + (_v12 * _av1));
    vec3 _v17 = normalize(vec3((scene((_v16 + _cse1)) - scene((_v16 - _cse1))), (scene((_v16 + _cse2)) - scene((_v16 - _cse2))), (scene((_v16 + _cse3)) - scene((_v16 - _cse3)))));
    vec3 _lc0 = floor((_v16 / 2.6));
    _av2 = mix(_v15, (palette(fract((sin((((_lc0.x * 12.9898) + (_lc0.y * 78.233)) + (_lc0.z * 37.719))) * 43758.5453))) * ((max(dot(_v17, normalize(vec3(0.5, 0.8, 0.3))), 0.0) * 0.8) + 0.16)), exp((-(_av1 * 0.09))));
  }
  return vec4(_av2, 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
