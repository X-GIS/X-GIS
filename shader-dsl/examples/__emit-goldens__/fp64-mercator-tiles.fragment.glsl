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
  float tile_z;
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
vec2 df64_floor(vec2 a);
vec2 df64_fract(vec2 a);
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
  float _cse0 = texelFetch(_fp64, ivec2(0, 0), 0).x;
  vec2 _v0 = df64_twoProd(a.x, b.x);
  _v0.y = (_v0.y + ((a.x * b.y) * _cse0));
  _v0.y = (_v0.y + (((a.y * b.x) * _cse0) * _cse0));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

vec2 df64_floor(vec2 a) {
  float _v0 = floor(a.x);
  return ((_v0 == a.x) ? df64_quickTwoSum(_v0, floor(a.y)) : vec2(_v0, 0.0));
}

vec2 df64_fract(vec2 a) {
  return df64_sub(a, df64_floor(a));
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_tiles_impl(VsOut vo) {
  float _licm0 = u.tile_z;
  bool _cse0 = (vo.uv.x < 0.5);
  vec2 _cse1 = vec2(u.center.hi.x, u.center.lo.x);
  vec2 _cse2 = vec2(u.center.hi.y, u.center.lo.y);
  vec2 _cse3 = vec2(0.0, 0.0);
  float _v0 = 1.0;
  for (uint _v1 = 0u; (float(_v1) < _licm0); _v1 = (_v1 + 1u)) {
    _v0 = (_v0 * 2.0);
  }
  float _v2 = (3.0 / _v0);
  float _v3 = (vo.uv.x * 2.0);
  float _v4 = (_v3 - (_cse0 ? 0.0 : 1.0));
  float _v5 = ((_v4 - 0.5) * _v2);
  float _v6 = (((vo.uv.y - 0.5) * _v2) * ((u.resolution.y / u.resolution.x) * 2.0));
  bool _v7 = (_cse0 || (u.fp64 < 0.5));
  vec2 _v8 = df64_mul(df64_add(_cse1, vec2(_v5, 0.0)), vec2(_v0, 0.0));
  vec2 _v9 = df64_mul(df64_add(_cse2, vec2(_v6, 0.0)), vec2(_v0, 0.0));
  float _v10 = df64_narrow(df64_floor(_v8));
  float _v11 = df64_narrow(df64_floor(_v9));
  float _v12 = df64_narrow(df64_fract(df64_add(_v8, _cse3)));
  float _v13 = df64_narrow(df64_fract(df64_add(_v9, _cse3)));
  float _v14 = (df64_narrow(df64_fract(df64_mul(df64_add(df64_floor(_v8), df64_floor(_v9)), vec2(0.5, 0.0)))) * 2.0);
  float _v15 = ((df64_narrow(_cse1) + _v5) * _v0);
  float _v16 = ((df64_narrow(_cse2) + _v6) * _v0);
  float _v17 = floor(_v15);
  float _v18 = floor(_v16);
  float _v19 = fract(_v15);
  float _v20 = fract(_v16);
  float _v21 = (fract(((_v17 + _v18) * 0.5)) * 2.0);
  float _v22 = (_v7 ? _v17 : _v10);
  float _v23 = (_v7 ? _v18 : _v11);
  float _v24 = (_v7 ? _v19 : _v12);
  float _v25 = (_v7 ? _v20 : _v13);
  float _v26 = (_v7 ? _v21 : _v14);
  float _v27 = fract((sin(dot(vec2(_v22, _v23), vec2(127.1, 311.7))) * 43758.5453));
  vec3 _v28 = (mix(vec3(0.78, 0.84, 0.88), vec3(0.9, 0.87, 0.78), _v27) * mix(0.88, 1.0, _v26));
  float _v29 = mix(0.92, 1.05, ((_v24 * 0.6) + (_v25 * 0.4)));
  float _v30 = min(min(_v24, (1.0 - _v24)), min(_v25, (1.0 - _v25)));
  float _v31 = (3.0 / (u.resolution.x * 0.5));
  float _v32 = smoothstep(0.0, ((_v31 * 1.6) + 1e-9), _v30);
  float _v33 = step(_v30, (_v31 * 6.0));
  return vec4((((_v28 * _v29) * mix(0.45, 1.0, _v32)) - (vec3(0.05, 0.04, 0.02) * _v33)), 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_tiles_impl(vo);
}
