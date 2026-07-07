struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  count: f32,
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
  let _licm0 = U.count;
  let _licm1 = ((vo.uv.x * 2.0) - 1.0);
  let _licm2 = ((vo.uv.y * 2.0) - 1.0);
  let _licm3 = U.time;
  let _licm4 = U.mouse.w;
  let _cse0 = vec2<f32>((U.mouse.x / U.resolution.x), (U.mouse.y / U.resolution.y));
  let _cse1 = (U.resolution.x / U.resolution.y);
  let _cse2 = (_licm3 * 0.03);
  let _v0 = vec2<f32>((((_cse0.x * 2.0) - 1.0) * _cse1), ((_cse0.y * 2.0) - 1.0));
  var _v1: f32 = 0.0;
  var _v2: f32 = 0.0;
  for (var _v3: u32 = 0u; (f32(_v3) < _licm0); _v3 = (_v3 + 1u)) {
    let _lc0 = f32(_v3);
    let _v4 = (vec2<f32>((_licm1 * _cse1), _licm2) - mix(vec2<f32>((sin(((_licm3 * ((_lc0 * 0.13) + 0.5)) + (_lc0 * 2.4))) * 0.55), (cos(((_licm3 * ((_lc0 * 0.11) + 0.4)) + (_lc0 * 1.7))) * 0.42)), _v0, ((1.0 - smoothstep(0.4, 0.6, _lc0)) * _licm4)));
    let _v5 = (0.055 / (dot(_v4, _v4) + 0.003));
    _v1 = (_v1 + _v5);
    _v2 = (_v2 + (_v5 * f32(_v3)));
  }
  let _lc1 = palette((((_v2 / max(_v1, 0.0001)) * 0.15) + _cse2));
  return vec4<f32>(mix((vec3<f32>(0.03, 0.04, 0.08) + (_lc1 * (_v1 * 0.08))), _lc1, smoothstep(0.95, 1.15, _v1)), 1.0);
}
