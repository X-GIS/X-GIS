import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeGlyphsPbf } from './glyphs-proto'
import { pbfGlyphToSlot } from './pbf-to-slot'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf')
const buf = new Uint8Array(readFileSync(FIXTURE))
const stack = decodeGlyphsPbf(buf)[0]!

describe('pbfGlyphToSlot — scaled SDF re-encoding', () => {
  const slotSize = 64
  const sdfRadius = 8
  const rasterFontSize = 32

  it('produces a slot-sized SDF buffer with edge bytes present', () => {
    const A = stack.glyphs.get(0x41)!
    const out = pbfGlyphToSlot(A, 'Open Sans Semibold', slotSize, sdfRadius, rasterFontSize)
    expect(out.sdf.length).toBe(slotSize * slotSize)
    // 192 is the post-encode edge. Some pixel must straddle it.
    let edgeHit = false
    for (let i = 0; i < out.sdf.length; i++) {
      if (out.sdf[i]! >= 180 && out.sdf[i]! <= 210) { edgeHit = true; break }
    }
    expect(edgeHit).toBe(true)
  })

  it('keeps metrics at the PBF 24-px native reference (identity, DPR-independent)', () => {
    // PBF is now baked 1:1 at its 24-px reference regardless of the
    // (DPR-scaled) engine rasterFontSize — the renderer scales each
    // glyph by sizePx / rasterFontSize at draw time, and pbf-to-slot
    // reports rasterFontSize = 24 so display size is unchanged while
    // the SDF stays an identity copy (no resample softening).
    const A = stack.glyphs.get(0x41)!
    const out = pbfGlyphToSlot(A, 'Open Sans Semibold', slotSize, sdfRadius, rasterFontSize)
    expect(out.rasterFontSize).toBe(24)
    expect(out.advanceWidth).toBeCloseTo(A.advance, 5)
    expect(out.bearingX).toBeCloseTo(A.left, 5)
    expect(out.bearingY).toBeCloseTo(A.top, 5)
    expect(out.width).toBeCloseTo(A.width, 5)
    expect(out.height).toBeCloseTo(A.height, 5)
  })

  it('threads fontKey + codepoint + sdfRadius through unchanged', () => {
    const A = stack.glyphs.get(0x41)!
    const out = pbfGlyphToSlot(A, 'Test Family Bold', slotSize, sdfRadius, rasterFontSize)
    expect(out.fontKey).toBe('Test Family Bold')
    expect(out.codepoint).toBe(0x41)
    expect(out.sdfRadius).toBe(sdfRadius)
  })

  it('handles bitmap-less glyphs (whitespace) without throwing', () => {
    const space = stack.glyphs.get(0x20)
    // If the fixture omits space, synthesize a stand-in to exercise the
    // zero-bitmap branch unconditionally.
    const g = space?.bitmap.length === 0
      ? space
      : { id: 0x20, bitmap: new Uint8Array(0), width: 0, height: 0,
          left: 0, top: 0, advance: 6 }
    const out = pbfGlyphToSlot(g, 'X', slotSize, sdfRadius, rasterFontSize)
    expect(out.sdf.length).toBe(slotSize * slotSize)
    // No glyph silhouette → SDF should be far-outside everywhere.
    // computeSDF emits 0 for "far outside".
    expect(out.sdf.every(b => b === 0)).toBe(true)
  })

  it('SDF interior is denser than the boundary band (sanity)', () => {
    // computeSDF puts edge at 192, interior > 192, exterior < 192.
    // For a solid letter like "A" at least one pixel is comfortably
    // inside the stroke — we just need maxByte > edge to prove the
    // re-encode produced a non-degenerate SDF. (Hollow letters like
    // "O" have very thin strokes so don't peak much above edge.)
    const A = stack.glyphs.get(0x41)!
    const out = pbfGlyphToSlot(A, 'X', slotSize, sdfRadius, rasterFontSize)
    let maxByte = 0
    for (let i = 0; i < out.sdf.length; i++) maxByte = Math.max(maxByte, out.sdf[i]!)
    expect(maxByte).toBeGreaterThan(200)
  })
})
