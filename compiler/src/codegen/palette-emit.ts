// ═══════════════════════════════════════════════════════════════════
// Palette WGSL emission helpers
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 3 step 3a (wild-finding-starlight). Pure WGSL string
// builders that translate the compile-time `Palette`
// (compiler/src/codegen/palette.ts) into:
//
//   - Storage / texture / sampler binding declarations the variant
//     fragment shader needs to sample the atlases produced by
//     P3.2's `uploadPalette`.
//   - Per-call-site sample expressions:
//       textureSampleLevel(grad, samp, vec2f(uCoord, vCoord), 0)
//     where `uCoord` resolves `(zoom - zMin) / (zMax - zMin)` and
//     `vCoord` is the gradient's row index in the atlas (0.5-pixel
//     centred).
//
// What this module produces is pure text. Step 3b splices the
// output into `generateShaderVariant`'s `processColorValue` so a
// zoom-interpolated paint property emits the gradient sample call
// instead of falling through to `u.fill_color`. Step 3c
// (runtime side) wires up the actual GPUBindGroup that owns the
// textures.
//
// Why text helpers (vs an AST representation):
//
//   - shader-gen.ts already concatenates strings to build the
//     fragment shader. Returning more strings keeps the integration
//     point flat (one `replace()` per call site).
//   - The output is small (one binding block + one expression per
//     gradient) so a manual string concat is more readable than a
//     full WGSL AST builder.
//   - Tests assert on the emitted text directly — no semantic
//     diff infrastructure needed.
//
// What this module does NOT do:
//
//   - Decide WHEN to emit gradient samples. That's shader-gen's job
//     in Step 3b — it inspects the ColorValue / PropertyShape kind
//     and routes to `emitColorGradientSample` only for
//     `zoom-interpolated` deps. Anything else (constant, data-
//     driven, time-interpolated) keeps its existing path.

import type { Palette } from './palette'

/** Default bind-group / binding indices for palette resources. The
 *  current renderer uses group 0 for everything; once P2 lands the
 *  4-tier hierarchy these move to tier-0 (device-lifetime). Each
 *  emission call accepts overrides for forward-compat. */
export interface PaletteBindingSlots {
  /** Bind group index. Default 0 (current 2-tier scheme). */
  group: number
  /** Binding for `color_grad_atlas` (texture_2d<f32>). */
  colorGradientBinding: number
  /** Binding for `scalar_grad_atlas` (texture_2d<f32>, r32float
   *  view). */
  scalarGradientBinding: number
  /** Binding for the shared sampler (`palette_samp`). */
  samplerBinding: number
}

/** Default slots — chosen to sit AFTER the existing two bindings
 *  (uniforms @binding(0), feat_data @binding(1)) so existing
 *  shader code references stay valid when the palette block is
 *  prepended. Runtime bind-group layout must match this in Step 3c. */
export const DEFAULT_PALETTE_SLOTS: PaletteBindingSlots = {
  group: 0,
  colorGradientBinding: 2,
  scalarGradientBinding: 3,
  samplerBinding: 4,
}

/** WGSL declarations to prepend to a variant fragment shader.
 *  Empty string when the palette has no gradients of either kind —
 *  saves the binding overhead on layers that don't need them.
 *
 *  Note: the underlying GPU textures are 1×1 stubs when the pool is
 *  empty (see `uploadPalette` in palette-texture.ts), so emitting
 *  the declarations even with zero gradients is technically safe.
 *  Skipping them keeps the WGSL minimal and the bind-group layout
 *  small — both matter for compile time. */
export function emitPaletteBindings(
  palette: Palette,
  slots: PaletteBindingSlots = DEFAULT_PALETTE_SLOTS,
): string {
  // P3 Step 3c: scalar gradient atlas binding (binding 3) is NOT
  // emitted yet — the runtime bind-group layout only includes the
  // color atlas + sampler (binding 2 + 4). Scalar zoom-interpolated
  // paint values (line widths, sizes, opacity stops) keep using the
  // legacy CPU resolve → uniform path until r32float-vs-filterable
  // support lands. Until then, ANY scalar declaration would trigger
  // `Binding doesn't exist in [mr-baseBindGroupLayout]` validation
  // on every pipeline that emits the variant shader.
  const hasColor = palette.colorGradients.length > 0
  if (!hasColor) return ''

  const lines: string[] = ['']
  lines.push('// ── Palette bindings (zoom-stop gradients) ──')
  lines.push(
    `@group(${slots.group}) @binding(${slots.colorGradientBinding}) `
    + `var color_grad_atlas: texture_2d<f32>;`,
  )
  // Shared sampler — linear filter + clampToEdge (configured on the
  // GPU side in renderer.ts). HW interp smooths the inter-texel
  // residual without bleeding past the row edges.
  lines.push(
    `@group(${slots.group}) @binding(${slots.samplerBinding}) `
    + `var palette_samp: sampler;`,
  )
  lines.push('')
  return lines.join('\n')
}

/** WGSL expression to sample a color gradient at the current camera
 *  zoom. The caller is responsible for ensuring `gradientIndex` is
 *  within `palette.colorGradients`, the `zoom` identifier is in
 *  scope (the renderer's standard practice: pass `u.zoom` or
 *  `camera.zoom`), and the texture/sampler bindings are present.
 *
 *  Math:
 *    u = clamp((zoom - zMin) / (zMax - zMin), 0, 1)
 *    v = (gradientIndex + 0.5) / gradientCount
 *  zMin / zMax come from the gradient's own stop range; bakedin
 *  via JS-side literal substitution so the shader is free of an
 *  additional uniform-buffer lookup. */
export function emitColorGradientSample(
  palette: Palette,
  gradientIndex: number,
  zoomExpr: string = 'u.zoom',
): string {
  const g = palette.colorGradients[gradientIndex]
  if (!g) {
    // Shouldn't happen — defensive: out-of-range emits the same
    // zero-uniform as the legacy fallback so a downstream error
    // still produces correct pixels (just not the requested
    // gradient).
    return 'vec4f(0.0, 0.0, 0.0, 0.0)'
  }
  const stops = g.stops
  const zMin = stops[0]!.zoom
  const zMax = stops[stops.length - 1]!.zoom
  const total = palette.colorGradients.length
  const v = (gradientIndex + 0.5) / total
  // Pre-bake zMin/zMax/v as literals — no extra uniform read,
  // matches how constant-color FILL_COLOR is inlined elsewhere.
  return (
    `textureSampleLevel(color_grad_atlas, palette_samp, vec2f(`
    + `clamp((${zoomExpr} - ${fmtF(zMin)}) / ${fmtF(zMax - zMin || 1)}, 0.0, 1.0), `
    + `${fmtF(v)}), 0.0)`
  )
}

/** Same as `emitColorGradientSample` but reads from the r32float
 *  scalar atlas. Returns an `f32` expression. */
export function emitScalarGradientSample(
  palette: Palette,
  gradientIndex: number,
  zoomExpr: string = 'u.zoom',
): string {
  const g = palette.scalarGradients[gradientIndex]
  if (!g) return '0.0'
  const stops = g.stops
  const zMin = stops[0]!.zoom
  const zMax = stops[stops.length - 1]!.zoom
  const total = palette.scalarGradients.length
  const v = (gradientIndex + 0.5) / total
  // textureSampleLevel of an r32float returns vec4f with the value
  // in `.r`; the .r unpacks it to f32.
  return (
    `textureSampleLevel(scalar_grad_atlas, palette_samp, vec2f(`
    + `clamp((${zoomExpr} - ${fmtF(zMin)}) / ${fmtF(zMax - zMin || 1)}, 0.0, 1.0), `
    + `${fmtF(v)}), 0.0).r`
  )
}

/** Format an f32 literal the same way shader-gen.ts does — trims
 *  trailing zeros, keeps decimal point. Local copy to avoid a
 *  circular import. */
function fmtF(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return n.toString()
}
