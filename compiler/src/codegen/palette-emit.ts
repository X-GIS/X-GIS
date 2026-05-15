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
  // Color and scalar atlases are emitted independently based on what
  // the palette pool collected. The texture type in WGSL is identical
  // (`texture_2d<f32>` in both cases) — the bind-group layout decides
  // sampleType (`float` filterable when the device has
  // `float32-filterable`, `unfilterable-float` otherwise). The scalar
  // sample helper below picks `textureSampleLevel` vs `textureLoad`
  // ×2 + `mix` to match the layout, so the WGSL the compiler emits
  // remains identical across adapters — the variation lives in the
  // helper's body.
  //
  // *** ARCHITECTURE LIMIT — scalar atlas should NOT carry layer-uniform
  // axes (opacity, stroke-width). Those values are constant across every
  // fragment of a single layer's draw, so sampling them per-fragment
  // multiplies their cost by the rendered pixel count. Measured on OFM
  // Bright Seoul z=17 (14 zoom-interp opacity axes routed to scalar
  // atlas, manual interp mode): median frame 7.0 → 37 ms idle, 6.9 →
  // 50 ms zoom — 5-7× regression purely from fragment overhead. The
  // legacy CPU-resolve → uniform path is the correct architecture for
  // layer-uniform scalars: one lerp per layer per frame (~50 ns × 84
  // axes ≈ 4 µs) costs vastly less than per-fragment work at millions
  // of pixels. Scalar sampling is reserved for FUTURE data-driven
  // scalar shapes (varying per feature) — those already route through
  // the P4 compute kernel, not this gradient atlas. */
  const hasColor = palette.colorGradients.length > 0
  const hasScalar = palette.scalarGradients.length > 0
  if (!hasColor && !hasScalar) return ''

  const lines: string[] = ['']
  lines.push('// ── Palette bindings (zoom-stop gradients) ──')
  if (hasColor) {
    lines.push(
      `@group(${slots.group}) @binding(${slots.colorGradientBinding}) `
      + `var color_grad_atlas: texture_2d<f32>;`,
    )
  }
  if (hasScalar) {
    lines.push(
      `@group(${slots.group}) @binding(${slots.scalarGradientBinding}) `
      + `var scalar_grad_atlas: texture_2d<f32>;`,
    )
  }
  // Shared sampler — linear filter + clampToEdge (configured on the
  // GPU side in renderer.ts). HW interp smooths the inter-texel
  // residual without bleeding past the row edges. Bound regardless
  // of which atlases are active so pipelines that sample only the
  // scalar atlas via textureSampleLevel (filterable path) still
  // satisfy the layout.
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

/** Scalar-gradient sample mode. Picked at variant emission by the
 *  runtime based on `GPUContext.float32FilterableSupported`:
 *
 *  - 'filtering' — adapter has `float32-filterable`. Helper body is a
 *    single `textureSampleLevel` against the r32float atlas through
 *    the shared filtering sampler. Bind-group entry uses
 *    `sampleType: 'float'`.
 *
 *  - 'manual' — adapter lacks the feature (iPhone Safari / iPhone
 *    Chrome as of 2026). Helper body does `textureLoad` × 2 +
 *    `mix(a, b, frac)`. Bind-group entry uses
 *    `sampleType: 'unfilterable-float'`. Sampler is not consulted
 *    (textureLoad bypasses it).
 *
 *  Call sites are identical across modes (`xgis_scalar_sample(...)`)
 *  so the shader-gen output remains adapter-agnostic — only the
 *  helper's body and the bind-group layout differ. The "define" is
 *  effectively this `mode` parameter at variant emit time. */
export type ScalarPaletteMode = 'filtering' | 'manual'

/** WGSL helper function that samples a scalar gradient row by index
 *  + per-frame zoom. Emit once per variant alongside the bindings
 *  (after `emitPaletteBindings`). Returns empty when no scalar
 *  gradients exist in the palette — the call site is dead code in
 *  that case and the shader compiles unchanged.
 *
 *  Pre-baked literals: gradient count comes from the palette so the
 *  v-coord math is a literal divide. Per-gradient zMin / zMax are
 *  passed by the caller (`emitScalarGradientSample` inlines them per
 *  call site) to avoid a uniform-buffer indirection. */
export function emitScalarSampleHelper(
  palette: Palette,
  mode: ScalarPaletteMode,
): string {
  if (palette.scalarGradients.length === 0) return ''
  const count = palette.scalarGradients.length
  if (mode === 'filtering') {
    return [
      '',
      '// Scalar gradient sample helper (filterable HW path).',
      'fn xgis_scalar_sample(idx: u32, zoom: f32, zMin: f32, zMax: f32) -> f32 {',
      '  let t = clamp((zoom - zMin) / max(zMax - zMin, 1.0e-6), 0.0, 1.0);',
      `  let v = (f32(idx) + 0.5) / ${fmtF(count)};`,
      '  return textureSampleLevel(scalar_grad_atlas, palette_samp, vec2f(t, v), 0.0).r;',
      '}',
      '',
    ].join('\n')
  }
  // mode === 'manual' — textureLoad ×2 + mix. textureDimensions reads
  // GRADIENT_WIDTH from the atlas; one branch per row pair.
  return [
    '',
    '// Scalar gradient sample helper (manual interp — unfilterable r32float).',
    'fn xgis_scalar_sample(idx: u32, zoom: f32, zMin: f32, zMax: f32) -> f32 {',
    '  let t = clamp((zoom - zMin) / max(zMax - zMin, 1.0e-6), 0.0, 1.0);',
    '  let dims = textureDimensions(scalar_grad_atlas);',
    '  let u = t * f32(dims.x - 1u);',
    '  let u0 = u32(floor(u));',
    '  let u1 = min(u0 + 1u, dims.x - 1u);',
    '  let frac = u - f32(u0);',
    '  let a = textureLoad(scalar_grad_atlas, vec2u(u0, idx), 0).r;',
    '  let b = textureLoad(scalar_grad_atlas, vec2u(u1, idx), 0).r;',
    '  return mix(a, b, frac);',
    '}',
    '',
  ].join('\n')
}

/** Sample a scalar gradient at the current camera zoom. Emits a call
 *  to `xgis_scalar_sample` (declared by `emitScalarSampleHelper`)
 *  with pre-baked zMin / zMax literals so the helper stays a single
 *  shared definition regardless of how many gradient rows the
 *  palette holds. Returns an `f32` expression. */
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
  return `xgis_scalar_sample(${gradientIndex}u, ${zoomExpr}, ${fmtF(zMin)}, ${fmtF(zMax)})`
}

/** Format an f32 literal the same way shader-gen.ts does — trims
 *  trailing zeros, keeps decimal point. Local copy to avoid a
 *  circular import. */
function fmtF(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return n.toString()
}
