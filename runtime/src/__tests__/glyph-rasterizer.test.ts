import { describe, it, expect } from 'vitest'
import {
  MockRasterizer,
  createRasterizer,
  type GlyphRasterRequest,
} from '../engine/sdf/glyph-rasterizer'

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
