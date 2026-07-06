struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  zoom: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

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
  let _cse2 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  let _cse0 = _cse2.x;
  let _cse1 = _cse2.y;
  let _v0 = (exp((-(U.zoom + ((sin((U.time * 0.2)) * 0.75) + 0.75)))) * 2.4);
  var _v1: vec2<f32> = vec2<f32>(0.0, 0.0);
  var _v2: f32 = 0.0;
  for (var _v3: u32 = 0u; (_v3 < 120u); _v3 = (_v3 + 1u)) {
    if ((dot(_v1, _v1) > 16.0)) {
      break;
    }
    let _lc0 = vec2<f32>(((_cse0 * _v0) - 0.7453), ((_cse1 * _v0) + 0.1127));
    _v1 = vec2<f32>((((_v1.x * _v1.x) - (_v1.y * _v1.y)) + _lc0.x), (((_v1.x * _v1.y) * 2.0) + _lc0.y));
    _v2 = (_v2 + 1.0);
  }
  let _v4 = dot(_v1, _v1);
  return vec4<f32>((palette(((((_v2 - log2(max(log2(max(_v4, 1.0001)), 0.0001))) + 1.0) * 0.035) + (U.time * 0.02))) * (1.0 - step(119.5, _v2))), 1.0);
}
