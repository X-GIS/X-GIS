struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  density: f32,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn hash(p: vec2<f32>) -> f32 {
  return fract((sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453));
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
  let _licm0 = U.time;
  let _licm1 = vec2<f32>(12.3, 45.6);
  let _licm2 = vec2<f32>(78.9, 1.2);
  let _licm3 = vec3<f32>(0.75, 0.85, 1.0);
  let _licm4 = vec3<f32>(1.0, 0.9, 0.75);
  let _licm5 = (0.92 - (U.density * 0.25));
  let _cse0 = _cse2.x;
  let _cse1 = _cse2.y;
  var _v0: vec3<f32> = vec3<f32>(0.0, 0.0, 0.0);
  for (var _v1: u32 = 0u; (_v1 < 3u); _v1 = (_v1 + 1u)) {
    let _lc0 = f32(_v1);
    let _v2 = floor(((vec2<f32>((_cse0 + (_licm0 * ((_lc0 * 0.014) + 0.01))), _cse1) * ((_lc0 * 14.0) + 18.0)) + (_lc0 * 37.7)));
    let _v3 = hash(_v2);
    let _lc1 = f32(_v1);
    let _v4 = (1.0 - smoothstep(0.0, (0.06 - (_lc1 * 0.012)), distance(fract(((vec2<f32>((_cse0 + (_licm0 * ((_lc1 * 0.014) + 0.01))), _cse1) * ((_lc1 * 14.0) + 18.0)) + (_lc1 * 37.7))), ((vec2<f32>(hash((_v2 + _licm1)), hash((_v2 + _licm2))) * 0.7) + 0.15))));
    _v0 = (_v0 + (mix(_licm3, _licm4, _v3) * ((((_v4 * _v4) * ((sin(((_licm0 * ((_v3 * 4.0) + 2.0)) + (_v3 * 40.0))) * 0.4) + 0.6)) * step(_licm5, _v3)) * (1.0 - (f32(_v1) * 0.25)))));
  }
  let _v5 = (_cse1 + (_cse0 * 0.35));
  return vec4<f32>((_v0 + (vec3<f32>(0.09, 0.11, 0.16) * exp((-((_v5 * _v5) * 6.0))))), 1.0);
}
