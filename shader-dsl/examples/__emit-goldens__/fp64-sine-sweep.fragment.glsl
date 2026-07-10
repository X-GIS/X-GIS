#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};
layout(std140) uniform Uniforms {
  vec2 resolution;
  vec2 base;
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
vec2 df64_div(vec2 a, vec2 b);
float df64_narrow(vec2 a);
vec2 df64_nint(vec2 a);
vec2 df64_sin_taylor(vec2 a);
vec2 df64_cos_taylor(vec2 a);
vec2 df64_sin(vec2 a);
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
  _v0 = df64_quickTwoSum(_v0.x, _v0.y);
  _v0.y = (_v0.y + (a.y * b.x));
  return df64_quickTwoSum(_v0.x, _v0.y);
}

vec2 df64_div(vec2 a, vec2 b) {
  float _v0 = (texelFetch(_fp64, ivec2(0, 0), 0).x / b.x);
  vec2 _v1 = (a * _v0);
  float _v2 = df64_sub(a, df64_mul(b, _v1)).x;
  vec2 _v3 = df64_twoProd(_v0, _v2);
  return df64_add(_v1, _v3);
}

float df64_narrow(vec2 a) {
  return (a.x + a.y);
}

vec2 df64_nint(vec2 a) {
  float _v0 = floor((a.x + 0.5));
  float _v1 = (((abs((_v0 - a.x)) == 0.5) && (a.y < 0.0)) ? (_v0 - 1.0) : _v0);
  return ((_v0 == a.x) ? df64_quickTwoSum(_v0, floor((a.y + 0.5))) : vec2(_v1, 0.0));
}

vec2 df64_sin_taylor(vec2 a) {
  vec2 _v0 = (-df64_mul(a, a));
  vec2 _v1 = df64_mul(a, _v0);
  vec2 _v2 = df64_add(a, df64_mul(_v1, vec2(0.1666666716337204, -4.967053879312289e-9)));
  vec2 _v3 = df64_mul(_v1, _v0);
  return df64_add(_v2, df64_mul(_v3, vec2(0.008333333767950535, -4.34617203337595e-10)));
}

vec2 df64_cos_taylor(vec2 a) {
  vec2 _v0 = (-df64_mul(a, a));
  vec2 _v1 = df64_add(vec2(1.0, 0.0), df64_mul(_v0, vec2(0.5, 0.0)));
  vec2 _v2 = df64_mul(_v0, _v0);
  vec2 _v3 = df64_add(_v1, df64_mul(_v2, vec2(0.0416666679084301, -1.2417634698280722e-9)));
  vec2 _v4 = df64_mul(_v2, _v0);
  return df64_add(_v3, df64_mul(_v4, vec2(0.0013888889225199819, -3.3631094437103215e-11)));
}

vec2 df64_sin(vec2 a) {
  vec2 _cse0 = vec2(6.2831854820251465, -1.7484555314695172e-7);
  vec2 _cse1 = vec2(0.7071067690849304, 1.2101617485882343e-8);
  vec2 _v0 = df64_nint(df64_div(a, _cse0));
  vec2 _v1 = df64_sub(a, df64_mul(_cse0, _v0));
  float _v2 = floor(((_v1.x / 1.5707963705062866) + 0.5));
  vec2 _v3 = df64_sub(_v1, df64_mul(vec2(1.5707963705062866, -4.371138828673793e-8), vec2(_v2, 0.0)));
  float _v4 = floor(((_v3.x / 0.19634954631328583) + 0.5));
  vec2 _v5 = df64_sub(_v3, df64_mul(vec2(0.19634954631328583, -5.463923535842241e-9), vec2(_v4, 0.0)));
  vec2 _v6 = df64_sin_taylor(_v5);
  vec2 _v7 = df64_cos_taylor(_v5);
  float _v8 = abs(_v4);
  vec2 _v9 = ((_v8 == 1.0) ? vec2(0.9807852506637573, 2.9739473106360492e-8) : ((_v8 == 2.0) ? vec2(0.9238795042037964, 2.830748968563057e-8) : ((_v8 == 3.0) ? vec2(0.8314695954322815, 1.687026340846387e-8) : ((_v8 == 4.0) ? _cse1 : vec2(1.0, 0.0)))));
  vec2 _v10 = ((_v8 == 1.0) ? vec2(0.19509032368659973, -1.6704715388726754e-9) : ((_v8 == 2.0) ? vec2(0.3826834261417389, 6.2233507236442165e-9) : ((_v8 == 3.0) ? vec2(0.5555702447891235, -1.1769521357507529e-8) : ((_v8 == 4.0) ? _cse1 : vec2(0.0, 0.0)))));
  vec2 _v11 = ((_v4 >= 0.0) ? _v10 : (-_v10));
  vec2 _v12 = df64_add(df64_mul(_v9, _v6), df64_mul(_v11, _v7));
  vec2 _v13 = df64_sub(df64_mul(_v9, _v7), df64_mul(_v11, _v6));
  return ((_v2 == 0.0) ? _v12 : ((_v2 == 1.0) ? _v13 : ((_v2 == -1.0) ? (-_v13) : (-_v12))));
}
in vec2 uv;
layout(location = 0) out vec4 _ret;

vec4 fs_sweep_impl(VsOut vo) {
  bool _cse0 = (vo.uv.x < 0.5);
  float _v0 = (vo.uv.x * 2.0);
  float _v1 = (_v0 - (_cse0 ? 0.0 : 1.0));
  bool _v2 = (_cse0 || (u.fp64 < 0.5));
  vec2 _v3 = df64_add(u.base, vec2((_v1 * 25.132741228718345), 0.0));
  float _v4 = df64_narrow(df64_sin(df64_add(_v3, vec2(0.0, 0.0))));
  float _v5 = sin((df64_narrow(u.base) + (_v1 * 25.132741228718345)));
  float _v6 = (_v2 ? _v5 : _v4);
  float _v7 = ((vo.uv.y - 0.5) * 2.0);
  float _v8 = (2.0 / u.resolution.y);
  float _v9 = fract((_v1 * 10.0));
  float _v10 = fract(((_v7 + 1.0) * 4.0));
  float _v11 = min(_v9, (1.0 - _v9));
  float _v12 = min(_v10, (1.0 - _v10));
  float _v13 = (30.0 / u.resolution.x);
  float _v14 = (20.0 / u.resolution.y);
  float _v15 = ((1.0 - smoothstep(0.0, _v13, _v11)) + (1.0 - smoothstep(0.0, _v14, _v12)));
  vec3 _v16 = mix(vec3(0.96, 0.94, 0.88), vec3(0.72, 0.78, 0.86), (min(_v15, 1.0) * 0.45));
  float _v17 = step(_v7, _v6);
  vec3 _v18 = mix(_v16, vec3(0.62, 0.74, 0.9), (_v17 * 0.4));
  float _v19 = (1.0 - smoothstep((_v8 * 1.2), (_v8 * 3.0), abs((_v6 - _v7))));
  vec3 _v20 = mix(_v18, vec3(0.13, 0.16, 0.3), (_v19 * 0.85));
  float _lc0 = (_v8 * 1.5);
  float _v21 = min(smoothstep(0.0, _lc0, abs(_v7)), smoothstep(0.0, _lc0, (abs((_v1 - 0.5)) * 2.0)));
  vec3 _v22 = mix(vec3(0.35, 0.33, 0.3), _v20, _v21);
  return vec4(_v22, 1.0);
}

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  _ret = fs_sweep_impl(vo);
}
