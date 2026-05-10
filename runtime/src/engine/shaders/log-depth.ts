// ═══ Logarithmic Depth Buffer (Three.js-equivalent for WebGPU) ═══
//
// Three.js's `logarithmicDepthBuffer` distributes 24-bit depth precision
// logarithmically in view-space distance. Under standard perspective depth
// the near half of the frustum hogs precision while the far half collapses
// — at pitch 85° X-GIS currently gets only ~10 effective depth bits near
// the far plane, which z-fights point markers and constrains camera zoom.
//
// Log depth fixes this with:
//   1. Vertex stage: write z_clip = log2(w+1) * fc * w
//      (the *w multiplies out perspective division later)
//   2. Fragment stage: override `@builtin(frag_depth)` per pixel
//      (linear interpolation of a non-linear function across triangles
//       would drift otherwise)
//
// WebGPU differences from GLSL:
//   - WGSL has `@builtin(frag_depth)` in core — no extension needed.
//   - Clip-space z range is [0, 1] (D3D-style), not GL's [-1, 1]. The
//     constant `fc` therefore drops GL's `-1.0` offset and `* 0.5` scaling.
//
// CPU side computes `fc = 1 / log2(far + 1)` once per frame from the
// camera's far plane and packs it into the existing uniform ring (reusing
// the old DSFUN _pad0 slot — no layout growth).

/** WGSL snippet: log-depth helper functions. Embed via template literal
 *  in every perspective-projected shader (POLYGON, LINE, POINT, RASTER). */
export const WGSL_LOG_DEPTH_FNS = /* wgsl */ `
// log-depth: adjust clip-space z so depth is logarithmic in view-space w.
// fc = 1.0 / log2(cam_far + 1.0), supplied via uniform each frame.
// The vertex shader multiplies by pos.w to pre-cancel the subsequent
// perspective division — the rasterizer linearly interpolates w, not z,
// so after division the interpolated z is the raw log2 value.
fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32> {
  let z = log2(max(1e-6, pos.w + 1.0)) * fc * pos.w;
  return vec4<f32>(pos.x, pos.y, z, pos.w);
}

// Fragment-stage per-pixel log-depth. view_w is the vertex shader's
// pre-division position.w passed as a varying. Result must be written to
// @builtin(frag_depth) so rasterizer interpolation of z is overridden.
fn compute_log_frag_depth(view_w: f32, fc: f32) -> f32 {
  return log2(max(1e-6, view_w + 1.0)) * fc;
}
`

/** CPU-side factor computation — exported for tests and for the uniform
 *  pack path in every renderer. Matches the shader exactly. */
export function computeLogDepthFc(far: number): number {
  return 1 / Math.log2(far + 1)
}

/** Simulate the vertex-stage log-depth transform on the CPU side. Used
 *  by tests to prove monotonicity + bounds without a GPU. */
export function simulateLogDepthZ(viewW: number, far: number): number {
  const fc = computeLogDepthFc(far)
  const pre = Math.log2(Math.max(1e-6, viewW + 1)) * fc * viewW
  // Perspective division happens in the rasterizer: z_ndc = z_clip / w_clip
  return pre / viewW
}
