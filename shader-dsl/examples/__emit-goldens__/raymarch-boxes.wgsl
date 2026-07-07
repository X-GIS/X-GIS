struct Uniforms {
  time: f32,
  resolution: vec2<f32>,
  speed: f32,
  mouse: vec4<f32>,
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> U: Uniforms;

fn scene(p: vec3<f32>) -> f32 {
  let _v0 = ((p - 2.6 * floor(p / 2.6)) - vec3<f32>(1.3));
  return (length(max((abs(_v0) - vec3<f32>(0.62)), vec3<f32>(0.0, 0.0, 0.0))) - 0.14);
}

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
  let _cse0 = vec2<f32>((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0));
  let _cse1 = vec3<f32>(0.0015, 0.0, 0.0);
  let _cse2 = vec3<f32>(0.0, 0.0015, 0.0);
  let _cse3 = vec3<f32>(0.0, 0.0, 0.0015);
  let _v0 = vec3<f32>((sin((U.time * 0.23)) * 0.4), (cos((U.time * 0.2)) * 0.4), (-(U.time * U.speed)));
  let _v1 = normalize(vec3<f32>(_cse0.x, _cse0.y, -1.6));
  let _v2 = ((((U.mouse.x / U.resolution.x) - 0.5) * 1.6) * U.mouse.w);
  let _v3 = (((U.mouse.y / U.resolution.y) - 0.5) * U.mouse.w);
  let _v4 = cos(_v2);
  let _v5 = sin(_v2);
  let _v6 = cos(_v3);
  let _v7 = sin(_v3);
  let _v8 = ((_v1.x * _v4) + (_v1.z * _v5));
  let _v9 = ((_v1.z * _v4) - (_v1.x * _v5));
  let _v10 = ((_v1.y * _v6) - (_v9 * _v7));
  let _v11 = ((_v9 * _v6) + (_v1.y * _v7));
  let _v12 = vec3<f32>(_v8, _v10, _v11);
  var _av0: f32 = 0.0;
  var _av1: f32 = 0.0;
  for (var _v13: u32 = 0u; (_v13 < 90u); _v13 = (_v13 + 1u)) {
    let _v14 = scene((_v0 + (_v12 * _av1)));
    if ((_v14 < 0.002)) {
      _av0 = 1.0;
      break;
    }
    _av1 = (_av1 + (_v14 * 0.9));
    if ((_av1 > 30.0)) {
      break;
    }
  }
  let _v15 = (vec3<f32>(0.04, 0.05, 0.09) + (vec3<f32>(0.02, 0.04, 0.08) * vo.uv.y));
  var _av2: vec3<f32> = (_v15 + vec3<f32>(0.0, 0.0, 0.0));
  if ((_av0 > 0.5)) {
    let _v16 = (_v0 + (_v12 * _av1));
    let _v17 = normalize(vec3<f32>((scene((_v16 + _cse1)) - scene((_v16 - _cse1))), (scene((_v16 + _cse2)) - scene((_v16 - _cse2))), (scene((_v16 + _cse3)) - scene((_v16 - _cse3)))));
    let _lc0 = floor((_v16 / 2.6));
    _av2 = mix(_v15, (palette(fract((sin((((_lc0.x * 12.9898) + (_lc0.y * 78.233)) + (_lc0.z * 37.719))) * 43758.5453))) * ((max(dot(_v17, normalize(vec3<f32>(0.5, 0.8, 0.3))), 0.0) * 0.8) + 0.16)), exp((-(_av1 * 0.09))));
  }
  return vec4<f32>(_av2, 1.0);
}
