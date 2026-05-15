// Halo uniform packing — matches MapLibre's symbol_sdf.fragment.glsl
// gamma_halo formula. `halo_width` and `halo_blur` in the packed
// uniform are in normalised SDF byte range [0, 1] derived as:
//
//   halo_width_norm = halo_width_phys * 3 / sizePx_phys
//   halo_blur_norm  = (halo_blur_phys * 0.149 + 0.105) * 24 / sizePx_phys
//
// (See `packUniforms` in text-renderer.ts for the derivation from
// MapLibre's gamma_halo + halo_edge.) Earlier X-GIS used a different
// "byte-per-slot-pixel" derivation which produced a halo ~3× narrower
// and ~5× harder than MapLibre on the same PBF — user-reported on
// OFM Bright z=4.7 country labels.

import { describe, it, expect } from 'vitest'
import { packUniformsForTesting, type TextDraw } from './text-renderer'

const baseGlyph = {
  codepoint: 65,
  slot: { page: 0, pxX: 0, pxY: 0, size: 64 },
  advanceWidth: 16, bearingX: 0, bearingY: 16, width: 16, height: 20,
}

function makeDraw(fontSize: number, haloWidthPx: number, haloBlurPx = 0): TextDraw {
  return {
    anchorX: 0, anchorY: 0,
    glyphs: [baseGlyph],
    fontSize,
    rasterFontSize: 32,
    sdfRadius: 8,
    color: [0, 0, 0, 1],
    halo: { color: [1, 1, 1, 1], width: haloWidthPx, blur: haloBlurPx },
  }
}

const HALO_WIDTH_SLOT = 12
const HALO_BLUR_SLOT = 13

describe('packUniforms — halo MapLibre-parity formula', () => {
  it('halo_width_norm = halo_width_phys × 3 / sizePx_phys', () => {
    // halo_width=1 phys, sizePx=32 phys → 3/32 = 0.09375
    const u = packUniformsForTesting(makeDraw(32, 1))
    expect(u[HALO_WIDTH_SLOT]).toBeCloseTo(3 / 32, 6)
  })

  it('halo_width_norm scales as 1/sizePx_phys (smaller text → bigger norm)', () => {
    const u1 = packUniformsForTesting(makeDraw(32, 1))
    const uHalf = packUniformsForTesting(makeDraw(16, 1))
    expect(uHalf[HALO_WIDTH_SLOT]).toBeCloseTo(u1[HALO_WIDTH_SLOT] * 2, 6)
  })

  it('typical Bright country label (size 12 phys) — halo_width_norm = 0.25', () => {
    const u = packUniformsForTesting(makeDraw(12, 1))
    expect(u[HALO_WIDTH_SLOT]).toBeCloseTo(3 / 12, 6)
  })

  it('halo_blur_norm = (blur_phys × 0.149 + 0.105) × 24 / sizePx_phys', () => {
    // blur=2 phys, sizePx=32 → (2*0.149 + 0.105) * 24 / 32 = 0.403 * 0.75 = 0.302
    const u = packUniformsForTesting(makeDraw(32, 1, 2))
    expect(u[HALO_BLUR_SLOT]).toBeCloseTo(0.403 * 0.75, 4)
  })

  it('halo_blur_norm includes the EDGE_GAMMA constant even when blur=0', () => {
    // blur=0 still produces a non-zero AA term from the 0.105 EDGE_GAMMA.
    const u = packUniformsForTesting(makeDraw(32, 1, 0))
    expect(u[HALO_BLUR_SLOT]).toBeCloseTo(0.105 * 24 / 32, 4)
    expect(u[HALO_BLUR_SLOT]).toBeGreaterThan(0)
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
// is the user-visible invariant: the halo MUST reach near-α=1
// somewhere OUTSIDE the glyph body when authored width/blur are
// typical (1 px each at a typical text size). Pre-fix the halo only
// reached α=1 INSIDE the glyph where fill subtracted it.

const EDGE = 192 / 255

function smoothstep(a: number, b: number, x: number): number {
  if (b === a) return x < a ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Mirrors the WGSL fragment shader's halo math 1:1. */
function shaderHaloAlpha(args: {
  sdf: number; soft: number; fontSize: number;
  haloWidthPx: number; haloBlurPx: number;
}): { halo_a: number; fill_a: number; halo_edge: number } {
  const halo_width_norm = args.haloWidthPx * 3 / args.fontSize
  const halo_blur_norm = (args.haloBlurPx * 0.149 + 0.105) * 24 / args.fontSize
  const halo_edge = EDGE - halo_width_norm
  const aa_halo = Math.max(halo_blur_norm, args.soft)
  const inner_edge_halo = EDGE + aa_halo
  const outer_a = smoothstep(halo_edge - aa_halo, halo_edge + aa_halo, args.sdf)
  const inner_a = smoothstep(inner_edge_halo - aa_halo, inner_edge_halo + aa_halo, args.sdf)
  const halo_a = Math.min(outer_a, 1 - inner_a)
  const fill_a = smoothstep(EDGE - args.soft, EDGE + args.soft, args.sdf)
  return { halo_a, fill_a, halo_edge }
}

describe('halo smoothstep — opacity at typical user-visible distances', () => {
  // Bright z=4.7 country label config: fontSize=32 phys, halo=2 phys,
  // blur=2 phys.
  const config = {
    fontSize: 32, haloWidthPx: 2, haloBlurPx: 2, soft: 0.022,
  }

  it('halo opacity > 0.85 at the glyph edge (visible outline)', () => {
    const { halo_a } = shaderHaloAlpha({ ...config, sdf: EDGE })
    expect(halo_a).toBeGreaterThan(0.85)
  })

  it('halo opacity > 0.5 a few SDF px outside the glyph (visible band)', () => {
    // sdf = EDGE - 0.06 ≈ 2 slot-pixels outside the glyph edge
    const { halo_a } = shaderHaloAlpha({ ...config, sdf: EDGE - 0.06 })
    expect(halo_a).toBeGreaterThan(0.5)
  })

  it('halo opacity drops to ~0 far outside the glyph', () => {
    // sdf well below halo_edge - aa_halo
    const { halo_a } = shaderHaloAlpha({ ...config, sdf: 0.1 })
    expect(halo_a).toBeLessThan(0.05)
  })

  it('halo composite (1 - fill_w) masks inside the glyph fill', () => {
    // sdf well inside the glyph: fill is opaque, halo should be
    // suppressed by the composite (1 - fill_w) factor in WGSL.
    const sdf = EDGE + 0.05
    const { halo_a, fill_a } = shaderHaloAlpha({ ...config, sdf })
    const composite = halo_a * (1 - fill_a)
    expect(composite).toBeLessThan(0.1)
  })
})
