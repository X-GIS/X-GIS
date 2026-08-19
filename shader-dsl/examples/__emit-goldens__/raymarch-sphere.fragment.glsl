#version 300 es
precision highp float;
precision highp int;

layout(std140) uniform Uniforms {
  float time;
  vec2 resolution;
} U;
in vec2 uv;
layout(location = 0) out vec4 _ret;

void main() {
  float _av0 = 0.0;
  float _av1 = 0.0;
  vec3 _cse0 = vec3(0.0, 0.0, 3.0);
  vec2 _cse3 = vec2(((uv.x * 2.0) - 1.0), ((uv.y * 2.0) - 1.0));
  vec3 _cse1 = normalize(vec3(_cse3.x, _cse3.y, -1.5));
  for (uint _v0 = 0u; (_v0 < 72u); _v0 = (_v0 + 1u)) {
    float _v1 = (length((_cse0 + (_cse1 * _av1))) - 1.0);
    if ((_v1 < 0.001)) {
      _av0 = 1.0;
      break;
    }
    _av1 = (_av1 + _v1);
    if ((_av1 > 8.0)) {
      break;
    }
  }
  vec3 _av2 = (vec3(0.04, 0.05, 0.09) + (vec3(0.0, 0.04, 0.1) * uv.y));
  if ((_av0 > 0.5)) {
    vec3 _v2 = normalize((_cse0 + (_cse1 * _av1)));
    vec3 _cse2 = normalize(vec3(cos(U.time), 0.75, sin(U.time)));
    _av2 = (((vec3(0.22, 0.48, 0.95) * ((max(dot(_v2, _cse2), 0.0) * 0.85) + 0.12)) + (vec3(1.0) * (pow(max(dot(_v2, normalize((_cse2 - _cse1))), 0.0), 48.0) * 0.6))) + (vec3(0.25, 0.35, 0.55) * (pow((1.0 - max(dot(_v2, (-_cse1)), 0.0)), 2.0) * 0.5)));
  }
  _ret = vec4(_av2, 1.0);
}
