struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  swell: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn hash(p: vec2<f32>) -> f32 {
  return fract((sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453));
}

fn noise(p: vec2<f32>) -> f32 {
  let _cse0 = vec2<f32>(3.0);
  let _v0 = floor(p);
  let _v1 = fract(p);
  let _lc0 = ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).x;
  return mix(mix(hash(_v0), hash((_v0 + vec2<f32>(1.0, 0.0))), _lc0), mix(hash((_v0 + vec2<f32>(0.0, 1.0))), hash((_v0 + vec2<f32>(1.0, 1.0))), _lc0), ((_v1 * _v1) * (_cse0 - (_v1 * 2.0))).y);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = (U.time * 0.6);
  let _licm1 = vec2<f32>((U.time * 0.12), 0.0);
  let _cse0 = (((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y));
  let _cse1 = vec3<f32>(1.0, 0.85, 0.6);
  let _v0 = distance(vec2<f32>(_cse0, ((vo.uv.y * 2.0) - 1.0)), vec2<f32>(0.42, 0.56));
  let _v1 = max((0.58 - vo.uv.y), 0.0008);
  let _v2 = (0.06 / _v1);
  var _av0: f32 = 0.0;
  var _av1: f32 = 1.0;
  var _av2: f32 = 0.5;
  for (var _v3: u32 = 0u; (_v3 < 4u); _v3 = (_v3 + 1u)) {
    _av0 = (_av0 + (_av2 * noise((((vec2<f32>(((_cse0 * _v2) * 0.6), (_v2 + _licm0)) * 3.0) * _av1) + _licm1))));
    _av1 = (_av1 * 2.03);
    _av2 = (_av2 * 0.5);
  }
  let _lc0 = ((_av0 * U.swell) * smoothstep(0.0, 0.05, _v1));
  return vec4<f32>(mix(((mix(vec3<f32>(0.05, 0.18, 0.28), vec3<f32>(0.55, 0.5, 0.45), exp((-(_v1 * 7.0)))) + (vec3<f32>(0.3, 0.38, 0.36) * _lc0)) + (_cse1 * clamp(((pow((max((_lc0 - 0.32), 0.0) * 2.6), 3.0) * exp((-(abs((_cse0 - 0.42)) * 2.2)))) * exp((-(_v1 * 2.5)))), 0.0, 1.2))), (mix(vec3<f32>(0.83, 0.58, 0.38), vec3<f32>(0.12, 0.28, 0.48), smoothstep(0.58, 1.0, vo.uv.y)) + (_cse1 * ((1.0 - smoothstep(0.035, 0.06, _v0)) + (exp((-(_v0 * 4.0))) * 0.35)))), step(0.58, vo.uv.y)), 1.0);
}
