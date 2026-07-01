// text-color fill_color uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-color` is
// marked `supported` (constant / zoom-interp / data-driven) in the symbol
// capability table (runtime/src/capabilities/symbol.ts:8-10), and the
// runtime resolves it to LabelDef.color → TextDraw.color (label-pass.ts +
// render-loop-helpers.ts:84 → text-stage.ts:1107). But the ONLY behavioral
// test that touches the consumer — `packUniforms` in text-renderer.ts —
// is halo-uniforms.test.ts, which asserts ONLY the halo slots (8-13) and
// always passes `color: [0,0,0,1]` (a constant). The `text-color` wire
// itself — TextDraw.color[0..3] → fill_color vec4 @ uniform slots 4..7,
// which the SDF fragment shader reads as the glyph fill — had NO assertion.
// A break to that pack (e.g. `buf[4]=0`) would ship silently: every label
// would render black/wrong with the halo math still green.
//
// This mirrors halo-uniforms.test.ts exactly (same `packUniformsForTesting`
// seam, same minimal TextDraw) but pins the fill_color slots with FOUR
// DISTINCT prop-derived components, so the assertion is non-vacuous — each
// asserted slot equals a different channel of TextDraw.color, never a
// constant and never a value independent of the prop.
//
// Fully GPU-free: packUniformsForTesting is a pure function; no WebGPU stub,
// no device, no render. Fail-before: zero the fill_color write
//   `buf[4] = d.color[0]; buf[5] = d.color[1]; buf[6] = d.color[2]; buf[7] = d.color[3]`
// → `buf[4] = 0; buf[5] = 0; buf[6] = 0; buf[7] = 0`
// and every assertion below goes red while halo-uniforms.test.ts stays
// green — proving this test is the one guarding the text-color wire.

import { describe, it, expect } from 'vitest'
import { packUniformsForTesting, type TextDraw } from '@xgis/map'

// Layout (text-renderer.ts packUniforms, 64-byte uniform): the fill_color
// vec4 — the text-color consumer — lives at f32 slots 4..7.
const FILL_R = 4
const FILL_G = 5
const FILL_B = 6
const FILL_A = 7

const baseGlyph = {
  codepoint: 65,
  slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 64 },
  advanceWidth: 16, bearingX: 0, bearingY: 16, width: 16, height: 20,
  pbf: true,
}

/** Minimal TextDraw carrying the given resolved text-color RGBA. Only
 *  `color` varies between cases; everything else is fixed so the only
 *  thing that can move slots 4..7 is the text-color wire. */
function makeDraw(color: [number, number, number, number]): TextDraw {
  return {
    anchorX: 0, anchorY: 0,
    glyphs: [baseGlyph],
    fontSize: 24,
    rasterFontSize: 32,
    sdfRadius: 8,
    color,
  }
}

describe('packUniforms — text-color fill_color wiring (GPU-free)', () => {
  it('threads TextDraw.color[0..3] into fill_color slots 4..7 (distinct channels)', () => {
    // Four DISTINCT components so a swapped/dropped channel is caught and
    // the assertion cannot pass on a constant.
    const color: [number, number, number, number] = [0.2, 0.4, 0.6, 0.8]
    const u = packUniformsForTesting(makeDraw(color))
    expect(u[FILL_R]).toBeCloseTo(0.2, 6)
    expect(u[FILL_G]).toBeCloseTo(0.4, 6)
    expect(u[FILL_B]).toBeCloseTo(0.6, 6)
    expect(u[FILL_A]).toBeCloseTo(0.8, 6)
  })

  it('fill_color tracks the text-color prop, not a constant (red vs blue differ)', () => {
    const red = packUniformsForTesting(makeDraw([1, 0, 0, 1]))
    const blue = packUniformsForTesting(makeDraw([0, 0, 1, 1]))
    // Red text → R slot 1, B slot 0; blue text → R slot 0, B slot 1.
    expect(red[FILL_R]).toBeCloseTo(1, 6)
    expect(red[FILL_B]).toBeCloseTo(0, 6)
    expect(blue[FILL_R]).toBeCloseTo(0, 6)
    expect(blue[FILL_B]).toBeCloseTo(1, 6)
    // The wire must move when the prop moves — the two packs differ in the
    // fill_color block.
    expect(red[FILL_R]).not.toBeCloseTo(blue[FILL_R], 6)
    expect(red[FILL_B]).not.toBeCloseTo(blue[FILL_B], 6)
  })

  it('partial alpha (text-color rgba opacity) reaches fill_color.a', () => {
    const u = packUniformsForTesting(makeDraw([0.1, 0.2, 0.3, 0.5]))
    expect(u[FILL_A]).toBeCloseTo(0.5, 6)
  })
})
