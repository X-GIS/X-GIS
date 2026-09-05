// Knuth-Plass line-break parity with MapLibre `tagged_string.ts`
// (`determineLineBreaks` / `determineAverageLineWidth` /
// `calculatePenalty`). Two divergences these tests pin:
//
//   A. The +150 ideographic-break penalty applies ONLY when the
//      text contains a U+200B zero-width space — MapLibre passes
//      `ideographicBreak && hasZeroWidthSpaces` to calculatePenalty.
//      X-GIS used to always penalise, so CJK/Latin labels without a
//      ZWSP (e.g. OFM Bright "Yellow Sea / 黄海 / 황해 / 조선서해")
//      avoided CJK breaks and split the Latin word instead.
//
//   B. `determineAverageLineWidth` sums advance+spacing for EVERY
//      char including whitespace. X-GIS used to skip whitespace,
//      giving a smaller totalWidth → wrong lineCount/targetWidth.

import { describe, it, expect } from 'vitest'
import { wrapForTesting } from '@xgis/map'

const A = 0x41 // Latin 'A' — not breakable, not ideographic
const SP = 0x20 // space — whitespace + breakable
const CJK = 0x4e2d // '中' — ideographic-breakable, not whitespace
const ZWSP = 0x200b // zero-width space

describe('Knuth-Plass wrap — MapLibre parity', () => {
  it('A: no ZWSP → ideographic breaks are NOT penalised (balances via a CJK break, keeps the Latin word whole)', () => {
    // "AAA 中中中中中中中", advances 10 each (space 10). With the
    // +150 penalty suppressed (no ZWSP) MapLibre balances the two
    // lines using a mid-CJK break: ["AAA 中中", "中中中中中"].
    const cps = [A, A, A, SP, CJK, CJK, CJK, CJK, CJK, CJK, CJK]
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, 55)
    expect(lines.length).toBe(2)
    // Break at the ideograph (index 6), NOT at the space (index 4).
    expect(lines[0]!.end).toBe(6)
    expect(lines[1]!.start).toBe(6)
  })

  it('C: WITH ZWSP → ideographic breaks ARE penalised (MapLibre parity preserved → breaks at the space)', () => {
    // Same content + a trailing U+200B (advance 0). hasZeroWidthSpaces
    // is now true, so the +150 CJK-break penalty applies and the
    // eslint-disable-next-line no-irregular-whitespace -- test-data comment shows the literal CJK + U+200B input
    // space break wins: ["AAA ", "中中中中中中中​"].
    const cps = [A, A, A, SP, CJK, CJK, CJK, CJK, CJK, CJK, CJK, ZWSP]
    const adv = cps.map((cp) => (cp === ZWSP ? 0 : 10))
    const lines = wrapForTesting(cps, adv, 55)
    expect(lines.length).toBe(2)
    expect(lines[0]!.end).toBe(4) // break right after the space
  })

  it('B: determineAverageLineWidth includes whitespace advance (drives lineCount)', () => {
    // "A A A A A", A=30, space=10. Excluding spaces totalWidth=150 →
    // ceil(150/160)=1 line. Including them totalWidth=190 →
    // ceil(190/160)=2 lines. MapLibre includes whitespace.
    const cps = [A, SP, A, SP, A, SP, A, SP, A]
    const adv = cps.map((cp) => (cp === SP ? 10 : 30))
    const lines = wrapForTesting(cps, adv, 160)
    expect(lines.length).toBe(2)
  })
})

// #2336 — a wrapped line's `.width` must exclude the TRAILING break-glyph
// advance, mirroring the trailing half of MapLibre's per-line
// `TaggedString.trim()`. The break INDICES (`.start`/`.end`) are
// a separate concern — the badness DP that picks them never changes —
// so every case below pins both: the trimmed width AND the untouched
// index. This is exactly the offset a centred/right-justified label
// shows: text-stage-helpers.ts derives `lineX` straight from `.width`,
// so a line-width that is one space too wide shifts every glyph on that
// line by half the space's advance and over-widens the collision bbox.
describe('Knuth-Plass wrap — line-width trims trailing whitespace (#2336)', () => {
  it('witness: "Sea of Japan" wrapped at 70px — line 0 measures "Sea of" (60), not "Sea of " (70)', () => {
    // Exactly the issue's cited repro: 12 glyphs, advance 10 each.
    const text = 'Sea of Japan'
    const cps = [...text].map((c) => c.codePointAt(0)!)
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, 70)
    expect(lines.length).toBe(2)
    // Break index is unchanged: the emitted range still spans "Sea of "
    // (space included) — only the MEASURED width narrows.
    expect(lines[0]!.start).toBe(0)
    expect(lines[0]!.end).toBe(7)
    expect(lines[0]!.width).toBe(60) // was 70 pre-fix (included the space)
    // Second line has no boundary whitespace — unaffected.
    expect(lines[1]!.start).toBe(7)
    expect(lines[1]!.end).toBe(12)
    expect(lines[1]!.width).toBe(50)
  })

  it('control: a wrap whose break lands on a non-whitespace glyph is byte-identical to the raw range sum', () => {
    // Same input as test A above (break lands on a CJK glyph, not a
    // space) — proves the fix NARROWS measurement only where a
    // boundary is actually whitespace; it must not touch this case.
    const cps = [A, A, A, SP, CJK, CJK, CJK, CJK, CJK, CJK, CJK]
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, 55)
    expect(lines.length).toBe(2)
    expect(lines[0]).toEqual({ start: 0, end: 6, width: 60 }) // "AAA 中中", no boundary whitespace
    expect(lines[1]).toEqual({ start: 6, end: 11, width: 50 }) // "中中中中中"
  })

  describe('#2446 — leading whitespace moves `start` WITH the width (MapLibre `trim()` on both ends)', () => {
    const NL = 0x0a
    const B = 0x42
    const C = 0x43
    const D = 0x44

    it('a segment that begins on whitespace ("AB\\n  CD") emits line 1 as {start: 5, end: 7, width: 20}', () => {
      // The `\n` forces a fresh segment starting "  CD". With a generous
      // maxWidth the segment stays one line; `start` must land on "C",
      // not on the first blank, and the width must be "CD" only — the
      // pen in `fillLineWithInlineImages` starts at `lineX` on glyph
      // `start`, so moving one without the other shifts the ink (the
      // issue's rejected width-only form). `end` stays the literal
      // break index.
      const cps = [A, B, NL, SP, SP, C, D]
      const adv = cps.map(() => 10)
      const lines = wrapForTesting(cps, adv, 1000)
      expect(lines.length).toBe(2)
      expect(lines[0]).toEqual({ start: 0, end: 2, width: 20 }) // "AB" — unaffected
      expect(lines[1]).toEqual({ start: 5, end: 7, width: 20 }) // "CD" — both blanks trimmed
    })

    it('the FIRST line trims too: " CD" → {start: 1, end: 3, width: 20}', () => {
      const cps = [SP, C, D]
      const adv = cps.map(() => 10)
      expect(wrapForTesting(cps, adv, 1000)).toEqual([{ start: 1, end: 3, width: 20 }])
    })

    it('an all-whitespace segment collapses to an EMPTY line that still takes a line feed', () => {
      // MapLibre `shapeLines`: a line that trims to nothing still adds
      // `lineHeight` ("Still need a line feed after empty line").
      const cps = [A, B, NL, SP]
      const adv = cps.map(() => 10)
      const lines = wrapForTesting(cps, adv, 1000)
      expect(lines.length).toBe(2)
      expect(lines[1]).toEqual({ start: 4, end: 4, width: 0 })
    })

    it('an inline image anchored ON the leading blank stops the trim — the image precedes the blank', () => {
      // "⟨img⟩ CD": parseInlineImages strips to " CD" with the image at
      // glyphIndex 0 (inserted BEFORE glyph 0). In MapLibre the image is a
      // section character, so `trim()` stops at it and the blank is
      // interior: width = blank + C + D. Trimming here would ALSO move
      // `start` past the image's anchor, and the sprite filter in
      // `fillPointGlyphOffsetsWithImages` (`glyphIndex >= start`) would
      // drop the image.
      const cps = [SP, C, D]
      const adv = cps.map(() => 10)
      expect(wrapForTesting(cps, adv, 1000, 0, [0])).toEqual([{ start: 0, end: 3, width: 30 }])
    })

    it('an inline image anchored AFTER the leading blank does not stop the trim (" ⟨img⟩CD")', () => {
      const cps = [SP, C, D]
      const adv = cps.map(() => 10)
      // The anchor (1) stays inside the emitted [start, end].
      expect(wrapForTesting(cps, adv, 1000, 0, [1])).toEqual([{ start: 1, end: 3, width: 20 }])
    })

    it('the mirror on the trailing side: an image anchored at `end` keeps the blank before it in the width', () => {
      // "CD ⟨img⟩" → "CD " with the image at glyphIndex 3 (after the last
      // glyph). The pen consumes the blank and THEN emits the image, so
      // the block must measure C + D + blank (30) — the #2336 trailing
      // trim alone (20) under-measures the block by the blank.
      const cps = [C, D, SP]
      const adv = cps.map(() => 10)
      expect(wrapForTesting(cps, adv, 1000, 0, [3])).toEqual([{ start: 0, end: 3, width: 30 }])
      // Control — no image: the #2336 trailing trim stands.
      expect(wrapForTesting(cps, adv, 1000)).toEqual([{ start: 0, end: 3, width: 20 }])
    })

    it('the wrap cache keys on the anchors: the same glyph run with and without an image must not share an entry', () => {
      // Same codepoints, advances, font key, size, spacing and maxWidth —
      // only the image differs. Without the anchor folded into
      // `pretextCacheKey`, the second call would return the first call's
      // cached (trimmed) lines. Order matters: plain first, so the plain
      // entry is the one a colliding key would serve.
      const cps = [SP, C, D]
      const adv = cps.map(() => 10)
      expect(wrapForTesting(cps, adv, 640)).toEqual([{ start: 1, end: 3, width: 20 }])
      expect(wrapForTesting(cps, adv, 640, 0, [0])).toEqual([{ start: 0, end: 3, width: 30 }])
      expect(wrapForTesting(cps, adv, 640)).toEqual([{ start: 1, end: 3, width: 20 }]) // LRU hit, still trimmed
    })
  })

  it('consecutive-space run + centre/right-justify symptom: no emitted line ever measures a boundary space', () => {
    // "A  A  A  A  A" (double spaces). Whatever the DP's break choice,
    // no returned line's width may include a leading or trailing
    // space advance — verified generically by re-trimming the same
    // [start,end) range independently in the test and comparing.
    const cps = [A, SP, SP, A, SP, SP, A, SP, SP, A, SP, SP, A]
    const adv = cps.map((cp) => (cp === SP ? 10 : 30))
    const lines = wrapForTesting(cps, adv, 100)
    expect(lines.length).toBeGreaterThan(1)
    for (const ln of lines) {
      let e = ln.end
      while (e > ln.start && cps[e - 1] === SP) e--
      let expectedWidth = 0
      for (let i = ln.start; i < e; i++) expectedWidth += adv[i]!
      expect(ln.width).toBe(expectedWidth)
    }
  })

  it('Infinity path (no wrap): a single unwrapped line trims its whitespace runs on both ends', () => {
    const cps = [SP, SP, 0x48 /* H */, 0x69 /* i */, SP, SP]
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, Infinity)
    expect(lines.length).toBe(1)
    // Both trailing spaces drop from the width (`end` stays literal —
    // the pen consumes them, they render no ink); the two leading ones
    // drop from the width AND move `start` past them (#2446).
    expect(lines[0]!.start).toBe(2)
    expect(lines[0]!.end).toBe(6)
    expect(lines[0]!.width).toBe(20)
  })
})
