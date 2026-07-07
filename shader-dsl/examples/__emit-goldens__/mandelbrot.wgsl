struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  zoom: f32,
  mouse: vec4<f32>,
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
  let _cse4 = (U.resolution.x / U.resolution.y);
  let _cse3 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * _cse4), ((vo.uv.y * 2.0) - 1.0));
  let _cse0 = vec2<f32>((U.mouse.x / U.resolution.x), (U.mouse.y / U.resolution.y));
  let _cse1 = _cse3.x;
  let _cse2 = _cse3.y;
  let _v0 = (exp((-(U.zoom + ((sin((U.time * 0.2)) * 0.75) + 0.75)))) * 2.4);
  let _v1 = ((vec2<f32>((((_cse0.x * 2.0) - 1.0) * _cse4), ((_cse0.y * 2.0) - 1.0)) * _v0) * U.mouse.w);
  var _v2: vec2<f32> = vec2<f32>(0.0, 0.0);
  var _v3: f32 = 0.0;
  for (var _v4: u32 = 0u; (_v4 < 120u); _v4 = (_v4 + 1u)) {
    if ((dot(_v2, _v2) > 16.0)) {
      break;
    }
    let _lc0 = vec2<f32>((((_cse1 * _v0) - 0.7453) + _v1.x), (((_cse2 * _v0) + 0.1127) + _v1.y));
    _v2 = vec2<f32>((((_v2.x * _v2.x) - (_v2.y * _v2.y)) + _lc0.x), (((_v2.x * _v2.y) * 2.0) + _lc0.y));
    _v3 = (_v3 + 1.0);
  }
  let _v5 = dot(_v2, _v2);
  return vec4<f32>((palette(((((_v3 - log2(max(log2(max(_v5, 1.0001)), 0.0001))) + 1.0) * 0.035) + (U.time * 0.02))) * (1.0 - step(119.5, _v3))), 1.0);
}
