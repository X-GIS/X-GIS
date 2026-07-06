struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  count: f32,
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
  let _licm0 = U.count;
  let _licm1 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  let _licm2 = U.time;
  let _cse0 = (_licm2 * 0.03);
  var _v0: f32 = 0.0;
  var _v1: f32 = 0.0;
  for (var _v2: u32 = 0u; (f32(_v2) < _licm0); _v2 = (_v2 + 1u)) {
    let _lc0 = f32(_v2);
    let _v3 = (_licm1 - vec2<f32>((sin(((_licm2 * ((_lc0 * 0.13) + 0.5)) + (_lc0 * 2.4))) * 0.55), (cos(((_licm2 * ((_lc0 * 0.11) + 0.4)) + (_lc0 * 1.7))) * 0.42)));
    let _v4 = (0.055 / (dot(_v3, _v3) + 0.003));
    _v0 = (_v0 + _v4);
    _v1 = (_v1 + (_v4 * f32(_v2)));
  }
  let _lc1 = palette((((_v1 / max(_v0, 0.0001)) * 0.15) + _cse0));
  return vec4<f32>(mix((vec3<f32>(0.03, 0.04, 0.08) + (_lc1 * (_v0 * 0.08))), _lc1, smoothstep(0.95, 1.15, _v0)), 1.0);
}
