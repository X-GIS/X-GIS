// ═══ toComposerLineVariant — the ShaderVariantInfo → LineVariantSpec bridge (#1605) ═══
// Table-driven: every rejection case must fall back to null (→ default line
// rendering), never throw; the one acceptance case must produce a populated
// LineVariantSpec with a reconstructed live Node.

import { describe, expect, it } from 'vitest'
import { vec4, f32, Node } from '@xgis/shader-dsl'
import { toComposerLineVariant } from './line-shader-cache'
import type { ShaderVariantInfo } from './renderer-types'

const strokeExprNode = vec4(f32(0.1), f32(0.2), f32(0.3), f32(0.4))

function baseVariant(overrides: Partial<ShaderVariantInfo> = {}): ShaderVariantInfo {
  return {
    key: 'test-key',
    preamble: {},
    fillExpr: null,
    strokeExpr: { expr: strokeExprNode.expr },
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: [],
    categoryOrder: {},
    paletteColorGradients: [],
    paletteScalarGradients: [],
    fillUsesPalette: false,
    strokeUsesPalette: false,
    opacityUsesPalette: false,
    fillIsDefault: true,
    strokeIsDefault: false,
    ...overrides,
  } as ShaderVariantInfo
}

describe('toComposerLineVariant (#1605)', () => {
  it('null variant → null', () => {
    expect(toComposerLineVariant(null)).toBeNull()
    expect(toComposerLineVariant(undefined)).toBeNull()
  })

  it('no strokeExpr → null (default path)', () => {
    expect(toComposerLineVariant(baseVariant({ strokeExpr: null }))).toBeNull()
  })

  it('strokeIsDefault → null even if strokeExpr is set', () => {
    expect(toComposerLineVariant(baseVariant({ strokeIsDefault: true }))).toBeNull()
  })

  it('needsFeatureBuffer → null (Phase 1b, not supported yet)', () => {
    expect(toComposerLineVariant(baseVariant({ needsFeatureBuffer: true }))).toBeNull()
  })

  it('computeBindings present → null (not supported yet)', () => {
    const variant = baseVariant({
      computeBindings: [{ paintAxis: 'stroke', bindGroup: 2, binding: 0 }] as never,
    })
    expect(toComposerLineVariant(variant)).toBeNull()
  })

  it('paletteColorGradients present → null (not supported yet)', () => {
    expect(toComposerLineVariant(baseVariant({ paletteColorGradients: [0] }))).toBeNull()
  })

  it('paletteScalarGradients present → null (not supported yet)', () => {
    expect(toComposerLineVariant(baseVariant({ paletteScalarGradients: [0] }))).toBeNull()
  })

  it('preamble.bindings present → null (no new bind slots supported yet)', () => {
    const variant = baseVariant({
      preamble: { bindings: [{ group: 2, binding: 0 } as never] },
    })
    expect(toComposerLineVariant(variant)).toBeNull()
  })

  it('a plain feature-free stroke variant is accepted', () => {
    const variant = baseVariant()
    const result = toComposerLineVariant(variant)
    expect(result).not.toBeNull()
    expect(result!.needsFeatureBuffer).toBe(false)
    expect(result!.strokePreamble).toBeNull()
    expect(result!.strokeExpr).toBeInstanceOf(Node)
    expect(result!.strokeExpr!.expr).toBe(strokeExprNode.expr)
  })

  it('a variant with preamble consts/funcs (no bindings) carries them through', () => {
    const constDecl = { name: 'MY_CONST', type: { kind: 'scalar', scalar: 'f32' }, value: 1 }
    const variant = baseVariant({ preamble: { consts: [constDecl as never] } })
    const result = toComposerLineVariant(variant)
    expect(result!.preamble).toEqual({ consts: [constDecl], funcs: undefined })
  })
})
