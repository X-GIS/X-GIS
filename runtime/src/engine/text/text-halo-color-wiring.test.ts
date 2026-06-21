// text-halo-color: GPU-free runtime WIRING test (fail-before).
//
// Closes a spec-coverage "supported-but-untested" wiring gap. The sibling
// halo-uniforms.test.ts exhaustively pins halo_WIDTH (slot 12) and
// halo_BLUR (slot 13), and the "halo absent" case only asserts slots 12/13
// are zero — but NOTHING asserts that text-halo-COLOR actually reaches the
// GPU. The runtime contract is: TextRenderer's 64-byte text uniform carries
// halo_color as a vec4 at f32 slots 8..11, copied verbatim from d.halo.color
// (text-renderer.ts packUniforms, buf[8..11] = d.halo.color[0..3]); when the
// draw has no halo, those four slots are zeroed. The fragment shader reads
// halo_color to tint the SDF halo band. Without this test, a wiring break
// (e.g. packing a constant instead of d.halo.color) ships silently — the
// heatmap-class regression this corpus exists to catch.
//
// This mirrors halo-uniforms.test.ts EXACTLY: same packUniformsForTesting
// seam, same baseGlyph/makeDraw shape. It is non-vacuous — it feeds four
// DISTINCT channel values and asserts each lands in its own slot, so any
// constant / dropped-field break is caught.
//
// Fail-before: in text-renderer.ts replace
//   buf[8] = d.halo.color[0]; buf[9] = d.halo.color[1]
//   buf[10] = d.halo.color[2]; buf[11] = d.halo.color[3]
// with constants (0) and the per-channel assertions below go red — the
// wiring that makes text-halo-color reach the GPU is gone, caught before
// any render.

import { describe, it, expect } from 'vitest'
import { packUniformsForTesting, type TextDraw } from './text-renderer'

const baseGlyph = {
  codepoint: 65,
  slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 64 },
  advanceWidth: 16, bearingX: 0, bearingY: 16, width: 16, height: 20,
  pbf: true,
}

// halo_color is the vec4 at f32 slots 8..11 of the 64-byte text uniform.
// (See `packUniforms` in text-renderer.ts: buf[8..11] = d.halo.color[0..3].)
const HALO_COLOR_R = 8
const HALO_COLOR_G = 9
const HALO_COLOR_B = 10
const HALO_COLOR_A = 11

function makeDraw(haloColor: [number, number, number, number] | undefined): TextDraw {
  const d: TextDraw = {
    anchorX: 0, anchorY: 0,
    glyphs: [{ ...baseGlyph }],
    fontSize: 32,
    rasterFontSize: 32,
    sdfRadius: 8,
    color: [0, 0, 0, 1],
  }
  if (haloColor !== undefined) {
    d.halo = { color: haloColor, width: 1, blur: 0 }
  }
  return d
}

describe('text-halo-color wiring (GPU-free)', () => {
  it('halo_color vec4 (slots 8..11) carries d.halo.color verbatim', () => {
    // Four DISTINCT channel values so a constant / channel-swap / dropped
    // field cannot pass — each must land in its own slot.
    const u = packUniformsForTesting(makeDraw([0.1, 0.4, 0.7, 0.9]))
    expect(u[HALO_COLOR_R]).toBeCloseTo(0.1, 6)
    expect(u[HALO_COLOR_G]).toBeCloseTo(0.4, 6)
    expect(u[HALO_COLOR_B]).toBeCloseTo(0.7, 6)
    expect(u[HALO_COLOR_A]).toBeCloseTo(0.9, 6)
  })

  it('a different halo color produces a different packed vec4 (prop-dependent)', () => {
    // Guards against the assertion accidentally pinning a constant: the
    // packed slots must TRACK the prop, not a fixed value.
    const a = packUniformsForTesting(makeDraw([1, 0, 0, 1]))
    const b = packUniformsForTesting(makeDraw([0, 1, 0, 1]))
    expect([a[HALO_COLOR_R], a[HALO_COLOR_G], a[HALO_COLOR_B], a[HALO_COLOR_A]])
      .not.toEqual([b[HALO_COLOR_R], b[HALO_COLOR_G], b[HALO_COLOR_B], b[HALO_COLOR_A]])
    expect(a[HALO_COLOR_R]).toBeCloseTo(1, 6)
    expect(b[HALO_COLOR_G]).toBeCloseTo(1, 6)
  })

  it('halo absent → halo_color slots 8..11 are zeroed', () => {
    const u = packUniformsForTesting(makeDraw(undefined))
    expect(u[HALO_COLOR_R]).toBe(0)
    expect(u[HALO_COLOR_G]).toBe(0)
    expect(u[HALO_COLOR_B]).toBe(0)
    expect(u[HALO_COLOR_A]).toBe(0)
  })
})
