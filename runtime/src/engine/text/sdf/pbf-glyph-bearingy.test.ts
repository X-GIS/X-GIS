// iter-333 — DETERMINISTIC repro + fix gate for the bilingual label
// vertical-collapse (user, mobile, OFM Bright "Fuxing\n复兴镇 복흥진",
// "Seoul\n서울특별시", "Tanhyeon\n탄현면"). Localized via
// /debug-labels.html: latin PBF glyphs report bearingY (g.top) NEGATIVE
// (-9..-13, ascender-relative convention) while CJK report POSITIVE
// (+20, baseline-relative). setDraws places by `y0 = baseline -
// bearingY*scale`, treating bearingY as a baseline ascent — a negative
// value drives the latin line DOWN into the CJK line below → collapse.
//
// Why intermittent: latin PBF top<0 only after the PBF range LANDS;
// before that the Canvas2D fallback gives a correct POSITIVE ascent. So
// a bilingual label renders fine until its latin PBF arrives. Pure-latin
// / pure-CJK / English-only labels never mismatch → always fine.
//
// Fix (PbfRasterizer): a printing glyph (ink height>0) can't have ink
// entirely below the baseline, so bearingY<0 is the ascender-relative
// tell — recover the TRUE ascent from the Canvas2D fallback's
// actualBoundingBoxAscent (real per-font metric, no hardcoded ascender),
// rescaled to the PBF 24-px reference. This test drives the REAL
// PbfRasterizer with a stub provider (the anomalous PBF glyph) + a stub
// fallback (Canvas2D-like positive ascent) and asserts the correction.

import { describe, it, expect } from 'vitest'
import { PbfRasterizer } from './pbf-rasterizer'
import type { GlyphProvider } from './pbf-rasterizer'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult } from './glyph-rasterizer'
import type { PbfGlyph } from './pbf/glyphs-proto'

const SLOT = 64, SDF_R = 8, FONT_SIZE = 32

// Stub provider returning one fixed PBF glyph (the anomalous metrics
// observed live). PbfRasterizer derives the fontstack from the fontKey;
// the stub ignores it and serves by codepoint.
function provider(byCp: Map<number, PbfGlyph>): GlyphProvider {
  return {
    get: (_stack: string, cp: number) => byCp.get(cp),
  } as unknown as GlyphProvider
}

// Stub Canvas2D-like fallback: returns the TRUE baseline ascent at the
// requested fontSize (positive), mimicking actualBoundingBoxAscent.
function fallback(ascentAtFontSize: number): GlyphRasterizer {
  return {
    rasterize: (req: GlyphRasterRequest): GlyphRasterResult => ({
      fontKey: req.fontKey, codepoint: req.codepoint, sdfRadius: req.sdfRadius,
      sdf: new Uint8Array(req.slotSize * req.slotSize),
      advanceWidth: req.fontSize * 0.5,
      bearingX: 0,
      bearingY: ascentAtFontSize,
      width: 10, height: 12,
      rasterFontSize: req.fontSize,
    }),
  }
}

function pbfGlyph(over: Partial<PbfGlyph>): PbfGlyph {
  return {
    id: 70, bitmap: new Uint8Array(24 * 24), width: 12, height: 17,
    left: 0, top: 0, advance: 12, ...over,
  } as PbfGlyph
}

function rasterizeOne(g: PbfGlyph, fallbackAscent: number): GlyphRasterResult {
  const byCp = new Map<number, PbfGlyph>([[g.id, g]])
  const ras = new PbfRasterizer({
    fallback: fallback(fallbackAscent),
    providers: [provider(byCp)],
    onLanded: () => {},
  })
  return ras.rasterize({ fontKey: 'Noto Sans', fontSize: FONT_SIZE, codepoint: g.id, sdfRadius: SDF_R, slotSize: SLOT })
}

describe('iter-333 PBF latin bearingY convention fix (bilingual collapse)', () => {
  it('latin glyph with NEGATIVE PBF top → corrected to POSITIVE ascent', () => {
    // F: PBF top=-9. Canvas2D ascent at fontSize 32 ≈ 32*0.71 = 22.7;
    // rescaled to 24-px ref = 22.7 * 24/32 = 17 (matches the real F cap).
    const r = rasterizeOne(pbfGlyph({ id: 70, top: -9, height: 17 }), 32 * 0.71)
    expect(r.bearingY, 'negative PBF top must be corrected positive').toBeGreaterThan(0)
    // ≈ 17 (24-ref ascent), NOT -9.
    expect(r.bearingY).toBeCloseTo(32 * 0.71 * (24 / 32), 1)
  })

  it('CJK glyph with POSITIVE PBF top → UNCHANGED (already baseline-relative)', () => {
    // 复: top=+20 (valid ascent) → must not be touched (no fallback call).
    const r = rasterizeOne(pbfGlyph({ id: 0x590d, top: 20, height: 22, width: 22 }), 99 /*never used*/)
    expect(r.bearingY).toBe(20)
  })

  it('latin vs CJK ascent COMPARABLE after fix → no cross-line collapse', () => {
    const f = rasterizeOne(pbfGlyph({ id: 70, top: -9, height: 17 }), 32 * 0.71)       // → ~17
    const cjk = rasterizeOne(pbfGlyph({ id: 0x590d, top: 20, height: 22, width: 22 }), 99) // 20
    // Pre-fix gap was |−9 − 20| = 29 (≈ one line height at scale 1.6 →
    // exact collapse). Post-fix gap is a few px → baseline spacing holds.
    expect(Math.abs(f.bearingY - cjk.bearingY)).toBeLessThan(10)
  })

  it('fix is PBF-tagged (halo normalisation path preserved)', () => {
    const r = rasterizeOne(pbfGlyph({ id: 70, top: -9, height: 17 }), 32 * 0.71) as GlyphRasterResult & { pbf?: boolean }
    expect(r.pbf).toBe(true)
  })
})
