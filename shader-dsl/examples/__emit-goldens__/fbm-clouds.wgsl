struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  octaves: f32,
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
  let _licm0 = U.octaves;
  let _licm1 = vec2<f32>((U.time * 0.08), 0.0);
  var _av0: f32 = 0.0;
  var _av1: vec2<f32> = vec2<f32>((vo.uv.x * 3.0), (vo.uv.y * 3.0));
  var _av2: f32 = 0.55;
  for (var _v0: u32 = 0u; (f32(_v0) < _licm0); _v0 = (_v0 + 1u)) {
    _av0 = (_av0 + (_av2 * noise((_av1 + _licm1))));
    _av1 = (_av1 * 2.02);
    _av2 = (_av2 * 0.5);
  }
  return vec4<f32>(mix(vec3<f32>(0.2, 0.42, 0.72), vec3<f32>(0.97, 0.97, 1.0), clamp(_av0, 0.0, 1.0)), 1.0);
}
