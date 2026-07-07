struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  twist: f32,
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
  let _v0 = length(_cse0);
  let _v1 = ((0.3 / max(_v0, 0.001)) + (U.time * 1.4));
  return vec4<f32>((((mix(vec3<f32>(1.0, 0.62, 0.28), vec3<f32>(0.42, 0.3, 0.55), ((sin((_v1 * 0.9)) * 0.5) + 0.5)) * ((smoothstep(-0.6, 0.6, (sin((((atan2(_cse0.y, _cse0.x) / 3.14159265) + ((_v1 * U.twist) * 0.08)) * 12.566)) * sin((_v1 * 9.4248)))) * 0.55) + 0.35)) * smoothstep(0.0, 0.55, _v0)) * clamp((1.15 - (_v0 * 0.35)), 0.0, 1.0)), 1.0);
}
