// Issue #601 — opaque WHITE BOX behind small labels (z0 country labels).
//
// The SDF text fragment shader (shaders/dsl/text.ts) composites a halo behind
// the fill. The packed halo_width is normalised per-fontScale in text-renderer.ts:
//   halo_width_norm = halo.width_phys * 3 / fontSize_phys
// so at SMALL text it inflates. The shader then forms the halo band from
//   haloEdge = edge - halo_width_norm            (edge = 0.75, the SDF glyph edge)
//   aaHalo   = halo_blur_norm + soft             (soft = 2.52 / fontSize_phys)
//   haloA    = smoothstep(haloEdge - aaHalo, haloEdge + aaHalo, sdf)
// Because BOTH halo_width_norm and `soft` grow ~1/fontSize, at small text the
// lower smoothstep edge (haloEdge - aaHalo) descends to <= 0 and the halo
// smoothstep covers the glyph cell's BACKGROUND (sdf ~ 0) — the opaque white box.
//
// FIX (#601): floor haloEdge at aaHalo so (haloEdge - aaHalo) >= 0 — the halo
// never reaches the sdf=0 background and stays a thin outline that thins with
// the text, matching MapLibre (whose halo band is bounded to the SDF radius).
//
// This test ports the EXACT shader halo math (mirrors shaders/dsl/text.ts) and
// is DISCRIMINATING: `haloAlphaAtCellEdge(... clamp:false)` (the OLD shader)
// SATURATES the background at a small fontScale; `clamp:true` (the fix) keeps it
// ~0. The fill/halo at the glyph edge stays a visible outline in both.

import { describe, it, expect } from 'vitest'

const EDGE = 0.75 // 192/256 — MapLibre symbol_sdf glyph edge
const HALO_K = 3 // ONE_EM/SDF_PX = 24/8 — matches packUniforms pxToSdf

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Pack the halo uniforms exactly as text-renderer.ts packUniforms does. */
function packHalo(haloWidthPhys: number, haloBlurPhys: number, fontSizePhys: number) {
  const pxToSdf = HALO_K / fontSizePhys
  return { haloWidthNorm: haloWidthPhys * pxToSdf, haloBlurNorm: haloBlurPhys * 1.19 * pxToSdf }
}

/** The fragment shader's premultiplied output alpha for a pixel with the given
 *  SDF sample, mirroring shaders/dsl/text.ts. `clamp` toggles the #601 fix. */
function shadeAlpha(
  sdf: number,
  fontSizePhys: number,
  haloWidthPhys: number,
  haloBlurPhys: number,
  fillA = 1,
  haloColorA = 1,
  clamp = true,
): number {
  const soft = Math.max(2.52 / Math.max(fontSizePhys, 1), 1 / 255)
  const { haloWidthNorm, haloBlurNorm } = packHalo(haloWidthPhys, haloBlurPhys, fontSizePhys)
  const fillAlpha = smoothstep(EDGE - soft, EDGE + soft, sdf)
  const aaHalo = haloBlurNorm + soft
  const haloEdge = clamp
    ? Math.max(EDGE - haloWidthNorm, aaHalo) // #601 fix
    : EDGE - haloWidthNorm // old (unbounded)
  const haloAlpha = smoothstep(haloEdge - aaHalo, haloEdge + aaHalo, sdf)
  const fillW = fillA * fillAlpha
  const haloW = haloColorA * haloAlpha * (1 - fillW)
  return fillW + haloW
}

// A small country-label-ish phys font size where the box appears. At DPR2 an
// OFM country label (~size 6-13 CSS) lands here; the bug is below ~size 20 phys.
const SMALL_FS = 12
const NORMAL_FS = 32
const HALO_W = 2 // phys px (OFM country halo ~1 CSS * DPR2)
const HALO_BLUR = 2

describe('#601 — small-text halo must not saturate the cell background', () => {
  it('FAIL-BEFORE: unclamped halo paints the sdf=0 background at small fontScale', () => {
    // sdf=0 = the glyph cell background (far from any ink). The OLD shader paints
    // it with a visible halo alpha — the semi-opaque white box (here ~0.27 at
    // fs=12, growing toward 0.5+ as text shrinks further).
    const bgOld = shadeAlpha(0.0, SMALL_FS, HALO_W, HALO_BLUR, 1, 1, /*clamp*/ false)
    expect(bgOld).toBeGreaterThan(0.15) // visibly painted background — the bug
    // Smaller text → bigger box (monotonic), confirming the 1/fontScale mechanism.
    const bgOldTiny = shadeAlpha(0.0, 8, HALO_W, HALO_BLUR, 1, 1, false)
    expect(bgOldTiny).toBeGreaterThan(bgOld)
  })

  it('FIX: clamped halo leaves the sdf=0 background transparent at small fontScale', () => {
    const bgNew = shadeAlpha(0.0, SMALL_FS, HALO_W, HALO_BLUR, 1, 1, /*clamp*/ true)
    expect(bgNew).toBeCloseTo(0, 3) // no box
    // Even at the tiniest sizes the fix holds the background transparent.
    const bgNewTiny = shadeAlpha(0.0, 8, HALO_W, HALO_BLUR, 1, 1, true)
    expect(bgNewTiny).toBeCloseTo(0, 3)
  })

  it('the packed halo band already exceeds the SDF range at small text (root cause)', () => {
    // Discriminator on the PACKING: at SMALL_FS the lower smoothstep edge of the
    // UNCLAMPED halo is <= 0 (reaches the background); at NORMAL_FS it stays > 0.
    const soft = (fs: number) => Math.max(2.52 / fs, 1 / 255)
    const lowerEdge = (fs: number) => {
      const { haloWidthNorm, haloBlurNorm } = packHalo(HALO_W, HALO_BLUR, fs)
      return EDGE - haloWidthNorm - (haloBlurNorm + soft(fs))
    }
    expect(lowerEdge(SMALL_FS)).toBeLessThanOrEqual(0) // background enters the ramp
    expect(lowerEdge(NORMAL_FS)).toBeGreaterThan(0) // normal text is fine
  })

  it('REGRESSION GUARD: normal/large text halo is unchanged by the clamp', () => {
    // At NORMAL_FS the clamp is a no-op (haloEdge >> aaHalo): identical background
    // (both 0) AND identical halo-edge alpha.
    const bgClamp = shadeAlpha(0.0, NORMAL_FS, HALO_W, HALO_BLUR, 1, 1, true)
    const bgNo = shadeAlpha(0.0, NORMAL_FS, HALO_W, HALO_BLUR, 1, 1, false)
    expect(bgClamp).toBeCloseTo(bgNo, 6)
    // A point just outside the glyph edge (sdf slightly below 0.75) still shows
    // halo in both — the outline is preserved.
    const outerClamp = shadeAlpha(0.62, NORMAL_FS, HALO_W, HALO_BLUR, 1, 1, true)
    const outerNo = shadeAlpha(0.62, NORMAL_FS, HALO_W, HALO_BLUR, 1, 1, false)
    expect(outerClamp).toBeCloseTo(outerNo, 6)
    expect(outerClamp).toBeGreaterThan(0.3) // halo visible at normal size
  })

  it('the small-text halo stays a VISIBLE outline (does not erase the halo)', () => {
    // At the glyph edge (sdf just below 0.75) the clamped halo is still present —
    // the fix bounds the background bleed without removing the outline.
    const outline = shadeAlpha(0.6, SMALL_FS, HALO_W, HALO_BLUR, 1, 1, true)
    expect(outline).toBeGreaterThan(0.2)
  })
})
