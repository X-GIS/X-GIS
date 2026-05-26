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
  constRefVec4, varRefVec4,
  vec4f, vec4fFromRgba,
  composeFillVec4,
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

describe('node-builders — composeFillVec4', () => {
  it('emits the buildFillExpr-equivalent composition for a const fill + const opacity', () => {
    // Mirrors the legacy buildFillExpr output for a constant fill +
    // constant opacity:
    //   vec4f(FILL_COLOR.rgb, FILL_COLOR.a * OPACITY)
    // The Node-emitted form parenthesises the binop and elaborates
    // `.rgb` into per-channel access (which the migration accepts as
    // semantic-equivalent under the diff-test's "swizzle alias /
    // associative binop" allowance per AC6).
    const out = nodeToWgslString(composeFillVec4(constRefVec4('FILL_COLOR'), constRefVec4('OPACITY') as never))
    // The composed form references the rgb members of FILL_COLOR
    // and the binop on the a channel — semantic equivalence to the
    // string-emit form is what the diff-test gate (US-010) verifies.
    expect(out).toContain('FILL_COLOR.rgb.x')
    expect(out).toContain('FILL_COLOR.rgb.y')
    expect(out).toContain('FILL_COLOR.rgb.z')
    expect(out).toContain('FILL_COLOR.a * OPACITY')
    expect(out.startsWith('vec4<f32>(')).toBe(true)
  })
})
