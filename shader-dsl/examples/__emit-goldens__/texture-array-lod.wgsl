struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var atlas: texture_2d_array<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;

@vertex
fn vs_full(@builtin(vertex_index) idx: u32) -> VsOut {
  var _av0: vec2<f32> = vec2<f32>(-1.0, -1.0);
  if ((idx == 1u)) {
    _av0 = vec2<f32>(3.0, -1.0);
  } else if ((idx == 2u)) {
    _av0 = vec2<f32>(-1.0, 3.0);
  }
  return VsOut(vec4<f32>(_av0, 0.0, 1.0), vec2<f32>(((_av0.x + 1.0) * 0.5), ((_av0.y + 1.0) * 0.5)));
}

@fragment
fn fs_atlas(vo: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>((mix(textureSample(atlas, atlas_sampler, vo.uv, 0).rgb, textureSampleLevel(atlas, atlas_sampler, vo.uv, 1, 2.0).rgb, vo.uv.x) * textureLoad(atlas, vec2<i32>(0, 0), 0, 0u).w), 1.0);
}
