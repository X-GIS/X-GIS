// ═══ Shader Variant Generator: types ═══
// Top-level type/interface declarations extracted from shader-gen.ts.
// Public `ShaderVariant` is re-exported from shader-gen.ts so existing
// importers (emit-commands.ts, index.ts) resolve unchanged. The
// internal `ColorResult` / `OpacityResult` shapes are imported back
// into shader-gen.ts only.

import type { NodeLike } from './node-types'
import type { ConstDecl, BindingDecl, FuncDecl } from '@xgis/shader-dsl'

/** The compiler-side preamble fragment merged into the runtime polygon module.
 *  Mirrors the runtime `ShaderVariantInfo.preamble` shape
 *  (`Partial<Pick<ModuleDecl, 'consts'|'bindings'|'funcs'>>`) so the runtime
 *  spreads the arrays directly — no WGSL-string splice. */
export interface PreambleModule {
  consts?: readonly ConstDecl[]
  bindings?: readonly BindingDecl[]
  funcs?: readonly FuncDecl[]
}

/**
 * A specialized shader variant for a layer.
 */
export interface ShaderVariant {
  /** Cache key — layers with identical keys share a pipeline */
  key: string
  /** Module-shape fragment (consts / bindings / funcs) the runtime polygon
   *  composer spreads into the base module. Replaces the former WGSL string +
   *  post-emit regex splice: the compiler now authors every specialized const
   *  (FILL_COLOR / STROKE_COLOR / OPACITY / CAT_PALETTE), palette binding, and
   *  the scalar-sample helper as IR decls. */
  preamble: PreambleModule
  /** Fill-color expression as a DSL Node, or `null` for the default-
   *  uniform placeholder (`fillIsDefault: true` is the typed sentinel).
   *  Authored entirely via the IR builders (no WGSL strings); the runtime
   *  reconstructs it with `new Node(fillExpr.expr)` and the polygon composer
   *  emits it at the fill-return marker. */
  fillExpr: NodeLike<'vec4<f32>'> | null
  /** Stroke-color expression — same migration shape as `fillExpr`. */
  strokeExpr: NodeLike<'vec4<f32>'> | null
  /** Whether a storage buffer is needed for per-feature data */
  needsFeatureBuffer: boolean
  /** Fields needed from feature data (for storage buffer layout) */
  featureFields: string[]
  /** Which uniform fields are still needed (not inlined) */
  uniformFields: string[]
  /** For every field consumed by a `match()` expression, the
   *  AUTHORITATIVE sorted list of string patterns the shader's
   *  if-else chain expects. The runtime must use this list as the
   *  string → integer-ID map when packing the per-feature data
   *  buffer; otherwise the IDs computed from "unique values in this
   *  tile's data" can collide with the shader's compile-time IDs.
   *  Example: shader knows {cemetery,hospital,railway,school}={0,1,
   *  2,3} but a tile with only "school" features would otherwise
   *  encode school=0 — colliding with cemetery's slot in the
   *  shader's if-else chain. */
  categoryOrder: Record<string, string[]>
  /** P3 Step 3 — non-empty when this variant sampled a gradient from
   *  the palette atlas. The runtime uses this signal to:
   *    (a) bind the palette textures + sampler to the variant's
   *        pipeline (Step 3c).
   *    (b) skip the zoom-interpolated CPU resolve path for these
   *        properties (Step 4) — the shader reads the per-zoom
   *        value via textureSampleLevel each frame instead.
   *  Empty when `palette` is omitted from generateShaderVariant or
   *  the node has no zoom-interpolated paint properties. */
  paletteColorGradients: number[]
  /** P3 Step 3c-scalar — non-empty when the variant samples a scalar
   *  gradient (opacity / stroke-width zoom-interpolated). Runtime uses
   *  it to bind the scalar atlas + sampler and skip the per-frame
   *  `resolveNumberShape(...)` CPU eval for the routed axes. */
  paletteScalarGradients: number[]
  /** P3 Step 4 — true when fill's zoom-interpolated colour routed
   *  through `textureSampleLevel`. The bucket-scheduler skips the
   *  per-frame `resolveColorShape(paintShapes.fill, …)` CPU eval
   *  for these axes — the fragment shader reads from the gradient
   *  atlas directly, so the CPU result would be a dead write into
   *  `u.fill_color`. */
  fillUsesPalette: boolean
  /** Stroke counterpart to `fillUsesPalette`. */
  strokeUsesPalette: boolean
  /** True when opacity's zoom-interpolated value routed through the
   *  scalar atlas. The bucket-scheduler skips the per-frame
   *  `resolveNumberShape(paintShapes.opacity, …)` CPU eval and the
   *  paired `u.opacity` writeBuffer when this is set. */
  opacityUsesPalette: boolean
  /** Phase 2.5 US-002 — typed replacement for the runtime's legacy
   *  `fillExpr === 'u.fill_color'` string sentinel check. The runtime
   *  treats this flag as "the variant carries no per-feature fill
   *  override; use the cached uniform color and the skip-fill-draw
   *  optimization". Set true when `fillExpr` is the bare
   *  `'u.fill_color'` placeholder (today emitted by
   *  `node.fill.kind === 'none'`); false on every per-feature /
   *  per-zoom / per-palette fill path that injects its own expression
   *  into the marker substitution. The flag is the migration boundary
   *  for the upcoming `fillExpr: string → Node<vec4<f32>>` field type
   *  switch in US-004 — once `fillExpr` is a Node, the
   *  `=== 'u.fill_color'` string compare on the runtime side no
   *  longer compiles, but `!variant.fillIsDefault` keeps working. */
  fillIsDefault: boolean
  /** Stroke counterpart to `fillIsDefault`. */
  strokeIsDefault: boolean
  /** P4-5 — populated by `mergeComputeAddendumIntoVariant` when the
   *  fill / stroke axis routed through a compute kernel. Each entry
   *  is `(paintAxis, bindGroup, binding)` so the runtime can detect
   *  "this variant needs the compute bind-group layout" via existence
   *  + iterate to attach the right `TileComputeResources.getOutBuffer`
   *  per binding without re-parsing the preamble. Absent on legacy
   *  variants and on variants whose computePlan filter returned
   *  empty for this show. */
  computeBindings?: readonly import('./compute-output-binding').ComputeOutputBindingSpec[]
}

export interface ColorResult {
  /** Module-level const declarations this colour path needs (FILL/STROKE_COLOR
   *  or CAT_PALETTE). Empty for paths that inline / reference a uniform. */
  preamble: ConstDecl[]
  isConst: boolean
  /** The colour as a vec4 DSL Node — set by every vec4 colour arm (constant,
   *  categorical, gradient, scale, match, palette, uniform). The top level
   *  composes it with opacity via `composeFillVec4(nodeExpr, opacity.nodeExpr)`.
   *  Mutually exclusive with `scalarNodeExpr` (the greyscale scalar path). */
  nodeExpr?: NodeLike<'vec4<f32>'>
  /** Set by the scalar data-driven (grayscale) arm — the f32 value Node.
   *  Composed into `vec4(s, s, s, opacity)` at the top level (the colour is
   *  greyscale: the scalar drives r=g=b and opacity drives alpha), so it can't
   *  go through `composeFillVec4`'s `.rgb`/`.a` path like a vec4 colour. */
  scalarNodeExpr?: NodeLike<'f32'>
  /** Index into `palette.colorGradients` when this result was routed
   *  through the textureSampleLevel path. Undefined for every legacy
   *  path (constant, time-interpolated, data-driven, conditional). */
  paletteGradientIdx?: number
  needsFeatures: boolean
  /** Set only by the `match()` arm — the matchExpr Node (identical to
   *  `nodeExpr`). The variant cache key hashes its structural JSON via
   *  `matchArmsKey` so two compounds over the same field with different
   *  value→colour mappings hash to distinct pipelines. Undefined for every
   *  non-match path, keeping their cache-key bytes unchanged. */
  matchNode?: NodeLike<'vec4<f32>'>
  /** field → ordered list of patterns the if-else chain expects. The
   *  runtime uses this to assign matching integer IDs into the per-
   *  feature data buffer. Without this, IDs would be derived from
   *  the data's unique values (alphabetical), which collide with the
   *  shader's compile-time pattern order whenever the data is a
   *  proper subset of the patterns. */
  categoryOrder?: Record<string, string[]>
}

export interface OpacityResult {
  /** Module-level const declarations (OPACITY). Empty for the uniform path. */
  preamble: ConstDecl[]
  needsUniform: boolean
  needsFeatures: boolean
  /** Phase 2.5 US-005 — set by arms that have migrated to DSL Node
   *  construction. Mirrors ColorResult.nodeExpr — see that doc. */
  nodeExpr?: NodeLike<'f32'>
  /** Set when this opacity is `zoom-interpolated` AND a matching
   *  scalar gradient was collected into the palette pool. Variant
   *  caller pushes onto `paletteScalarGradients` so the runtime can
   *  skip the per-frame `u.opacity` CPU write. */
  paletteScalarIdx?: number
}
