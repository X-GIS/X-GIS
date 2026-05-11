import { describe, it, expect } from 'vitest'
import {
  MockRasterizer,
  createRasterizer,
  parseFontKey,
  FONT_KEY_SENTINEL,
  type GlyphRasterRequest,
} from './sdf/glyph-rasterizer'

const baseReq: GlyphRasterRequest = {
  fontKey: 'noto-sans-regular',
  fontSize: 16,
  codepoint: 65,  // 'A'
  sdfRadius: 6,
  slotSize: 24,
}

describe('MockRasterizer', () => {
  const r = new MockRasterizer()

  it('returns SDF of expected size', () => {
    const out = r.rasterize(baseReq)
    expect(out.sdf.length).toBe(24 * 24)
  })

  it('returns metrics with sane defaults', () => {
    const out = r.rasterize(baseReq)
    expect(out.advanceWidth).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
  })

  it('different codepoints produce different SDFs', () => {
    const a = r.rasterize({ ...baseReq, codepoint: 65 })
    const b = r.rasterize({ ...baseReq, codepoint: 66 })
    let differs = false
    for (let i = 0; i < a.sdf.length; i++) {
      if (a.sdf[i] !== b.sdf[i]) { differs = true; break }
    }
    expect(differs).toBe(true)
  })

  it('same request twice produces identical SDF (deterministic)', () => {
    const a = r.rasterize(baseReq)
    const b = r.rasterize(baseReq)
    expect(a.sdf).toEqual(b.sdf)
  })

  it('preserves keying fields in result', () => {
    const out = r.rasterize(baseReq)
    expect(out.fontKey).toBe('noto-sans-regular')
    expect(out.codepoint).toBe(65)
    expect(out.sdfRadius).toBe(6)
  })
})

describe('createRasterizer', () => {
  it('returns a usable rasterizer regardless of env', () => {
    const r = createRasterizer()
    const out = r.rasterize(baseReq)
    expect(out.sdf.length).toBe(24 * 24)
  })
})

describe('parseFontKey', () => {
  // The contract between text-stage's composeFontKey and the
  // rasterizer's ctx.font composition. If the sentinel encoding
  // drifts on either side, Mapbox styles silently lose weight/italic
  // info and every label falls back to OS default Regular — exactly
  // the bug that motivated splitting weight out of the family name.

  it('plain family-list passes through with normal/400 defaults', () => {
    const out = parseFontKey('"Noto Sans","Noto Sans CJK KR",sans-serif')
    expect(out.style).toBe('normal')
    expect(out.weight).toBe('400')
    expect(out.family).toBe('"Noto Sans","Noto Sans CJK KR",sans-serif')
  })

  it('sentinel-encoded key unpacks into style + weight + family', () => {
    const composed = `${FONT_KEY_SENTINEL}italic${FONT_KEY_SENTINEL}700${FONT_KEY_SENTINEL}"Noto Sans",sans-serif`
    const out = parseFontKey(composed)
    expect(out.style).toBe('italic')
    expect(out.weight).toBe('700')
    expect(out.family).toBe('"Noto Sans",sans-serif')
  })

  it('different weights produce different keys (atlas cache uniqueness)', () => {
    // The atlas keys glyphs on (fontKey, codepoint, sdfRadius). If
    // Bold and Regular hash to the same fontKey, the Bold render
    // would overwrite the cached Regular SDF (or vice versa) —
    // visible as labels suddenly going Bold mid-frame on cache
    // collision. Encoding weight into the key avoids that.
    const regular = `${FONT_KEY_SENTINEL}normal${FONT_KEY_SENTINEL}400${FONT_KEY_SENTINEL}"Noto Sans"`
    const bold = `${FONT_KEY_SENTINEL}normal${FONT_KEY_SENTINEL}700${FONT_KEY_SENTINEL}"Noto Sans"`
    expect(regular).not.toBe(bold)
  })

  it('malformed sentinel key still yields safe defaults (no throw)', () => {
    // Defensive — a sentinel-prefixed key with missing pieces should
    // rasterise as 400/normal rather than throw mid-frame.
    const out = parseFontKey(`${FONT_KEY_SENTINEL}${FONT_KEY_SENTINEL}${FONT_KEY_SENTINEL}"Noto Sans"`)
    expect(out.style).toBe('normal')
    expect(out.weight).toBe('400')
    expect(out.family).toBe('"Noto Sans"')
  })
})
