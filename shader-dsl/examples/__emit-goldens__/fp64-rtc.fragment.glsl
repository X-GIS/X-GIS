#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};

struct DF64Vec2 {
  vec2 hi;
  vec2 lo;
};
layout(std140) uniform Uniforms {
  DF64Vec2 center;
  vec2 resolution;
  float zoom_exp;
  float fp64;
} u;

uniform sampler2D _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
float df64_narrow(vec2 a);
vec2 df64_twoSum(float a, float b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (a + b);
  float _v1 = (((_v0 * _cse0) - a) * _cse0);
  float _v2 = (((((a - ((_v0 - _v1) * _cse0)) * _cse0) * _cse0) * _cse0) + (b - _v1));
  return vec2(_v0, _v2);
}

vec2 df64_quickTwoSum(float a, float b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = ((a + b) * _cse0);
  float _v1 = (b - ((_v0 - a) * _cse0));
  return vec2(_v0, _v1);
}

vec2 df64_add(vec2 a, vec2 b) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  vec2 _v0 = vec2((a.x * _cse0), (a.y * _cse0));
  vec2 _v1 = vec2((b.x * _cse0), (b.y * _cse0));
  vec2 _v2 = df64_twoSum(_v0.x, _v1.x);
  vec2 _v3 = df64_twoSum(_v0.y, _v1.y);
  _v2.y = (_v2.y + _v3.x);
  _v2 = df64_quickTwoSum(_v2.x, _v2.y);
  _v2.y = (_v2.y + _v3.y);
  _v2 = df64_quickTwoSum(_v2.x, _v2.y);
  return _v2;
}

vec2 df64_sub(vec2 a, vec2 b) {
  return df64_add(a, (-b));
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_rtc_impl(VsOut vo) {
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(u.center.hi.x, u.center.lo.x);
  vec2 _cse2 = vec2(u.center.hi.y, u.center.lo.y);
  float _v0 = pow(10.0, (-u.zoom_exp));
  float _v1 = (vo.uv.x * 2.0);
  float _v2 = (_v1 - (_cse0 ? 0.0 : 1.0));
  float _v3 = ((_v2 - 0.5) * _v0);
  float _v4 = (((vo.uv.y - 0.5) * _v0) * ((u.resolution.y / u.resolution.x) * 2.0));
  bool _v5 = (_cse0 || (u.fp64 < 0.5));
  float _v6 = df64_narrow(df64_sub(df64_add(_cse1, vec2(_v3, 0.0)), vec2(100000000.0, 3.700000047683716)));
  float _v7 = df64_narrow(df64_sub(df64_add(_cse2, vec2(_v4, 0.0)), vec2(50000004.0, -1.7000000476837158)));
  float _v8 = ((df64_narrow(_cse1) + _v3) - 100000003.7);
  float _v9 = ((df64_narrow(_cse2) + _v4) - 50000002.3);
  float _v10 = (_v5 ? _v8 : _v6);
  float _v11 = (_v5 ? _v9 : _v7);
  float _v12 = (_v0 * 0.125);
  float _v13 = length(vec2(_v10, _v11));
  float _v14 = (_v0 / (u.resolution.x * 0.5));
  float _v15 = (((-abs((fract((_v13 / _v12)) - 0.5))) + 0.5) * _v12);
  float _v16 = (1.0 - smoothstep(0.0, ((_v14 * 1.6) + 1e-9), _v15));
  float _v17 = (1.0 - smoothstep(0.0, ((_v14 * 1.4) + 1e-9), min(abs(_v10), abs(_v11))));
  float _v18 = exp((-(_v13 / ((_v14 * 6.0) + 1e-9))));
  float _v19 = max(0.0, (1.0 - (_v13 / (_v0 * 0.75))));
  vec3 _v20 = mix(vec3(0.01, 0.04, 0.02), vec3(0.02, 0.09, 0.045), _v19);
  return vec4((((_v20 + (vec3(0.1, 0.75, 0.3) * (_v16 * 0.8))) + (vec3(0.12, 0.9, 0.4) * (_v17 * 0.55))) + (vec3(1.0, 0.45, 0.25) * _v18)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_rtc_impl(vo);
}
