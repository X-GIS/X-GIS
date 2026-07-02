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
  float sun_az;
  float exaggeration;
} U;
float terrain(vec2 p, float t);
float terrain(vec2 p, float t) {
  return (((((sin(((p.x * 3.0) + t)) * cos((p.y * 3.0))) + ((sin(((p.x * 6.1) - (t * 0.7))) * cos((p.y * 5.3))) * 0.5)) + ((sin((p.x * 12.7)) * cos((p.y * 11.1))) * 0.25)) * 0.28) + 0.5);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_impl(VsOut vo) {
  vec2 _cse6 = (vo.uv * 6.0);
  float _cse2 = terrain(_cse6, U.time);
  float _cse3 = _cse6.x;
  float _cse4 = _cse6.y;
  float _cse5 = radians(U.sun_az);
  vec3 _cse0 = vec3(((_cse2 - terrain(vec2((_cse3 + 0.015), _cse4), U.time)) * U.exaggeration), ((_cse2 - terrain(vec2(_cse3, (_cse4 + 0.015)), U.time)) * U.exaggeration), 0.015);
  vec3 _cse1 = vec3((cos(_cse5) * 0.6), (sin(_cse5) * 0.6), 0.55);
  return vec4((mix(mix(vec3(0.16, 0.32, 0.2), vec3(0.55, 0.49, 0.3), smoothstep(0.3, 0.55, _cse2)), vec3(0.93, 0.93, 0.96), smoothstep(0.62, 0.85, _cse2)) * ((clamp(dot((_cse0 * (1.0 / length(_cse0))), (_cse1 * (1.0 / length(_cse1)))), 0.0, 1.0) * 0.8) + 0.3)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_impl(vo);
}
