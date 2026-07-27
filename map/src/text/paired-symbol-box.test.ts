// A paired symbol — a route shield's `ref` text sharing one anchor with its
// badge sprite — must collide as the BADGE, not as the ref glyphs.
//
// Ground truth: MapLibre GL JS's own collision debug (`showCollisionBoxes`) on
// OFM Positron at #16/37.79172/126.79102 draws the second route-14 shield's box
// in RED — rejected — against the "Wijeon-ri" place label's placed box. X-GIS
// collided on the glyph run alone, which for a two-digit ref is roughly half the
// badge width, so the shield squeezed in and rendered crowding the place name.

import { describe, it, expect } from 'vitest'
import { PairedBadgeBoxes, pairedTextCentreShift } from './paired-symbol-box'

const glyphBox = () => ({ minX: 94, minY: 195, maxX: 106, maxY: 205 })

describe('PairedBadgeBoxes — collision box of a paired symbol', () => {
  it('widens a shield label to its badge, centred on the shared anchor', () => {
    const b = new PairedBadgeBoxes()
    b.set(new Map([['shield:1', { hw: 36, hh: 21 }]]))
    const box = glyphBox()
    b.union('shield:1', 100, 200, box)
    expect(box).toEqual({ minX: 64, minY: 179, maxX: 136, maxY: 221 })
  })

  it('never SHRINKS a box — a badge narrower than its text leaves the run intact', () => {
    // A long name inside a small badge: the glyph run is the binding extent.
    const b = new PairedBadgeBoxes()
    b.set(new Map([['shield:1', { hw: 3, hh: 2 }]]))
    const box = glyphBox()
    b.union('shield:1', 100, 200, box)
    expect(box).toEqual(glyphBox())
  })

  it('leaves an unpaired label, an unknown pairKey, and an empty frame untouched', () => {
    const b = new PairedBadgeBoxes()
    b.set(new Map([['shield:1', { hw: 36, hh: 21 }]]))
    for (const key of [undefined, 'shield:absent']) {
      const box = glyphBox()
      b.union(key, 100, 200, box)
      expect(box, String(key)).toEqual(glyphBox())
    }
    const fresh = new PairedBadgeBoxes()
    const box = glyphBox()
    fresh.union('shield:1', 100, 200, box)
    expect(box).toEqual(glyphBox())
  })

  it('an off-centre anchor grows the side it leans to', () => {
    // The badge is centred on the ANCHOR, not on the glyph box, so a text run
    // laid out to the right of its anchor grows leftward.
    const b = new PairedBadgeBoxes()
    b.set(new Map([['s', { hw: 20, hh: 8 }]]))
    const box = { minX: 100, minY: 195, maxX: 130, maxY: 205 }
    b.union('s', 100, 200, box)
    expect(box).toEqual({ minX: 80, minY: 192, maxX: 130, maxY: 208 })
  })
})

describe('pairedTextCentreShift — the glyph band inside a badge', () => {
  const GLYPHS = [
    { height: 10, bearingY: 8, rasterFontSize: 24 },
    { height: 12, bearingY: 9, rasterFontSize: 24 },
    { height: 0, bearingY: 0, rasterFontSize: 24 }, // blank: junk metrics, skipped
  ]

  it('centres paired centre-anchored text on the band centroid', () => {
    // sc = 24/24 = 1 ⇒ maxAsc 9, maxDesc = max(10-8, 12-9) = 3 ⇒ +3 over the hang.
    expect(pairedTextCentreShift(GLYPHS, 24, 24, 5, true, 0.5)).toBeCloseTo(-5 + 3, 9)
  })

  it('keeps the hang for standalone text and for non-centre vertical alignment', () => {
    expect(pairedTextCentreShift(GLYPHS, 24, 24, 5, false, 0.5)).toBe(-5)
    expect(pairedTextCentreShift(GLYPHS, 24, 24, 5, true, 0)).toBe(-5)
    expect(pairedTextCentreShift(GLYPHS, 24, 24, 5, true, 1)).toBe(-5)
  })

  it('scales the band with sizePx against the glyph raster size', () => {
    expect(pairedTextCentreShift(GLYPHS, 48, 24, 5, true, 0.5)).toBeCloseTo(-5 + 6, 9)
  })

  it('falls back to the stage raster size when a glyph carries none', () => {
    const noRaster = [{ height: 10, bearingY: 8 }]
    expect(pairedTextCentreShift(noRaster, 24, 24, 5, true, 0.5)).toBeCloseTo(-5 + 3, 9)
  })

  it('an all-blank run leaves the plain hang (no NaN from empty metrics)', () => {
    expect(pairedTextCentreShift([{ height: 0, bearingY: 0 }], 24, 24, 5, true, 0.5)).toBe(-5)
  })
})
