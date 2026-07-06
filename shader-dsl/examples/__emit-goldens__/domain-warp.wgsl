struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  warp: f32,
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

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = (vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0)) * 1.8);
  let _v0 = vec2<f32>(fbm(_cse0), fbm((_cse0 + vec2<f32>(5.2, 1.3))));
  let _lc0 = (_cse0 + (_v0 * U.warp));
  let _v1 = vec2<f32>(fbm(((_lc0 + vec2<f32>(1.7, 9.2)) + vec2<f32>((U.time * 0.15), (U.time * 0.12)))), fbm((_lc0 + vec2<f32>(8.3, 2.8))));
  let _v2 = fbm((_cse0 + (_v1 * U.warp)));
  return vec4<f32>((mix(mix(mix(vec3<f32>(0.09, 0.12, 0.2), vec3<f32>(0.85, 0.83, 0.72), clamp(((_v2 * _v2) * 2.8), 0.0, 1.0)), vec3<f32>(0.2, 0.5, 0.55), clamp((length(_v0) * 0.9), 0.0, 1.0)), vec3<f32>(0.66, 0.3, 0.2), clamp((smoothstep(0.4, 1.0, _v1.y) * 0.6), 0.0, 1.0)) * ((_v2 * 1.4) + 0.35)), 1.0);
}
