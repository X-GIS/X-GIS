@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<u32>;

@compute @workgroup_size(64)
fn reduce_windows(@builtin(global_invocation_id) gid: vec3<u32>) {
  let _licm0 = (gid.x * 8u);
  if ((gid.x >= params.x)) {
    return;
  }
  var _v0: f32 = 0.0;
  for (var _v1: u32 = 0u; (_v1 < 8u); _v1 = (_v1 + 1u)) {
    _v0 = (_v0 + input[(_licm0 + _v1)]);
  }
  output[gid.x] = _v0;
}
