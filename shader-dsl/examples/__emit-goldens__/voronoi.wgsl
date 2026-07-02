struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  cells: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn hash2(c: vec2<f32>) -> vec2<f32> {
  let _cse0 = vec2<f32>(dot(c, vec2<f32>(127.1, 311.7)), dot(c, vec2<f32>(269.5, 183.3)));
  return fract((vec2<f32>(sin(_cse0.x), sin(_cse0.y)) * 43758.5453));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  let _cse0 = ((f32((vi & 1u)) * 4.0) - 1.0);
  let _cse1 = ((f32((vi >> 1u)) * 4.0) - 1.0);
  return VsOut(vec4<f32>(_cse0, _cse1, 0.0, 1.0), vec2<f32>(((_cse0 * 0.5) + 0.5), ((_cse1 * 0.5) + 0.5)));
}

@fragment
fn fs(vo: VsOut) -> @location(0) vec4<f32> {
  let _licm0 = U.time;
  let _cse0 = (vo.uv * U.cells);
  var _av0: f32 = 8.0;
  for (var _v0: i32 = -1; (_v0 <= 1); _v0 = (_v0 + 1)) {
    for (var _v1: i32 = -1; (_v1 <= 1); _v1 = (_v1 + 1)) {
      let _v2 = vec2<f32>(f32(_v1), f32(_v0));
      let _v3 = hash2((floor(_cse0) + _v2));
      _av0 = min(_av0, distance(fract(_cse0), ((_v2 + ((_v3 * 0.5) + 0.25)) + (vec2<f32>(sin((_licm0 + (_v3.x * 6.283))), cos((_licm0 + (_v3.y * 6.283)))) * 0.18))));
    }
  }
  return vec4<f32>(((vec3<f32>((_av0 * _av0)) * vec3<f32>(0.35, 0.6, 1.0)) + vec3<f32>(0.02, 0.03, 0.06)), 1.0);
}
