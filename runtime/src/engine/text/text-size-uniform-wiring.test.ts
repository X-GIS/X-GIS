// text-size uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-size is marked
// `supported` for the symbol layer (compiler layers-symbol.ts emits it as the
// label display size), and it lowers — via TextStage / label-pass `def.size`
// → TextDraw.fontSize — to the text glyph draw. The renderer threads that
// value into the 64-byte text uniform at f32 slot 14 (`font_size_px`), which
// the text fragment shader reads to compute the MapLibre-exact AA half-width
// (soft = 2.52 / font_size_px; see runtime/src/engine/shaders/dsl/text.ts + packUniforms
// note at text-renderer.ts:530). That `font_size_px` slot — the direct wire
// that makes text-size reach the GPU uniform — had NO behavioral assertion:
// halo-uniforms.test.ts asserts the halo slots (12/13) and the AA `soft` math,
// but only ever uses fontSize as a divisor, never pins slot 14 itself. So a
// break of `buf[14] = d.fontSize` would ship silently (the heatmap-class bug).
//
// This drives the REAL packUniforms via its `packUniformsForTesting` seam
// (the same GPU-free seam halo-uniforms.test.ts uses) and asserts slot 14
// carries exactly the draw's fontSize, AND tracks it (two distinct text-size
// values → two distinct, proportional slot-14 values) so the assertion cannot
// pass against a constant or a value independent of the prop.
//
// Fail-before: replace `buf[14] = d.fontSize` with `buf[14] = 0` (or any
// constant) in text-renderer.ts and every assertion below goes red — the
// text-size → font_size_px wire is gone, and the test says so before a render.

import { describe, it, expect } from 'vitest'
import { packUniformsForTesting, type TextDraw } from './text-renderer'

// font_size_px is f32 slot 14 of the 64-byte (16-float) text uniform:
// viewport@0-1, pad@2-3, fill_color@4-7, halo_color@8-11, halo_width@12,
// halo_blur@13, font_size_px@14, _pad1@15. (Matches the Uniforms struct in
// runtime/src/engine/shaders/dsl/text.ts and packUniforms in text-renderer.ts.)
const FONT_SIZE_PX_SLOT = 14

const baseGlyph = {
  codepoint: 65,
  slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 64 },
  advanceWidth: 16, bearingX: 0, bearingY: 16, width: 16, height: 20,
  pbf: true,
}

/** A minimal opaque (no-halo) text draw at the given display text-size. */
function makeDraw(fontSize: number): TextDraw {
  return {
    anchorX: 0, anchorY: 0,
    glyphs: [baseGlyph],
    fontSize,
    rasterFontSize: 32,
    sdfRadius: 8,
    color: [0, 0, 0, 1],
  }
}

describe('text-size uniform wiring (GPU-free)', () => {
  it('font_size_px (slot 14) carries the draw fontSize exactly', () => {
    const u = packUniformsForTesting(makeDraw(13))
    expect(u[FONT_SIZE_PX_SLOT]).toBeCloseTo(13, 6)
  })

  it('font_size_px tracks text-size — distinct sizes → distinct slot-14 values', () => {
    const small = packUniformsForTesting(makeDraw(12))
    const big = packUniformsForTesting(makeDraw(24))
    // Non-vacuous: the slot must MOVE with the prop, exactly (not a constant).
    expect(small[FONT_SIZE_PX_SLOT]).toBeCloseTo(12, 6)
    expect(big[FONT_SIZE_PX_SLOT]).toBeCloseTo(24, 6)
    expect(big[FONT_SIZE_PX_SLOT]).toBeCloseTo(small[FONT_SIZE_PX_SLOT] * 2, 6)
  })
})
