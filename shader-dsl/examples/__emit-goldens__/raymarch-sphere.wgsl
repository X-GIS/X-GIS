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
  let _cse3 = vec2<f32>(((vo.uv.x * 2.0) - 1.0), ((vo.uv.y * 2.0) - 1.0));
  let _cse0 = vec3<f32>(0.0, 0.0, 3.0);
  let _cse1 = normalize(vec3<f32>(_cse3.x, _cse3.y, -1.5));
  let _cse2 = normalize(vec3<f32>(cos(U.time), 0.75, sin(U.time)));
  var _av0: f32 = 0.0;
  var _av1: f32 = 0.0;
  for (var _v0: u32 = 0u; (_v0 < 72u); _v0 = (_v0 + 1u)) {
    let _v1 = (length((_cse0 + (_cse1 * _av1))) - 1.0);
    if ((_v1 < 0.001)) {
      _av0 = 1.0;
      break;
    }
    _av1 = (_av1 + _v1);
    if ((_av1 > 8.0)) {
      break;
    }
  }
  var _av2: vec3<f32> = (vec3<f32>(0.04, 0.05, 0.09) + (vec3<f32>(0.0, 0.04, 0.1) * vo.uv.y));
  if ((_av0 > 0.5)) {
    let _v2 = normalize((_cse0 + (_cse1 * _av1)));
    _av2 = (((vec3<f32>(0.22, 0.48, 0.95) * ((max(dot(_v2, _cse2), 0.0) * 0.85) + 0.12)) + (vec3<f32>(1.0) * (pow(max(dot(_v2, normalize((_cse2 - _cse1))), 0.0), 48.0) * 0.6))) + (vec3<f32>(0.25, 0.35, 0.55) * (pow((1.0 - max(dot(_v2, (-_cse1)), 0.0)), 2.0) * 0.5)));
  }
  return vec4<f32>(_av2, 1.0);
}
