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
  var _v0: vec2<f32> = (vec2<f32>(((vo.uv.x * 2.0) - 1.0), ((vo.uv.y * 2.0) - 1.0)) * U.zoom);
  let _v1 = mix(vec2<f32>(((cos((U.time * 0.31)) * 0.39) - 0.4), (sin((U.time * 0.41)) * 0.39)), vec2<f32>(((((U.mouse.x / U.resolution.x) * 2.0) - 1.0) * 0.8), ((((U.mouse.y / U.resolution.y) * 2.0) - 1.0) * 0.8)), U.mouse.w);
  var _v2: f32 = 0.0;
  for (var _v3: u32 = 0u; (_v3 < 96u); _v3 = (_v3 + 1u)) {
    if ((dot(_v0, _v0) > 4.0)) {
      break;
    }
    _v0 = vec2<f32>((((_v0.x * _v0.x) - (_v0.y * _v0.y)) + _v1.x), (((_v0.x * _v0.y) * 2.0) + _v1.y));
    _v2 = (_v2 + 1.0);
  }
  let _lc0 = (_v2 / 96.0);
  return vec4<f32>((palette((_lc0 + (U.time * 0.05))) * _lc0), 1.0);
}
