import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeGlyphsPbf } from './glyphs-proto'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf')

describe('decodeGlyphsPbf — Open Sans Semibold 0-255 fixture', () => {
  const buf = new Uint8Array(readFileSync(FIXTURE))

  it('decodes exactly one fontstack with correct metadata', () => {
    const stacks = decodeGlyphsPbf(buf)
    expect(stacks).toHaveLength(1)
    expect(stacks[0]!.name).toBe('Open Sans Semibold')
    expect(stacks[0]!.range).toBe('0-255')
  })

  it('decodes a populated glyph map for the printable ASCII range', () => {
    const stack = decodeGlyphsPbf(buf)[0]!
    // Latin printable codepoints 0x20–0x7E ought to be present in any
    // Open Sans build. Assert a generous count — exact value depends on
    // which glyphs the PBF actually carries (servers sometimes ship
    // narrower coverage for narrow ranges).
    expect(stack.glyphs.size).toBeGreaterThan(80)
    expect(stack.glyphs.has(0x41)).toBe(true)  // 'A'
    expect(stack.glyphs.has(0x61)).toBe(true)  // 'a'
    expect(stack.glyphs.has(0x30)).toBe(true)  // '0'
  })

  it('spot-checks "A" — non-empty bitmap, plausible metrics', () => {
    const stack = decodeGlyphsPbf(buf)[0]!
    const A = stack.glyphs.get(0x41)!
    expect(A.id).toBe(0x41)
    // PBF rasterizes at 24 px. "A" at Semibold should be ≈14×17 with
    // 6 px buffer on each axis. Generous bounds — the exact pixels
    // depend on the rasteriser used to build the PBF.
    expect(A.width).toBeGreaterThanOrEqual(10)
    expect(A.width).toBeLessThanOrEqual(20)
    expect(A.height).toBeGreaterThanOrEqual(12)
    expect(A.height).toBeLessThanOrEqual(22)
    expect(A.advance).toBeGreaterThan(10)
    expect(A.advance).toBeLessThan(20)
    // Bitmap dimensions = (width + 6) × (height + 6).
    expect(A.bitmap.length).toBe((A.width + 6) * (A.height + 6))
    // SDF must contain the edge value (192). If everything is 0 the
    // decoder is dropping bytes; if everything is 255 the wire type
    // was misread.
    const hasEdge = A.bitmap.some(b => b >= 180 && b <= 210)
    expect(hasEdge).toBe(true)
  })

  it('handles a glyph without a bitmap (space character)', () => {
    const stack = decodeGlyphsPbf(buf)[0]!
    const space = stack.glyphs.get(0x20)
    // Some PBF builds omit space entirely (advance-only); others ship a
    // zero bitmap. Either is fine — we just need decode to not throw.
    if (space) {
      expect(space.advance).toBeGreaterThan(0)
      // width/height may legitimately be 0 for whitespace.
      expect(space.width).toBeGreaterThanOrEqual(0)
    }
  })

  it('every decoded bitmap matches its declared dimensions', () => {
    const stack = decodeGlyphsPbf(buf)[0]!
    for (const g of stack.glyphs.values()) {
      // Glyphs without a bitmap return Uint8Array(0); those with one
      // must satisfy the (w+6)(h+6) rule.
      if (g.bitmap.length === 0) continue
      expect(g.bitmap.length).toBe((g.width + 6) * (g.height + 6))
    }
  })
})
