#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
layout(std140) uniform Uniforms {
  vec2 resolution;
  float half_width;
  float fp64;
} u;

uniform sampler2D _fp64;
vec2 df64_twoSum(float a, float b);
vec2 df64_quickTwoSum(float a, float b);
vec2 df64_split(float a);
vec2 df64_twoProd(float a, float b);
vec2 df64_add(vec2 a, vec2 b);
vec2 df64_sub(vec2 a, vec2 b);
vec2 df64_mul(vec2 a, vec2 b);
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

vec2 df64_split(float a) {
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  float _v0 = (a * (_cse0 * 4097.0));
  float _v1 = ((_v0 * _cse0) - (_v0 - a));
  float _v2 = ((a * _cse0) - _v1);
  return vec2(_v1, _v2);
}

vec2 df64_twoProd(float a, float b) {
  float _v0 = (a * b);
  vec2 _v1 = df64_split(a);
  vec2 _v2 = df64_split(b);
  float _v3 = (((((_v1.x * _v2.x) - _v0) + (_v1.x * _v2.y)) + (_v1.y * _v2.x)) + (_v1.y * _v2.y));
  return vec2(_v0, _v3);
}

vec2 df64_add(vec2 a, vec2 b) {
  vec2 _v0 = df64_twoSum(a.x, b.x);
  vec2 _v1 = df64_twoSum(a.y, b.y);
  _v0.y = (_v0.y + _v1.x);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + _v1.y);
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  return _v0;
}

vec2 df64_sub(vec2 a, vec2 b) {
  return df64_add(a, (-b));
}

vec2 df64_mul(vec2 a, vec2 b) {
  vec2 _v0 = df64_twoProd(a.x, b.x);
  _v0.y = (_v0.y + (a.x * b.y));
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_cancel_impl(VsOut vo) {
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(1.0, 0.0);
  vec2 _cse2 = vec2(7.0, 0.0);
  vec2 _cse3 = vec2(21.0, 0.0);
  vec2 _cse4 = vec2(35.0, 0.0);
  float _v0 = u.half_width;
  float _v1 = (vo.uv.x * 2.0);
  float _v2 = (_v1 - (_cse0 ? 0.0 : 1.0));
  float _v3 = ((_v2 - 0.5) * (_v0 * 2.0));
  bool _v4 = (_cse0 || (u.fp64 < 0.5));
  vec2 _v5 = df64_add(_cse1, vec2(_v3, 0.0));
  vec2 _v6 = df64_mul(_v5, _v5);
  vec2 _v7 = df64_mul(_v6, _v5);
  vec2 _v8 = df64_mul(_v6, _v6);
  vec2 _v9 = df64_mul(_v8, _v5);
  vec2 _v10 = df64_mul(_v7, _v7);
  vec2 _v11 = df64_mul(_v10, _v5);
  float _v12 = df64_narrow(df64_sub(df64_add(df64_sub(df64_add(df64_sub(df64_add(df64_sub(_v11, df64_mul(_v10, _cse2)), df64_mul(_v9, _cse3)), df64_mul(_v8, _cse4)), df64_mul(_v7, _cse4)), df64_mul(_v6, _cse3)), df64_mul(_v5, _cse2)), _cse1));
  float _v13 = (1.0 + _v3);
  float _v14 = (_v13 * _v13);
  float _v15 = (_v14 * _v13);
  float _v16 = (_v14 * _v14);
  float _v17 = (_v16 * _v13);
  float _v18 = (_v15 * _v15);
  float _v19 = (_v18 * _v13);
  float _v20 = (((((((_v19 - (_v18 * 7.0)) + (_v17 * 21.0)) - (_v16 * 35.0)) + (_v15 * 35.0)) - (_v14 * 21.0)) + (_v13 * 7.0)) - 1.0);
  float _v21 = (_v4 ? _v20 : _v12);
  float _v22 = (pow(_v0, 7.0) * 1.3);
  float _v23 = (_v21 / _v22);
  float _v24 = (_v3 * _v3);
  float _v25 = ((((_v24 * _v24) * _v24) * _v3) / _v22);
  float _v26 = ((vo.uv.y - 0.5) * 2.0);
  float _v27 = (2.0 / u.resolution.y);
  float _v28 = fract((_v2 * 10.0));
  float _v29 = fract(((_v26 + 1.0) * 5.0));
  float _v30 = min(_v28, (1.0 - _v28));
  float _v31 = min(_v29, (1.0 - _v29));
  float _v32 = (30.0 / u.resolution.x);
  float _v33 = (15.0 / u.resolution.y);
  float _v34 = ((1.0 - smoothstep(0.0, _v32, _v30)) + (1.0 - smoothstep(0.0, _v33, _v31)));
  vec3 _v35 = mix(vec3(0.96, 0.94, 0.88), vec3(0.72, 0.78, 0.86), (min(_v34, 1.0) * 0.45));
  float _v36 = step(_v26, _v23);
  vec3 _v37 = mix(_v35, vec3(0.62, 0.74, 0.9), (_v36 * 0.5));
  float _v38 = (1.0 - smoothstep((_v27 * 1.2), (_v27 * 3.0), abs((_v23 - _v26))));
  vec3 _v39 = mix(_v37, vec3(0.13, 0.16, 0.3), (_v38 * 0.85));
  float _v40 = (1.0 - smoothstep((_v27 * 0.8), (_v27 * 2.2), abs((_v25 - _v26))));
  vec3 _v41 = mix(_v39, vec3(0.8, 0.25, 0.2), (_v40 * 0.65));
  float _lc0 = (_v27 * 1.5);
  float _v42 = min(smoothstep(0.0, _lc0, abs(_v26)), smoothstep(0.0, _lc0, (abs((_v2 - 0.5)) * 2.0)));
  vec3 _v43 = mix(vec3(0.35, 0.33, 0.3), _v41, _v42);
  return vec4(_v43, 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_cancel_impl(vo);
}
