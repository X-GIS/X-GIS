export type { ShaderVariant } from './shader-gen'
// Permanent codegen Node vocabulary. `NodeLike` is the compiler↔runtime seam
// type; `varRefVec4` builds a `vec4<f32>` varref Node — the public way to author
// a placeholder fill/stroke expression (e.g. runtime variant test fixtures),
// replacing the removed `wgslRaw` rawString escape hatch.
export { type NodeLike } from './node-types'
export { varRefVec4 } from './_util/node-builders'
// The camera-zoom uniform read every generated expression uses (`u.zoom`, #1635).
// Exported so map's host shaders gate on the name they must DECLARE rather than a
// re-typed literal — the compiler emits it as plain TEXT, so nothing else ties the
// two together (mirrors INPUT_F32_POOL_SIZE / polygon-input-pool.test.ts, #1539).
export { ZOOM_UNIFORM_REF } from './_util/node-builders'
// The auto-categorical palette length — the bound `categorical(field)` wraps at
// (`CAT_PALETTE[u32(field) % CAT_PALETTE_SIZE]`, shader-gen.ts:287/:406). Exported
// for the same reason ZOOM_UNIFORM_REF above is: the RUNTIME needs to compare a
// distinct-category count against it, and a re-typed 20 on that side would
// re-create exactly the duplicated magic number #724 shipped a fix to remove.
export { CAT_PALETTE_SIZE } from './categorical-encoder'
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
// Pure palette→texture packing + zoom-stop gradient evaluation (#929 A —
// style-domain math relocated from @xgis/rhi-webgpu; the adapter keeps only
// the GPU upload of the PackedPalette produced here).
export {
  GRADIENT_WIDTH,
  GRADIENT_META_STRIDE_F32,
  evalColorGradientAt,
  evalScalarGradientAt,
  packPalette,
} from './palette-pack'
export type { PackedPalette } from './palette-pack'
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
export { buildComputeVariantAddendum, FRAGMENT_FEAT_ID_EXPR } from './compute-variant'
export type { ComputeVariantAddendum } from './compute-variant'
export { mergeComputeAddendumIntoVariant } from './compute-variant-merge'
export { buildPerShowMergedVariant } from './compute-variant-build'
