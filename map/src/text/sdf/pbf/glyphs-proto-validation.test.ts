import { describe, it, expect } from 'vitest'
import { decodeGlyphsPbf } from './glyphs-proto'

// Cross-field validation: a glyph whose declared width/height are
// inconsistent with its bitmap length (or exceed the sane dimension
// ceiling) is malformed/forged and must be dropped/zeroed so the
// rasteriser falls back to Canvas2D rather than copying a bitmap that
// does not match its declared box.

// Minimal protobuf encoders (matching ./varint's wire reading).
function varint(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}
function lenDelim(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload]
}
function str(field: number, s: string): number[] {
  return lenDelim(field, [...new TextEncoder().encode(s)])
}
function u32(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)]
}

// glyph message: id(1), bitmap(2), width(3), height(4), left(5), top(6), advance(7)
function glyph(opts: {
  id: number
  bitmap: number[]
  width: number
  height: number
  advance?: number
}): number[] {
  return [
    ...u32(1, opts.id),
    ...lenDelim(2, opts.bitmap),
    ...u32(3, opts.width),
    ...u32(4, opts.height),
    ...u32(7, opts.advance ?? 10),
  ]
}

function fontstack(name: string, range: string, glyphs: number[][]): number[] {
  const body = [...str(1, name), ...str(2, range)]
  for (const g of glyphs) body.push(...lenDelim(3, g))
  return body
}

function glyphsPbf(stacks: number[]): Uint8Array {
  return new Uint8Array(stacks)
}

describe('decodeGlyphsPbf — glyph dimension cross-validation', () => {
  it('drops a glyph whose bitmap length is inconsistent with width/height', () => {
    // width=10, height=10 → expected (10+6)*(10+6) = 256 bytes, but ship 4.
    const bad = glyph({ id: 0x41, bitmap: [1, 2, 3, 4], width: 10, height: 10 })
    const buf = glyphsPbf(lenDelim(1, fontstack('Bad', '0-255', [bad])))
    const stack = decodeGlyphsPbf(buf)[0]!
    const g = stack.glyphs.get(0x41)!
    // Bitmap dropped, bbox zeroed → rasteriser falls back to Canvas2D.
    expect(g.bitmap.length).toBe(0)
    expect(g.width).toBe(0)
    expect(g.height).toBe(0)
    // advance is preserved (advance-only entry is valid).
    expect(g.advance).toBe(10)
  })

  it('drops a glyph whose declared dimensions exceed the sane ceiling', () => {
    // Huge width with a 1-byte bitmap (the DoS-shaped input). Even if a
    // length match were somehow forged, the ceiling alone rejects it.
    const huge = glyph({ id: 0x42, bitmap: [1], width: 200_000_000, height: 50 })
    const buf = glyphsPbf(lenDelim(1, fontstack('Huge', '0-255', [huge])))
    const stack = decodeGlyphsPbf(buf)[0]!
    const g = stack.glyphs.get(0x42)!
    expect(g.bitmap.length).toBe(0)
    expect(g.width).toBe(0)
    expect(g.height).toBe(0)
  })

  it('keeps a glyph whose bitmap length matches (width+6)*(height+6)', () => {
    const w = 4,
      h = 4
    const expected = (w + 6) * (h + 6) // 100
    const ok = glyph({
      id: 0x43,
      bitmap: new Array(expected).fill(192),
      width: w,
      height: h,
    })
    const buf = glyphsPbf(lenDelim(1, fontstack('OK', '0-255', [ok])))
    const stack = decodeGlyphsPbf(buf)[0]!
    const g = stack.glyphs.get(0x43)!
    expect(g.width).toBe(w)
    expect(g.height).toBe(h)
    expect(g.bitmap.length).toBe(expected)
  })
})
