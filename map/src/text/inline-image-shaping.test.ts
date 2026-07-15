// Inline-image label shaping (#777 I-G). The converter lowers a Mapbox
// `["image", name]` (bare text-field OR a `["format", …]` section) to a
// resolved string carrying `⟨START⟩name⟨END⟩` sentinels. These tests pin
// the two pure shaping primitives:
//   1. parseInlineImages     — carve the sentinels out, locate each image
//   2. fillLineWithInlineImages — splice the sprite advance into the pen so
//      the post-image text shifts right by exactly the image CSS width.

import { describe, expect, it } from 'vitest'
import { inlineImageMarker } from '@xgis/compiler'
import {
  parseInlineImages,
  fillLineWithInlineImages,
  fillPointGlyphOffsetsWithImages,
  type InlineImageSprite,
  type ShapedInlineImage,
} from './text-stage-helpers'

describe('#777 I-G — parseInlineImages', () => {
  it('no marker → fast path returns the text verbatim, no images', () => {
    expect(parseInlineImages('Main St')).toEqual({ stripped: 'Main St', images: [] })
  })

  it('[text, image, text] → stripped text + image at the right codepoint index', () => {
    // "AB" + image(pat) + "CD" — the image sits after 2 text codepoints.
    const src = 'AB' + inlineImageMarker('pat') + 'CD'
    const { stripped, images } = parseInlineImages(src)
    expect(stripped).toBe('ABCD')
    expect(images).toEqual([{ name: 'pat', glyphIndex: 2 }])
  })

  it('bare image text-field → empty stripped text, image at index 0', () => {
    const { stripped, images } = parseInlineImages(inlineImageMarker('pat'))
    expect(stripped).toBe('')
    expect(images).toEqual([{ name: 'pat', glyphIndex: 0 }])
  })

  it('multiple images keep independent codepoint indices', () => {
    const src = inlineImageMarker('a') + 'XY' + inlineImageMarker('b') + 'Z'
    const { stripped, images } = parseInlineImages(src)
    expect(stripped).toBe('XYZ')
    expect(images).toEqual([
      { name: 'a', glyphIndex: 0 },
      { name: 'b', glyphIndex: 2 },
    ])
  })
})

describe('#777 I-G — fillLineWithInlineImages', () => {
  const advances = [10, 10, 10, 10] // 4 glyphs, 10px advance each

  it('no images → plain left-to-right pen positions (unchanged layout)', () => {
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const w = fillLineWithInlineImages(off, advances, 0, 4, 0, 0, 0, 16, [], out)
    expect(Array.from(off)).toEqual([0, 0, 10, 0, 20, 0, 30, 0])
    expect(out).toEqual([])
    expect(w).toBe(40)
  })

  it('image at index 2 advances the post-image glyphs by the image width', () => {
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const imgs: InlineImageSprite[] = [{ name: 'pat', glyphIndex: 2, advancePx: 16, heightPx: 16 }]
    const w = fillLineWithInlineImages(off, advances, 0, 4, 0, 0, 0, 16, imgs, out)
    // Pre-image glyphs unchanged; post-image glyphs (2,3) shifted by +16.
    expect(off[0]).toBe(0) // glyph 0
    expect(off[2]).toBe(10) // glyph 1
    expect(off[4]).toBe(36) // glyph 2 = 20 + 16 (image width)
    expect(off[6]).toBe(46) // glyph 3 = 30 + 16
    // The image itself lands at the pen right after glyph 1 (x = 20).
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('pat')
    expect(out[0]!.dx).toBe(20)
    expect(out[0]!.wPx).toBe(16)
    expect(out[0]!.hPx).toBe(16)
    // Vertically centred on the x-height band: dy = lineY − 0.25·sizePx − h/2.
    expect(out[0]!.dy).toBe(0 - 0.25 * 16 - 16 / 2) // = -12
    // Total line width includes the image advance.
    expect(w).toBe(56)
  })

  it('letter-spacing applies between glyphs but not around the image', () => {
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const imgs: InlineImageSprite[] = [{ name: 'pat', glyphIndex: 2, advancePx: 16, heightPx: 16 }]
    // ls=2 between adjacent glyphs. glyph1 = 0+10+2 = 12; image at pen 24
    // (12+10+2); glyph2 = 24+16 = 40; glyph3 = 40+10+2 = 52.
    fillLineWithInlineImages(off, advances, 0, 4, 2, 0, 0, 16, imgs, out)
    expect(off[2]).toBe(12)
    expect(out[0]!.dx).toBe(24)
    expect(off[4]).toBe(40)
    expect(off[6]).toBe(52)
  })

  it('startX offset (justify) shifts glyphs and image together', () => {
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const imgs: InlineImageSprite[] = [{ name: 'pat', glyphIndex: 0, advancePx: 16, heightPx: 16 }]
    fillLineWithInlineImages(off, advances, 0, 4, 0, 100, 5, 16, imgs, out)
    // Leading image at startX; glyphs follow.
    expect(out[0]!.dx).toBe(100)
    expect(off[0]).toBe(116) // glyph 0 after the 16px image
    expect(off[1]).toBe(5) // lineY carried through
  })

  it('missing sprite → excluded from lineImages → text keeps its plain layout', () => {
    // The integration drops an image whose sprite is absent from the atlas
    // (no InlineImageSprite built), so the surrounding text lays out exactly
    // as if there were no image — MapLibre "keep the text, drop the image".
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    fillLineWithInlineImages(off, advances, 0, 4, 0, 0, 0, 16, [], out)
    expect(Array.from(off)).toEqual([0, 0, 10, 0, 20, 0, 30, 0])
    expect(out).toEqual([])
  })
})

describe('#777 I-G — fillPointGlyphOffsetsWithImages (multi-line + justify)', () => {
  const advances = [10, 10, 10, 10]

  it('centre justify: image widens the block; the single line stays centred', () => {
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const lines = [{ start: 0, end: 4, width: 40 }]
    const imgs: InlineImageSprite[] = [{ name: 'pat', glyphIndex: 2, advancePx: 16, heightPx: 16 }]
    // totalAdvance = text(40) + image(16) = 56; lineWidth incl image = 56 →
    // centre offset (56-56)/2 = 0, so the line starts at 0.
    fillPointGlyphOffsetsWithImages(off, advances, lines, [0], 0, 0, 56, 'center', 16, imgs, out)
    expect(off[0]).toBe(0)
    expect(off[4]).toBe(36) // glyph 2 after the image
    expect(out[0]!.dx).toBe(20)
  })

  it('two lines: a boundary image emits once, on the line owning its index', () => {
    // Line 0 = glyphs [0,2), line 1 = glyphs [2,4). An image at glyphIndex 2
    // belongs to line 1 (start), NOT line 0 (end) — emitted exactly once.
    const off = new Float32Array(8)
    const out: ShapedInlineImage[] = []
    const lines = [
      { start: 0, end: 2, width: 20 },
      { start: 2, end: 4, width: 20 },
    ]
    const imgs: InlineImageSprite[] = [{ name: 'pat', glyphIndex: 2, advancePx: 16, heightPx: 16 }]
    fillPointGlyphOffsetsWithImages(off, advances, lines, [0, 30], 0, 0, 36, 'left', 16, imgs, out)
    expect(out).toHaveLength(1) // NOT double-emitted at the line boundary
    // Line 1 (left justify) starts at 0: image at 0, glyph 2 at 16, glyph 3 at 26.
    expect(out[0]!.dx).toBe(0)
    expect(off[4]).toBe(16)
    expect(off[6]).toBe(26)
    expect(off[5]).toBe(30) // line-1 baseline Y carried onto its glyphs
  })
})
