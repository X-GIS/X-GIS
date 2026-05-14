// ═══════════════════════════════════════════════════════════════════
// Fragment-side read path for compute-evaluated paint values
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 first sub-piece. The compute kernels we ship in
// P4-1..4 produce per-feature RGBA8 packed into a u32 storage
// buffer. The fragment shader's job is to read that u32 at the
// feature's `feat_id` and unpack to a vec4<f32>.
//
// Two emit helpers — both pure strings, no IR / GPU coupling:
//
//   - emitComputeOutputBindingDecl(spec)
//       → "@group(N) @binding(M) var<storage, read> compute_out_<axis>: array<u32>;"
//   - emitComputeOutputReadExpr(spec, fidExpr)
//       → "unpack4x8unorm(compute_out_<axis>[<fidExpr>])"
//
// And the matching bind-group entry shape so the runtime can
// build a GPUBindGroupLayout with the right binding type +
// visibility flags:
//
//   - makeComputeOutputBindGroupEntry(spec)
//       → { binding, visibility: FRAGMENT, buffer: { type: 'read-only-storage' } }
//
// The triple stays consistent because all three derive from the
// same `ComputeOutputBindingSpec`. A drift between WGSL decl and
// runtime layout is exactly the kind of bug that surfaces at
// pipeline-create time with an unhelpful "binding mismatch" error;
// keeping the source in one place avoids it.

/** Which paint axis the compute output evaluates. Two-state union
 *  matches the rest of the P4 plan; future axes (opacity, stroke
 *  width as a scalar) would need a separate emitter because they
 *  don't produce packed RGBA. */
export type ComputeOutputPaintAxis = 'fill' | 'stroke-color'

/** Inputs for the three emitters. `bindGroup` + `binding` are
 *  whatever slot the runtime picks for this buffer — typically a
 *  new tier added to the per-feature bind group, but the emitter
 *  doesn't enforce a specific layout. */
export interface ComputeOutputBindingSpec {
  paintAxis: ComputeOutputPaintAxis
  bindGroup: number
  binding: number
}

/** Map paint axis to the WGSL variable name. Two distinct names so
 *  fill + stroke-color can both bind in the same shader without
 *  collision. The names are intentionally NOT user-configurable —
 *  the read-expression emitter generates references to them, so any
 *  change ripples through both helpers. */
function varNameFor(axis: ComputeOutputPaintAxis): string {
  return axis === 'fill' ? 'compute_out_fill' : 'compute_out_stroke'
}

/** Emit the WGSL bind declaration line. Goes into the shader
 *  variant's preamble insertion point alongside other @group/@binding
 *  declarations. The buffer holds one u32 per feature
 *  (pack4x8unorm-encoded RGBA8). */
export function emitComputeOutputBindingDecl(spec: ComputeOutputBindingSpec): string {
  const name = varNameFor(spec.paintAxis)
  return `@group(${spec.bindGroup}) @binding(${spec.binding}) var<storage, read> ${name}: array<u32>;`
}

/** Emit the WGSL expression that reads + unpacks the per-feature
 *  colour. `fidExpr` is the WGSL fragment that produces the feature
 *  ID at the call site — typically `input.feat_id` in a fragment
 *  shader, but the emitter accepts any string so it can be reused
 *  from synthetic contexts (compute composition, debug overlays).
 *  The output is a `vec4<f32>` matching the legacy fillExpr/
 *  strokeExpr contract, so callers can drop it into
 *  `out.color = …` directly. */
export function emitComputeOutputReadExpr(
  spec: ComputeOutputBindingSpec,
  fidExpr: string,
): string {
  const name = varNameFor(spec.paintAxis)
  return `unpack4x8unorm(${name}[${fidExpr}])`
}

/** Build the GPUBindGroupLayoutEntry descriptor the runtime needs to
 *  create a bind-group layout including this output buffer. The
 *  visibility is FRAGMENT only — vertex shaders never read the
 *  compute output (paint colours don't influence position).
 *
 *  `GPUShaderStage.FRAGMENT` is a runtime-supplied constant
 *  (typically `2`). The pure-module convention is to take it as a
 *  parameter so the compiler doesn't depend on a runtime global,
 *  but a sensible default `2` is provided for callers who don't
 *  need to bridge a typed-WebGPU environment. */
export interface ComputeOutputBindGroupEntry {
  binding: number
  visibility: number
  buffer: { type: 'read-only-storage' }
}

export function makeComputeOutputBindGroupEntry(
  spec: ComputeOutputBindingSpec,
  fragmentVisibilityBit: number = 2,
): ComputeOutputBindGroupEntry {
  return {
    binding: spec.binding,
    visibility: fragmentVisibilityBit,
    buffer: { type: 'read-only-storage' as const },
  }
}
