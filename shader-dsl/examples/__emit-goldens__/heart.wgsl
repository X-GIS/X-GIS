struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  beat: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse0 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  let _v0 = (pow(abs(sin(((U.time * 3.14159) * U.beat))), 8.0) * 0.12);
  let _v1 = (0.72 + _v0);
  let _v2 = ((_cse0.x * 1.3) / _v1);
  let _v3 = (((_cse0.y + 0.08) * 1.3) / _v1);
  let _v4 = (_v2 * _v2);
  let _v5 = ((_v4 + (_v3 * _v3)) - 1.0);
  let _v6 = (((_v5 * _v5) * _v5) - (((_v4 * _v3) * _v3) * _v3));
  let _v7 = (fwidth(_v6) * 1.6);
  return vec4<f32>(mix(((vec3<f32>(0.05, 0.04, 0.07) * (1.0 - (vo.uv.y * 0.35))) + (vec3<f32>(0.7, 0.08, 0.16) * (exp((-(max(_v6, 0.0) * 2.2))) * ((_v0 * 3.0) + 0.35)))), mix(vec3<f32>(0.55, 0.03, 0.1), vec3<f32>(0.95, 0.15, 0.25), clamp((-_v6), 0.0, 1.0)), (1.0 - smoothstep((-_v7), _v7, _v6))), 1.0);
}
