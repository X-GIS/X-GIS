// ═══ Shader Variant Generator: types ═══
// Top-level type/interface declarations extracted from shader-gen.ts.
// Public `ShaderVariant` is re-exported from shader-gen.ts so existing
// importers (emit-commands.ts, index.ts) resolve unchanged. The
// internal `ColorResult` / `OpacityResult` shapes are imported back
// into shader-gen.ts only.

import type { NodeLike } from './_back-compat/node-to-wgsl-string'

/**
 * A specialized shader variant for a layer.
 */
export interface ShaderVariant {
  /** Cache key — layers with identical keys share a pipeline */
  key: string
  /** WGSL const declarations to prepend to the shader.
   *  Phase 2.5 — kept as string during the in-flight migration; the
   *  per-idiom Node conversion in US-005 + the polygon DSL composer
   *  in US-007 are the natural points for the `Partial<ModuleDecl>`
   *  shape. Deferred per the plan's rollback option. */
  preamble: string
  /** Fill-color expression as a DSL Node, or `null` for the default-
   *  uniform placeholder (`fillIsDefault: true` is the typed sentinel).
   *  The compiler-side emit sites currently wrap pre-built WGSL strings
   *  via `wgslRaw(...)` so the type can shift without disrupting
   *  per-idiom emit; US-005 rewrites each call site to construct real
   *  Node values via the IR builders. Runtime extracts the WGSL string
   *  via `nodeToWgslString(variant.fillExpr)` at the marker
   *  substitution site until US-008's polygon DSL composer accepts
   *  Node directly. */
  fillExpr: NodeLike<'vec4<f32>'> | null
  /** Stroke-color expression — same migration shape as `fillExpr`. */
  strokeExpr: NodeLike<'vec4<f32>'> | null
  /** WGSL code injected before fill return (match if-else chains) */
  fillPreamble?: string
  /** WGSL code injected before stroke return — analogous to
   *  `fillPreamble` for the stroke entry point. Without this, a
   *  `match()` expression on stroke colour produces an `_mcSS = ...`
   *  if-else chain whose VAR DECLARATION is dropped on the floor
   *  while the `expr` still references the var name → "unresolved
   *  identifier _mc83" at WGSL compile time. */
  strokePreamble?: string
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
  preamble: string[]
  isConst: boolean
  /** Index into `palette.colorGradients` when this result was routed
   *  through the textureSampleLevel path. Undefined for every legacy
   *  path (constant, time-interpolated, data-driven, conditional). */
  paletteGradientIdx?: number
  needsFeatures: boolean
  isVec4: boolean  // true if expr already returns vec4f (categorical/gradient)
  expr: string // WGSL expression for the color
  matchPreamble?: string // if-else chain for match() — injected before return in fragment
  /** field → ordered list of patterns the if-else chain expects. The
   *  runtime uses this to assign matching integer IDs into the per-
   *  feature data buffer. Without this, IDs would be derived from
   *  the data's unique values (alphabetical), which collide with the
   *  shader's compile-time pattern order whenever the data is a
   *  proper subset of the patterns. */
  categoryOrder?: Record<string, string[]>
}

export interface OpacityResult {
  preamble: string[]
  needsUniform: boolean
  needsFeatures: boolean
  expr: string
  /** Set when this opacity is `zoom-interpolated` AND a matching
   *  scalar gradient was collected into the palette pool. Variant
   *  caller pushes onto `paletteScalarGradients` so the runtime can
   *  skip the per-frame `u.opacity` CPU write. */
  paletteScalarIdx?: number
}
