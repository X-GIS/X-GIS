struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  bands: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn ramp(x: f32) -> vec3<f32> {
  return mix(mix(mix(mix(vec3<f32>(0.99, 0.95, 0.74), vec3<f32>(0.99, 0.8, 0.45), smoothstep(0.0, 0.25, x)), vec3<f32>(0.96, 0.5, 0.24), smoothstep(0.25, 0.5, x)), vec3<f32>(0.84, 0.19, 0.15), smoothstep(0.5, 0.75, x)), vec3<f32>(0.5, 0.0, 0.05), smoothstep(0.75, 1.0, x));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse3 = clamp((((sin(((vo.uv.x * 6.2832) + (U.time * 0.5))) * 0.3) + 0.5) + (sin(((vo.uv.y * 6.2832) - (U.time * 0.35))) * 0.2)), 0.0, 1.0);
  let _cse2 = (_cse3 * U.bands);
  let _cse0 = ramp(_cse3);
  let _cse1 = fract(_cse2);
  return vec4<f32>(mix(_cse0, (_cse0 * 0.2), clamp(((1.0 - smoothstep(0.0, (fwidth(_cse2) * 1.2), min(_cse1, (1.0 - _cse1)))) * smoothstep(0.5, 1.5, U.bands)), 0.0, 1.0)), 1.0);
}
