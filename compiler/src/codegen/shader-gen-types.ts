// ═══ Shader Variant Generator: types ═══
// Top-level type/interface declarations extracted from shader-gen.ts.
// Public `ShaderVariant` is re-exported from shader-gen.ts so existing
// importers (emit-commands.ts, index.ts) resolve unchanged. The
// internal `ColorResult` / `OpacityResult` shapes are imported back
// into shader-gen.ts only.

/**
 * A specialized shader variant for a layer.
 */
export interface ShaderVariant {
  /** Cache key — layers with identical keys share a pipeline */
  key: string
  /** WGSL const declarations to prepend to the shader */
  preamble: string
  /** WGSL expression for fill color (replaces `u.fill_color`) */
  fillExpr: string
  /** WGSL expression for stroke color (replaces `u.stroke_color`) */
  strokeExpr: string
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
