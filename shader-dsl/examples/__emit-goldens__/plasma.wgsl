struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
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
  let _cse0 = ((sin(((vo.uv.x * 10.0) + U.time)) + sin(((vo.uv.y * 10.0) + U.time))) + sin((((vo.uv.x + vo.uv.y) * 10.0) + (U.time * 0.7))));
  return vec4<f32>(((vec3<f32>(sin(_cse0), sin((_cse0 + 2.094)), sin((_cse0 + 4.188))) * 0.5) + 0.5), 1.0);
}
