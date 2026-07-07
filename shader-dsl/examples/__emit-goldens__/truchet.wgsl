struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  tiles: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn hash(p: vec2<f32>) -> f32 {
  return fract((sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453));
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
  let _cse0 = (vec2<f32>((vo.uv.x * (U.resolution.x / U.resolution.y)), vo.uv.y) * U.tiles);
  let _cse1 = vec2<f32>(1.0, 1.0);
  let _v0 = floor(_cse0);
  let _v1 = fract(_cse0);
  let _v2 = hash(_v0);
  let _v3 = vec2<f32>(mix(_v1.x, (1.0 - _v1.x), step(0.5, _v2)), _v1.y);
  let _v4 = min(abs((length(_v3) - 0.5)), abs((length((_v3 - _cse1)) - 0.5)));
  let _v5 = (fwidth(_v4) * 1.4);
  return vec4<f32>(mix(vec3<f32>(0.04, 0.05, 0.09), (palette(((hash((_v0 + vec2<f32>(7.7, 3.1))) * 0.4) + (U.time * 0.05))) * ((sin(((mix(atan2((_v3.y - 1.0), (_v3.x - 1.0)), atan2(_v3.y, _v3.x), step(abs((length(_v3) - 0.5)), abs((length((_v3 - _cse1)) - 0.5)))) * 6.0) + (U.time * 2.5))) * 0.35) + 0.65)), (1.0 - smoothstep((0.13 - _v5), (0.13 + _v5), _v4))), 1.0);
}
