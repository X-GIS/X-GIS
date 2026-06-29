export type { ShaderVariant } from './shader-gen'
// Permanent codegen Node vocabulary. `NodeLike` is the compiler↔runtime seam
// type; `varRefVec4` builds a `vec4<f32>` varref Node — the public way to author
// a placeholder fill/stroke expression (e.g. runtime variant test fixtures),
// replacing the removed `wgslRaw` rawString escape hatch.
export { type NodeLike } from './node-types'
export { varRefVec4 } from './_util/node-builders'
// Field-name extraction for an expression AST. Reused by the runtime's
// show-source-maps to compute the minimal per-slice featureProps key set
// (label text-field + data-driven paint fields) so the MVT worker clones
// only the consumed properties across the worker→main boundary.
// collectFields: GPU paint path — do NOT change; variant drift gate depends on it.
// collectFieldsStrict: runtime label/icon filter path — conservative, returns
//   null on any unrecognised node so callers fall back to full props safely.
export { collectFields, collectFieldsStrict } from './wgsl-expr'
export { nodeToWgslString } from './node-to-wgsl'
export { collectPalette, emptyPalette } from './palette'
export type { Palette, ColorGradient, ScalarGradient } from './palette'
export {
  COMPUTE_WORKGROUP_SIZE,
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
  emitInterpolateComputeKernel,
} from './compute-gen'
export type {
  ComputeKernel,
  MatchArmSpec,
  MatchEmitSpec,
  TernaryBranchSpec,
  TernaryEmitSpec,
  InterpolateStopSpec,
  InterpolateEmitSpec,
} from './compute-gen'
export { planComputeKernels } from './compute-plan'
export type { ComputePlanEntry, PaintAxis } from './compute-plan'
export {
  emitComputeOutputReadExpr,
  makeComputeOutputBindGroupEntry,
} from './compute-output-binding'
export type {
  ComputeOutputPaintAxis,
  ComputeOutputBindingSpec,
  ComputeOutputBindGroupEntry,
} from './compute-output-binding'
export {
  buildComputeVariantAddendum,
  FRAGMENT_FEAT_ID_EXPR,
} from './compute-variant'
export type { ComputeVariantAddendum } from './compute-variant'
export { mergeComputeAddendumIntoVariant } from './compute-variant-merge'
export { buildPerShowMergedVariant } from './compute-variant-build'
