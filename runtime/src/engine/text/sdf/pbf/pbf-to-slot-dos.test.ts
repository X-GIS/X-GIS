import { describe, it, expect } from 'vitest'
import { pbfGlyphToSlot } from './pbf-to-slot'
import type { PbfGlyph } from '@xgis/map'

// DoS regression for the slot copier. g.width / g.height are untrusted
// uint32 varints from a network glyph PBF. The original inner loop ran
// the full bw = width + 6 columns per in-range row regardless of the
// per-pixel dstX clip, so a huge `width` paired with a 1-byte bitmap
// (which still passes the `bitmap.length > 0` guard) spun for
// O(slotSize · width) iterations — a multi-second-to-minute freeze on
// the first label using that glyph. No crash (out-of-range reads are
// `undefined → 0`), pure hang.
//
// Tripwire: a tight wall-clock bound. Pre-fix this exceeds it by orders
// of magnitude; post-fix the copy is O(slotSize²) and returns in well
// under a millisecond.

describe('pbfGlyphToSlot — untrusted huge width must not freeze the copy loop', () => {
  const slotSize = 64
  const sdfRadius = 8
  const rasterFontSize = 32

  it('returns within a tight wall-clock bound for a forged 2e8-wide glyph', () => {
    const g: PbfGlyph = {
      id: 0x41,
      width: 200_000_000,
      height: 50,
      advance: 10,
      left: 0,
      top: 0,
      // Passes the length>0 guard but is nowhere near (width+6)(height+6).
      bitmap: new Uint8Array(1),
    }
    const t0 = performance.now()
    const out = pbfGlyphToSlot(g, 'Forged', slotSize, sdfRadius, rasterFontSize)
    const elapsed = performance.now() - t0
    // Pre-fix: ~seconds (≫100ms). Post-fix: sub-millisecond.
    expect(elapsed).toBeLessThan(100)
    // Output is still a valid slot-sized buffer.
    expect(out.sdf.length).toBe(slotSize * slotSize)
  })

  it('also bounds a forged huge height', () => {
    const g: PbfGlyph = {
      id: 0x42,
      width: 50,
      height: 200_000_000,
      advance: 10,
      left: 0,
      top: 0,
      bitmap: new Uint8Array(1),
    }
    const t0 = performance.now()
    const out = pbfGlyphToSlot(g, 'Forged', slotSize, sdfRadius, rasterFontSize)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(100)
    expect(out.sdf.length).toBe(slotSize * slotSize)
  })
})
