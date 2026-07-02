struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  spacing: f32,
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
  let _cse3 = ((vo.uv.y * 180.0) - 90.0);
  let _cse0 = abs(_cse3);
  let _cse1 = (((vo.uv.x * 360.0) - 180.0) + (U.time * 8.0));
  let _cse2 = fwidth(_cse3);
  return vec4<f32>(mix(mix(mix(vec3<f32>(0.05, 0.13, 0.24), vec3<f32>(0.03, 0.07, 0.14), (_cse0 / 90.0)), vec3<f32>(0.55, 0.72, 0.86), clamp(max((1.0 - smoothstep(0.0, (fwidth(_cse1) * 1.5), (abs((fract(((_cse1 / U.spacing) + 0.5)) - 0.5)) * U.spacing))), (1.0 - smoothstep(0.0, (_cse2 * 1.5), (abs((fract(((_cse3 / U.spacing) + 0.5)) - 0.5)) * U.spacing)))), 0.0, 1.0)), vec3<f32>(0.96, 0.84, 0.45), clamp((1.0 - smoothstep(0.0, (_cse2 * 3.0), _cse0)), 0.0, 1.0)), 1.0);
}
