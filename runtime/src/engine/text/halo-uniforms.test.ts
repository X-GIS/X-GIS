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

// ─── Halo smoothstep behaviour (mirrors the WGSL fragment shader) ──
//
// The WGSL runs on the GPU and isn't reachable from vitest, so we
// mirror the smoothstep + composite in JS. The point of these tests
// is the user-visible invariant: when both `width` and `blur` are
// authored at a typical small-font configuration (demotiles
// geolines-label: width=1, blur=1 against text-size 12), the halo
// MUST reach α≈1 somewhere OUTSIDE the glyph body. Pre-fix the
// halo was a symmetric crossfade centred on `halo_edge` and α=1 was
// only reached deep INSIDE the glyph (where fill takes over and the
// halo contributes nothing), leaving the halo as pure outward fade —
// the dashed Tropic of Capricorn line bled through the gradient.
//
// The mirror replicates the shader 1:1; if the WGSL drifts, these
// tests fall out of sync — keep them in lock-step (small surface).

const EDGE = 192 / 255  // glyph fill threshold (matches WGSL `edge`)

function smoothstep(a: number, b: number, x: number): number {
  if (b === a) return x < a ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Returns the composited halo alpha at SDF sample `sdf`, assuming
 *  the AA derivative-rate `soft` (i.e. fwidth(sdf) * 0.7) and the
 *  authored halo width / blur in DISPLAY pixels at the configured
 *  font size. Mirrors the WGSL fragment shader exactly. */
function shaderHaloAlpha(args: {
  sdf: number; soft: number; fontSize: number; rasterFontSize: number;
  sdfRadius: number; haloWidthPx: number; haloBlurPx: number;
}): { halo_a: number; fill_a: number; halo_edge: number } {
  const scale = args.fontSize / args.rasterFontSize
  const SDF_UNITS_PER_SDF_PX = 63 / args.sdfRadius
  const halo_width_byte = ((args.haloWidthPx / scale) * SDF_UNITS_PER_SDF_PX) / 255
  const halo_blur_byte = ((args.haloBlurPx / scale) * SDF_UNITS_PER_SDF_PX) / 255
  const halo_edge = EDGE - halo_width_byte
  // Asymmetric: outer fade widens by blur, inner stays at sharp AA.
  const halo_outer_aa = halo_blur_byte + args.soft
  const halo_a = smoothstep(halo_edge - halo_outer_aa, halo_edge + args.soft, args.sdf)
  const fill_a = smoothstep(EDGE - args.soft, EDGE + args.soft, args.sdf)
  return { halo_a, fill_a, halo_edge }
}

describe('halo smoothstep — asymmetric blur preserves solid halo', () => {
  // Pre-fix bug repro: demotiles geolines-label at z=3, DPR=2.
  // fontSize 13 CSS px → 26 display px, halo-width 1 → 2 display px,
  // halo-blur 1 → 2 display px. The label has white halo over a
  // dashed blue line; halo must mask the line outside the glyph.
  const config = {
    fontSize: 26, rasterFontSize: 32, sdfRadius: 8,
    haloWidthPx: 2, haloBlurPx: 2, soft: 0.027,
  }

  it('halo reaches α≈1 BETWEEN glyph edge and halo_edge', () => {
    // Pick a sample just inside the halo's outer edge but well
    // outside the glyph body — this is where the dashes sit.
    // sdf = halo_edge + soft is the inner-AA upper bound; halo_a
    // should already be 1.0 there (smoothstep saturated).
    const scale = config.fontSize / config.rasterFontSize
    const halo_edge = EDGE - ((config.haloWidthPx / scale) * (63 / config.sdfRadius)) / 255
    const sdf = halo_edge + config.soft + 0.001
    const { halo_a, fill_a } = shaderHaloAlpha({ ...config, sdf })
    expect(halo_a).toBeCloseTo(1, 3)
    expect(fill_a).toBe(0)  // well below glyph fill threshold
  })

  it('halo composite reaches α≈1 OUTSIDE the glyph body (the bug case)', () => {
    // The pre-fix shader had `halo_a = smoothstep(halo_edge - aa,
    // halo_edge + aa, sdf)` with aa = blur + soft, so at sdf =
    // halo_edge α was 0.5 and α reached 1 only INSIDE the glyph
    // (sdf > halo_edge + aa > EDGE) where fill subtracts it.
    // Sample at sdf = halo_edge + soft (just inside halo): with
    // the symmetric formula this was ~0.5; with the asymmetric
    // fix it's 1.0.
    const scale = config.fontSize / config.rasterFontSize
    const halo_edge = EDGE - ((config.haloWidthPx / scale) * (63 / config.sdfRadius)) / 255
    const sdf = halo_edge + config.soft
    const { halo_a, fill_a } = shaderHaloAlpha({ ...config, sdf })
    // Composite (fill_a is zero here since sdf < EDGE):
    const composite = halo_a * (1 - fill_a)
    expect(composite).toBeGreaterThan(0.99)
  })

  it('halo fades outward over (blur + soft) band, not symmetric', () => {
    // At sdf = halo_edge - halo_outer_aa, halo_a should be 0.
    const scale = config.fontSize / config.rasterFontSize
    const halo_edge = EDGE - ((config.haloWidthPx / scale) * (63 / config.sdfRadius)) / 255
    const halo_blur_byte = ((config.haloBlurPx / scale) * (63 / config.sdfRadius)) / 255
    const halo_outer_aa = halo_blur_byte + config.soft
    const sdfOuter = halo_edge - halo_outer_aa
    const { halo_a } = shaderHaloAlpha({ ...config, sdf: sdfOuter })
    expect(halo_a).toBeCloseTo(0, 6)
  })

  it('blur=0 produces a near-symmetric soft step (backward-compat)', () => {
    // With blur=0 the new formula collapses to
    //   smoothstep(halo_edge - soft, halo_edge + soft, sdf)
    // — identical to a symmetric AA-soft step centred on halo_edge.
    const c = { ...config, haloBlurPx: 0 }
    const scale = c.fontSize / c.rasterFontSize
    const halo_edge = EDGE - ((c.haloWidthPx / scale) * (63 / c.sdfRadius)) / 255
    // At halo_edge exactly: alpha is 0.5 (standard AA midpoint).
    const { halo_a } = shaderHaloAlpha({ ...c, sdf: halo_edge })
    expect(halo_a).toBeCloseTo(0.5, 2)
  })
})
