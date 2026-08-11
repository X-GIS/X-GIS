// ═══ toComposerPointVariant — the ShaderVariantInfo → PointVariantSpec bridge (#1605) ═══
// Table-driven: every rejection case must fall back to null (→ default point
// rendering on both axes, never throw). Point has TWO independent colour
// axes, so acceptance is tested for fill-only, stroke-only, and both.

import { describe, expect, it } from 'vitest'
import { vec4, f32, Node } from '@xgis/shader-dsl'
import { toComposerPointVariant } from './point-shader-cache'
import type { ShaderVariantInfo } from './renderer-types'

const fillExprNode = vec4(f32(0.9), f32(0.8), f32(0.7), f32(1))
const strokeExprNode = vec4(f32(0.1), f32(0.2), f32(0.3), f32(0.4))

function baseVariant(overrides: Partial<ShaderVariantInfo> = {}): ShaderVariantInfo {
  return {
    key: 'test-key',
    preamble: {},
    fillExpr: { expr: fillExprNode.expr },
    strokeExpr: { expr: strokeExprNode.expr },
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: [],
    categoryOrder: {},
    paletteScalarGradients: [],
    opacityUsesPalette: false,
    fillIsDefault: false,
    strokeIsDefault: false,
    fillIsStage: true,
    strokeIsStage: true,
    ...overrides,
  } as ShaderVariantInfo
}

describe('toComposerPointVariant (#1605 Phase 2)', () => {
  it('null variant → null', () => {
    expect(toComposerPointVariant(null)).toBeNull()
    expect(toComposerPointVariant(undefined)).toBeNull()
  })

  it('neither axis is a stage block → null, even with both exprs populated', () => {
    // The exact regression class line's Phase 1 PR B hit round 1: fillExpr/
    // strokeExpr are populated unconditionally by the compiler for virtually
    // every real layer. Gating on presence alone would route an ordinary
    // fill+stroke layer through the composer.
    expect(
      toComposerPointVariant(baseVariant({ fillIsStage: false, strokeIsStage: false })),
    ).toBeNull()
  })

  it('needsFeatureBuffer → null (a future per-.field phase, not this slice)', () => {
    expect(toComposerPointVariant(baseVariant({ needsFeatureBuffer: true }))).toBeNull()
  })

  it('computeBindings present → null (not supported yet)', () => {
    const variant = baseVariant({
      computeBindings: [{ paintAxis: 'fill', bindGroup: 2, binding: 0 }] as never,
    })
    expect(toComposerPointVariant(variant)).toBeNull()
  })

  it('paletteScalarGradients present → null (not supported yet)', () => {
    expect(toComposerPointVariant(baseVariant({ paletteScalarGradients: [0] }))).toBeNull()
  })

  it('preamble.bindings present → null (no new bind slots supported yet)', () => {
    const variant = baseVariant({
      preamble: { bindings: [{ group: 2, binding: 0 } as never] },
    })
    expect(toComposerPointVariant(variant)).toBeNull()
  })

  it('a fill-only stage variant is accepted, stroke left null', () => {
    const variant = baseVariant({ strokeIsStage: false })
    const result = toComposerPointVariant(variant)
    expect(result).not.toBeNull()
    expect(result!.needsFeatureBuffer).toBe(false)
    expect(result!.fillExpr).toBeInstanceOf(Node)
    expect(result!.fillExpr!.expr).toBe(fillExprNode.expr)
    expect(result!.strokeExpr).toBeNull()
  })

  it('a stroke-only stage variant is accepted, fill left null', () => {
    const variant = baseVariant({ fillIsStage: false })
    const result = toComposerPointVariant(variant)
    expect(result).not.toBeNull()
    expect(result!.fillExpr).toBeNull()
    expect(result!.strokeExpr).toBeInstanceOf(Node)
    expect(result!.strokeExpr!.expr).toBe(strokeExprNode.expr)
  })

  it('a both-axes stage variant is accepted, both populated', () => {
    const result = toComposerPointVariant(baseVariant())
    expect(result).not.toBeNull()
    expect(result!.fillExpr).toBeInstanceOf(Node)
    expect(result!.fillExpr!.expr).toBe(fillExprNode.expr)
    expect(result!.strokeExpr).toBeInstanceOf(Node)
    expect(result!.strokeExpr!.expr).toBe(strokeExprNode.expr)
    expect(result!.fillPreamble).toBeNull()
    expect(result!.strokePreamble).toBeNull()
  })

  it('a variant with preamble consts/funcs (no bindings) carries them through', () => {
    const constDecl = { name: 'MY_CONST', type: { kind: 'scalar', scalar: 'f32' }, value: 1 }
    const variant = baseVariant({ preamble: { consts: [constDecl as never] } })
    const result = toComposerPointVariant(variant)
    expect(result!.preamble).toEqual({ consts: [constDecl], funcs: undefined })
  })
})
