struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  sun_az: f32,
  exaggeration: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn terrain(p: vec2<f32>, t: f32) -> f32 {
  return (((((sin(((p.x * 3.0) + t)) * cos((p.y * 3.0))) + ((sin(((p.x * 6.1) - (t * 0.7))) * cos((p.y * 5.3))) * 0.5)) + ((sin((p.x * 12.7)) * cos((p.y * 11.1))) * 0.25)) * 0.28) + 0.5);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _cse6 = (vo.uv * 6.0);
  let _cse2 = terrain(_cse6, U.time);
  let _cse3 = _cse6.x;
  let _cse4 = _cse6.y;
  let _cse5 = radians(U.sun_az);
  let _cse0 = vec3<f32>(((_cse2 - terrain(vec2<f32>((_cse3 + 0.015), _cse4), U.time)) * U.exaggeration), ((_cse2 - terrain(vec2<f32>(_cse3, (_cse4 + 0.015)), U.time)) * U.exaggeration), 0.015);
  let _cse1 = vec3<f32>((cos(_cse5) * 0.6), (sin(_cse5) * 0.6), 0.55);
  return vec4<f32>((mix(mix(vec3<f32>(0.16, 0.32, 0.2), vec3<f32>(0.55, 0.49, 0.3), smoothstep(0.3, 0.55, _cse2)), vec3<f32>(0.93, 0.93, 0.96), smoothstep(0.62, 0.85, _cse2)) * ((clamp(dot((_cse0 * (1.0 / length(_cse0))), (_cse1 * (1.0 / length(_cse1)))), 0.0, 1.0) * 0.8) + 0.3)), 1.0);
}
