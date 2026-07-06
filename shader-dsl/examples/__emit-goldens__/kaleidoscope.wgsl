struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  segments: f32,
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

fn fbm(p: vec2<f32>) -> f32 {
  return ((((noise(p) * 0.5) + (noise((p * 2.02)) * 0.25)) + (noise((p * 4.08)) * 0.125)) + (noise((p * 8.2)) * 0.0625));
}

fn palette(t: f32) -> vec3<f32> {
  return (vec3<f32>(0.5) + (cos(((t + vec3<f32>(0.0, 0.33, 0.67)) * 6.283)) * 0.5));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  let _v0 = length(_cse0);
  let _v1 = atan2(_cse0.y, _cse0.x);
  let _v2 = (6.2831853 / U.segments);
  let _v3 = abs(((_v1 - (_v2 * floor((_v1 / _v2)))) - (_v2 * 0.5)));
  let _v4 = fbm((((vec2<f32>(cos(_v3), sin(_v3)) * _v0) * 3.0) + vec2<f32>((U.time * 0.12), (-(U.time * 0.09)))));
  return vec4<f32>(((palette(((((_v4 * 0.7) + (((sin(((_v0 * 9.0) - (U.time * 0.8))) * 0.5) + 0.5) * 0.15)) + (_v0 * 0.3)) - (U.time * 0.03))) * ((_v4 * 0.9) + 0.35)) * (1.0 - smoothstep(0.55, 1.25, _v0))), 1.0);
}
