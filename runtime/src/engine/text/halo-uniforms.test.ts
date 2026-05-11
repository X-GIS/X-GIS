// Regression test for the halo width SDF-byte conversion.
//
// Before this fix `packUniforms` treated `halo.width` (in display
// pixels) as if 1 display px == 1 SDF px. The SDF is rasterised at
// `rasterFontSize` and sampled at `fontSize`, so 1 display px is
// actually `1/scale` SDF px. Skipping the scale factor produced a
// halo that was `scale` times narrower than authored — basically
// invisible at OFM Bright's typical text-size 10..14 (scale ≈ 0.3
// at rasterFontSize 32).

import { describe, it, expect } from 'vitest'
import { packUniformsForTesting, type TextDraw } from './text-renderer'

const baseGlyph = {
  codepoint: 65,
  slot: { page: 0, pxX: 0, pxY: 0, size: 64 },
  advanceWidth: 16, bearingX: 0, bearingY: 16, width: 16, height: 20,
}

function makeDraw(fontSize: number, haloWidthPx: number): TextDraw {
  return {
    anchorX: 0, anchorY: 0,
    glyphs: [baseGlyph],
    fontSize,
    rasterFontSize: 32,
    sdfRadius: 8,
    color: [0, 0, 0, 1],
    halo: { color: [1, 1, 1, 1], width: haloWidthPx },
  }
}

// halo_width slot is buf[12] in the packed uniform (see UNIFORM_BYTES
// layout in text-renderer.ts).
const HALO_WIDTH_SLOT = 12

describe('packUniforms — halo width scaling', () => {
  it('halo threshold at scale=1 matches 63/sdfRadius/255 per display px', () => {
    // fontSize == rasterFontSize → 1 display px == 1 SDF px.
    const u = packUniformsForTesting(makeDraw(32, 1))
    const expected = (1 * 63 / 8) / 255
    expect(u[HALO_WIDTH_SLOT]).toBeCloseTo(expected, 6)
  })

  it('halo threshold doubles when display scale halves (smaller text)', () => {
    // fontSize = 16, rasterFontSize = 32 → scale 0.5.
    // 1 display px halo = 2 SDF px → threshold should be 2× the unit-scale case.
    const u1 = packUniformsForTesting(makeDraw(32, 1))
    const uHalf = packUniformsForTesting(makeDraw(16, 1))
    expect(uHalf[HALO_WIDTH_SLOT]).toBeCloseTo(u1[HALO_WIDTH_SLOT] * 2, 6)
  })

  it('typical Bright country label (size 12 raster 32) has ~2.67× threshold of unit-scale', () => {
    // Concrete user-visible regression: text-size 12 against
    // rasterFontSize 32 gives scale ≈ 0.375; halo authored as 1 px
    // must extend ~2.67 SDF px to span 1 display px outward.
    const u = packUniformsForTesting(makeDraw(12, 1))
    const expected = ((1 / (12 / 32)) * 63 / 8) / 255
    expect(u[HALO_WIDTH_SLOT]).toBeCloseTo(expected, 6)
    // And the pre-fix value (no scale correction) — kept for the
    // regression's failure-mode story.
    const buggyValue = (1 * 63 / 8) / 255
    expect(u[HALO_WIDTH_SLOT]).toBeGreaterThan(buggyValue * 2)
  })

  it('halo_blur receives the same scale correction as halo_width', () => {
    const HALO_BLUR_SLOT = 13
    const u = packUniformsForTesting({
      ...makeDraw(12, 1),
      halo: { color: [1, 1, 1, 1], width: 1, blur: 1 },
    })
    expect(u[HALO_BLUR_SLOT]).toBeCloseTo(u[HALO_WIDTH_SLOT], 6)
  })

  it('halo absent → both slots zero', () => {
    const u = packUniformsForTesting({
      anchorX: 0, anchorY: 0,
      glyphs: [baseGlyph],
      fontSize: 12, rasterFontSize: 32, sdfRadius: 8,
      color: [0, 0, 0, 1],
    })
    expect(u[12]).toBe(0)
    expect(u[13]).toBe(0)
  })
})
