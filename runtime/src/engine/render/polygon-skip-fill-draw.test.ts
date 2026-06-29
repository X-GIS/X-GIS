// ═══════════════════════════════════════════════════════════════════
// Polygon skip-fill-draw — Phase 2.5 US-002 sentinel flag migration
// ═══════════════════════════════════════════════════════════════════
//
// The runtime's skip-fill-draw fast path lets a layer with no fill
// (or a fill with effectively-zero alpha) bypass the polygon draw call
// entirely. Pre-Phase-2.5 the predicate was a string compare:
//   variant.fillExpr !== 'u.fill_color'   ← legacy sentinel
// US-002 migrates that to a typed boolean flag on ShaderVariant:
//   !variant.fillIsDefault                ← new sentinel
// This test pins the predicate's behavioural contract so the upcoming
// `fillExpr: string → Node<vec4<f32>>` type migration in US-004 can
// land without accidentally regressing the skip-fill-draw optimisation
// (the migration would silently break the legacy compare since a Node
// is never `=== 'u.fill_color'`).

import { describe, it, expect } from 'vitest'
import { variantProducesFill } from './renderer-helpers'
import type { ShaderVariant } from '@xgis/compiler'
import { varRefVec4 } from '@xgis/compiler'

function v(opts: Partial<ShaderVariant>): ShaderVariant {
  return {
    key: 'k', preamble: {}, fillExpr: varRefVec4('u.fill_color'), strokeExpr: varRefVec4('u.stroke_color'),
    needsFeatureBuffer: false, featureFields: [], uniformFields: [],
    categoryOrder: {}, paletteColorGradients: [], paletteScalarGradients: [],
    fillUsesPalette: false, strokeUsesPalette: false, opacityUsesPalette: false,
    fillIsDefault: true, strokeIsDefault: true,
    ...opts,
  }
}

// Mirror of vector-tile-renderer.ts:_skipFillDraw — bundled in this
// test so the boolean shape is asserted directly against the
// production predicate (which is the variantProducesFill() import).
function skipFillDraw(variant: ShaderVariant | null | undefined, cachedAlpha: number): boolean {
  return !variantProducesFill(variant) && cachedAlpha <= 0.005
}

describe('polygon skip-fill-draw — sentinel flag (US-002)', () => {
  it('no variant + zero alpha → SKIP (legacy default)', () => {
    expect(variantProducesFill(null)).toBe(false)
    expect(skipFillDraw(null, 0)).toBe(true)
  })

  it('default variant (fillIsDefault=true) + zero alpha → SKIP', () => {
    const def = v({ fillIsDefault: true })
    expect(variantProducesFill(def)).toBe(false)
    expect(skipFillDraw(def, 0)).toBe(true)
  })

  it('non-default variant (data-driven match) + zero alpha → DRAW (variant produces the colour)', () => {
    const dd = v({ fillIsDefault: false, fillExpr: varRefVec4('_mcL1') })
    expect(variantProducesFill(dd)).toBe(true)
    expect(skipFillDraw(dd, 0)).toBe(false)
  })

  it('default variant + non-zero alpha → DRAW (uniform colour wins)', () => {
    const def = v({ fillIsDefault: true })
    expect(skipFillDraw(def, 1)).toBe(false)
  })

  it('non-default variant + non-zero alpha → DRAW (variant + uniform both contribute)', () => {
    const dd = v({ fillIsDefault: false, fillExpr: varRefVec4('textureSampleLevel(...)') })
    expect(skipFillDraw(dd, 1)).toBe(false)
  })

  it('alpha exactly 0.005 (boundary, inclusive) → SKIP with default variant', () => {
    const def = v({ fillIsDefault: true })
    expect(skipFillDraw(def, 0.005)).toBe(true)
  })

  it('alpha just above 0.005 → DRAW', () => {
    const def = v({ fillIsDefault: true })
    expect(skipFillDraw(def, 0.006)).toBe(false)
  })
})
