// ═══ Which data-driven fills the RHI path will draw, and which it hands back (#1592) ═══
//
// `rhiVariantFillSupported` is the fence between two very different outcomes, and it is the ONE
// place that decides: true and the renderer builds a variant Material and draws; false and it
// takes #1583's bail, which warns by name and paints nothing. Both are acceptable answers. What
// is not acceptable is the fence saying true for a variant whose Material would be built without
// a resource its shader reads — a palette-sampling variant gets a bind group with no atlas at
// bindings 2/4, which fails to LINK rather than drawing wrong, so the layer dies with a pipeline
// error instead of the warning it was supposed to get.
//
// So this pins the fence in BOTH directions. The positive case (a plain `match()` over a feature
// field) is what the render gate then proves end to end on a real WebGL2 context; the negative
// cases are the ones a render gate cannot reach, because the styles that produce them are exactly
// the styles that would break the harness.

import { describe, it, expect } from 'vitest'
import type { ShaderVariant } from '@xgis/compiler'
import { varRefVec4 } from '@xgis/compiler'
import { rhiVariantFillSupported } from './rhi-fill-variant'

function variant(opts: Partial<ShaderVariant>): ShaderVariant {
  return {
    key: 'k',
    preamble: {},
    fillExpr: varRefVec4('u.fill_color'),
    strokeExpr: varRefVec4('u.stroke_color'),
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: [],
    categoryOrder: {},
    paletteScalarGradients: [],
    opacityUsesPalette: false,
    fillIsDefault: true,
    strokeIsDefault: true,
    fillIsStage: false,
    strokeIsStage: false,
    ...opts,
  }
}

/** `fill match(.kind)` — the shape the render gate drives: a composed fill expression reading a
 *  per-feature field, and nothing else. */
const matchFill = (opts: Partial<ShaderVariant> = {}): ShaderVariant =>
  variant({
    fillIsDefault: false,
    fillExpr: varRefVec4('_mcL1'),
    needsFeatureBuffer: true,
    featureFields: ['kind'],
    categoryOrder: { kind: ['a', 'b', 'c'] },
    ...opts,
  })

describe('rhiVariantFillSupported — what the RHI variant path will draw (#1592)', () => {
  it('draws a plain match() fill over a feature field', () => {
    expect(rhiVariantFillSupported(matchFill())).toBe(true)
  })

  it('declines a show with no variant, and one whose fill is the default uniform', () => {
    // Not a rejection so much as "there is nothing here to compose": the plain fill Material
    // already draws both, and routing them through the variant path would build a second
    // identical program per layer.
    expect(rhiVariantFillSupported(null)).toBe(false)
    expect(rhiVariantFillSupported(undefined)).toBe(false)
    expect(rhiVariantFillSupported(variant({}))).toBe(false)
  })

  it('declines a variant that reduces to the base shader', () => {
    // `fillIsDefault: false` alone is not enough — with no preamble and no feature buffer,
    // toComposerVariant returns null and the emit IS the base shader. Drawing it here would
    // build a duplicate of the plain Material under a variant key.
    expect(rhiVariantFillSupported(variant({ fillIsDefault: false }))).toBe(false)
  })

  it('declines a SCALAR-gradient variant — that atlas cannot cross the RHI seam', () => {
    // The only palette arm left after #1661. It is not a wiring gap that could be closed by
    // binding harder: the scalar atlas is r32float, which `RhiTextureFormat` does not carry,
    // and WebGL2 cannot filter r32float without OES_texture_float_linear. A zoom-interpolated
    // COLOUR no longer reaches this fence at all — it resolves on the CPU into
    // `u.fill_color` and samples nothing.
    expect(rhiVariantFillSupported(matchFill({ paletteScalarGradients: [0] }))).toBe(false)
  })

  it('declines a compute-routed variant — its output buffers come from a WebGPU-only dispatcher', () => {
    expect(
      rhiVariantFillSupported(
        matchFill({
          computeBindings: [{ bindGroup: 2, binding: 16, paintAxis: 'fill' }],
        }),
      ),
    ).toBe(false)
  })
})
