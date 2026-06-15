import { describe, it, expect } from 'vitest'
import { decodeGlyphsPbf } from './glyphs-proto'

// Amplification-DoS cap on the COUNT of decoded glyph/fontstack entries.
//
// #341 capped per-glyph DIMENSION; it did NOT bound how MANY glyphs a fontstack
// (or how many fontstacks a PBF) may declare. The input is capped at 8 MB
// (MAX_GLYPH_BYTES), but a minimal advance-only glyph submessage is only a few
// bytes — 8 MB packs ~1.4M of them, each landing in a Map entry (~336 MB
// resident). The fix adds MAX_GLYPHS_PER_STACK (1024) + MAX_FONTSTACKS (64):
// once a cap is hit, decoding stops adding (drops the excess) — fail-closed,
// never throws, mirroring the #341 dimension cap.
//
// These tests pin that a fontstack body packing FAR more than the cap decodes
// to AT MOST the cap (pre-fix: the full injected count, far exceeding it).

const CAP = 1024 // MAX_GLYPHS_PER_STACK (kept in sync with glyphs-proto.ts)

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

/** Minimal advance-only glyph: id(1) + advance(7), NO bitmap. A few bytes
 *  each — the amplification-shaped input. */
function advanceOnlyGlyph(id: number): number[] {
  return [...u32(1, id), ...u32(7, 10)]
}

/** fontstack with `count` distinct-id advance-only glyphs. */
function fontstackWithGlyphs(name: string, count: number): number[] {
  const body = [...str(1, name), ...str(2, '0-65535')]
  for (let id = 0; id < count; id++) body.push(...lenDelim(3, advanceOnlyGlyph(id)))
  return body
}

describe('decodeGlyphsPbf — glyph/fontstack COUNT cap (amplification DoS)', () => {
  it('drops glyphs past MAX_GLYPHS_PER_STACK (a fontstack of 1500 → at most the cap)', () => {
    const injected = 1500 // > CAP
    const buf = new Uint8Array(lenDelim(1, fontstackWithGlyphs('Flood', injected)))
    const stacks = decodeGlyphsPbf(buf)
    expect(stacks.length).toBe(1)
    // PRE-FIX: stacks[0].glyphs.size === 1500 (every injected entry retained).
    // POST-FIX: bounded at the cap.
    expect(stacks[0].glyphs.size).toBeLessThanOrEqual(CAP)
    // And the kept entries are the in-range ones (ids 0..CAP-1) — the cap stops
    // adding rather than corrupting earlier glyphs.
    expect(stacks[0].glyphs.size).toBe(CAP)
    expect(stacks[0].glyphs.has(0)).toBe(true)
    expect(stacks[0].glyphs.has(CAP - 1)).toBe(true)
    expect(stacks[0].glyphs.has(CAP)).toBe(false)
  })

  it('still decodes a normal (under-cap) fontstack fully', () => {
    const buf = new Uint8Array(lenDelim(1, fontstackWithGlyphs('Normal', 200)))
    const stacks = decodeGlyphsPbf(buf)
    expect(stacks.length).toBe(1)
    expect(stacks[0].glyphs.size).toBe(200)
  })
})
