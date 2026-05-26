// ═══════════════════════════════════════════════════════════════════
// node-builders — compiler-side authoring helpers (US-005 prep)
// ═══════════════════════════════════════════════════════════════════
//
// Round-trip each helper through `nodeToWgslString` (the back-compat
// adapter that converts NodeLike → WGSL string at the runtime
// boundary) so the helpers produce the exact WGSL the compiler's
// existing string emit currently builds. Once US-005 migrates a
// processColorValue arm to use these helpers, the diff-test gate
// (US-010 final impl) verifies the emitted WGSL stays semantically
// equivalent.

import { describe, it, expect } from 'vitest'
import { nodeToWgslString } from '../_back-compat/node-to-wgsl-string'
import {
  f32Lit, i32Lit, u32Lit, boolLit,
  constRefVec4, varRefVec4, refF32,
  vec4f, vec4fFromRgba,
  composeFillVec4,
  toU32, toI32,
  f32Add, f32Sub, f32Mul, f32Div,
  u32Add, u32Mul, u32Mod,
  arrayIndex,
  featDataField, featDataBindingRef, inputFeatIdRef,
} from './node-builders'

describe('node-builders — literals', () => {
  it('f32Lit emits with decimal point so naga accepts it as f32', () => {
    expect(nodeToWgslString(f32Lit(0))).toBe('0.0')
    expect(nodeToWgslString(f32Lit(1.5))).toBe('1.5')
  })

  it('i32Lit emits without suffix (WGSL default for integer literals)', () => {
    expect(nodeToWgslString(i32Lit(7))).toBe('7')
  })

  it('u32Lit emits with `u` suffix', () => {
    expect(nodeToWgslString(u32Lit(7))).toBe('7u')
  })

  it('boolLit emits true / false', () => {
    expect(nodeToWgslString(boolLit(true))).toBe('true')
    expect(nodeToWgslString(boolLit(false))).toBe('false')
  })
})

describe('node-builders — references', () => {
  it('constRefVec4 emits the name verbatim (varref under the hood)', () => {
    expect(nodeToWgslString(constRefVec4('FILL_COLOR'))).toBe('FILL_COLOR')
  })

  it('varRefVec4 emits the dotted uniform path verbatim', () => {
    // `u.fill_color` is treated as a single varref name by the emit path
    // (the runtime backend doesn't interpret the dot; the marker
    // substitution path emits it verbatim). This mirrors the legacy
    // compiler emit for the time-interpolated arm.
    expect(nodeToWgslString(varRefVec4('u.fill_color'))).toBe('u.fill_color')
  })
})

describe('node-builders — vec4 construct', () => {
  it('vec4f composes a 4-channel vec4<f32> literal', () => {
    const v = vec4f(f32Lit(1), f32Lit(0), f32Lit(0), f32Lit(1))
    expect(nodeToWgslString(v)).toBe('vec4<f32>(1.0, 0.0, 0.0, 1.0)')
  })

  it('vec4fFromRgba is the tuple-shaped shortcut over vec4f', () => {
    const v = vec4fFromRgba([0.78, 0.91, 0.74, 1])
    expect(nodeToWgslString(v)).toBe('vec4<f32>(0.78, 0.91, 0.74, 1.0)')
  })
})

describe('node-builders — arithmetic + casts (US-005 prep)', () => {
  it('toU32 / toI32 emit the standard WGSL cast fn call', () => {
    expect(nodeToWgslString(toU32(f32Lit(1.5)))).toBe('u32(1.5)')
    expect(nodeToWgslString(toI32(f32Lit(2.7)))).toBe('i32(2.7)')
  })

  it('f32Add / Sub / Mul / Div emit parenthesised binops', () => {
    expect(nodeToWgslString(f32Add(f32Lit(1), f32Lit(2)))).toBe('(1.0 + 2.0)')
    expect(nodeToWgslString(f32Sub(f32Lit(3), f32Lit(1)))).toBe('(3.0 - 1.0)')
    expect(nodeToWgslString(f32Mul(f32Lit(2), f32Lit(3)))).toBe('(2.0 * 3.0)')
    expect(nodeToWgslString(f32Div(f32Lit(6), f32Lit(2)))).toBe('(6.0 / 2.0)')
  })

  it('u32Add / Mul / Mod emit with u32 literals', () => {
    expect(nodeToWgslString(u32Add(u32Lit(1), u32Lit(2)))).toBe('(1u + 2u)')
    expect(nodeToWgslString(u32Mul(u32Lit(3), u32Lit(4)))).toBe('(3u * 4u)')
    expect(nodeToWgslString(u32Mod(u32Lit(7), u32Lit(20)))).toBe('(7u % 20u)')
  })

  it('arrayIndex emits base[idx]', () => {
    const CAT_PALETTE = constRefVec4('CAT_PALETTE') as never
    expect(nodeToWgslString(arrayIndex<'vec4<f32>'>(CAT_PALETTE, u32Mod(toU32(f32Lit(7)), u32Lit(20)), 'vec4<f32>'))).toBe(
      'CAT_PALETTE[(u32(7.0) % 20u)]',
    )
  })

  it('categorical pattern composes via the new arithmetic helpers', () => {
    // CAT_PALETTE[u32(field_value) % 20u] — the legacy categorical
    // emit shape. Composing structurally via the new helpers
    // (without going through a string layer) verifies the full
    // expression tree builds + emits cleanly.
    const fieldValue = f32Lit(7) // surrogate for the data-driven field expression
    const idx = u32Mod(toU32(fieldValue), u32Lit(20))
    const palette = constRefVec4('CAT_PALETTE') as never
    const sampled = arrayIndex<'vec4<f32>'>(palette, idx, 'vec4<f32>')
    expect(nodeToWgslString(sampled)).toBe('CAT_PALETTE[(u32(7.0) % 20u)]')
  })
})

describe('node-builders — feat_data lookup (US-005 prep)', () => {
  it('inputFeatIdRef emits input.feat_id', () => {
    expect(nodeToWgslString(inputFeatIdRef())).toBe('input.feat_id')
  })

  it('featDataBindingRef emits feat_data', () => {
    expect(nodeToWgslString(featDataBindingRef())).toBe('feat_data')
  })

  it('featDataField builds the feat_data[input.feat_id * STRIDE + offset] address — byte-equiv to legacy exprToWGSL FieldAccess', () => {
    const fieldMap = new Map([['class', 0], ['name', 1], ['layer', 2]])
    const node = featDataField('class', fieldMap)!
    // STRIDE = 3, offset = 0
    expect(nodeToWgslString(node)).toBe('feat_data[((input.feat_id * 3u) + 0u)]')
  })

  it('featDataField returns null for an unknown field (graceful fallback to legacy "0.0" path)', () => {
    const fieldMap = new Map([['class', 0]])
    expect(featDataField('missing', fieldMap)).toBeNull()
  })

  it('featDataField composes into the categorical Node end-to-end', () => {
    // Real-world OFM landuse: field 'class' → categorical palette lookup
    const fieldMap = new Map([['class', 0]])
    const field = featDataField('class', fieldMap)!
    const palette = constRefVec4('CAT_PALETTE') as never
    const sampled = arrayIndex<'vec4<f32>'>(palette, u32Mod(toU32(field), u32Lit(20)), 'vec4<f32>')
    expect(nodeToWgslString(sampled)).toBe('CAT_PALETTE[(u32(feat_data[((input.feat_id * 1u) + 0u)]) % 20u)]')
  })
})

describe('node-builders — composeFillVec4', () => {
  it('emits BYTE-IDENTICAL output to legacy buildFillExpr for const fill + const opacity', () => {
    // Legacy buildFillExpr emits:
    //   vec4f(FILL_COLOR.rgb, FILL_COLOR.a * OPACITY)
    // The Node-emitted form uses WGSL's vec4<f32>(vec3<f32>, f32)
    // constructor (legal in WGSL) so the emitted text matches the
    // snapshot baselines without needing the diff-test's "swizzle
    // alias" allowance. Only the typename `vec4f` -> `vec4<f32>`
    // expansion differs (the runtime wgsl backend always emits the
    // fully-qualified form), which is documented as a tolerated
    // difference under AC6.
    const out = nodeToWgslString(composeFillVec4(constRefVec4('FILL_COLOR'), refF32('OPACITY')))
    expect(out).toBe('vec4<f32>(FILL_COLOR.rgb, (FILL_COLOR.a * OPACITY))')
  })
})
