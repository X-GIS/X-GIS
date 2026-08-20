struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct FsOut {
  @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn discard_outside_circle(p: vec2<f32>) -> vec4<f32> {
  let _v0 = length(p);
  if ((_v0 > 1.0)) {
    discard;
  }
  return vec4<f32>(mix(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(0.06, 0.1, 0.35), _v0), 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> FsOut {
  return FsOut(discard_outside_circle(vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0))));
}
