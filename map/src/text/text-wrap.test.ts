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

  it('control: a LEADING blank is deliberately still measured — trimming it without moving `start` would shift ink', () => {
    // "AB\n  CD" — the `\n` forces a fresh segment starting "  CD".
    // With a generous maxWidth the segment stays one line, so its
    // emitted range is the WHOLE segment [3,7) — start lands directly
    // on the first of the two leading spaces.
    //
    // This case is EXCLUDED from the fix on purpose. text-stage-helpers'
    // `fillLineWithInlineImages` starts its pen at `lineX` and advances
    // through every glyph in [start, end), so the two leading spaces are
    // consumed before any ink. Narrowing the width to 20 while `start`
    // stays 3 would set `lineX = totalAdvance - 20` on right-justify and
    // then push the ink 20px past it — worse than the 10px half-shift the
    // untrimmed width produces. The MapLibre-faithful form advances
    // `start` as well, which the inline-sprite index filter makes a
    // separate change (#2446). Pinned here so a future "symmetry" edit
    // has to argue with a red test.
    const NL = 0x0a
    const cps = [A, 0x42 /* B */, NL, SP, SP, 0x43 /* C */, 0x44 /* D */]
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, 1000)
    expect(lines.length).toBe(2)
    expect(lines[0]).toEqual({ start: 0, end: 2, width: 20 }) // "AB" — unaffected
    expect(lines[1]!.start).toBe(3) // index unchanged: still points at the first leading space
    expect(lines[1]!.end).toBe(7)
    expect(lines[1]!.width).toBe(40) // "  CD" — leading run still counted, trailing "D" is not whitespace
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

  it('Infinity path (no wrap): a single unwrapped line trims its trailing whitespace run', () => {
    const cps = [SP, SP, 0x48 /* H */, 0x69 /* i */, SP, SP]
    const adv = cps.map(() => 10)
    const lines = wrapForTesting(cps, adv, Infinity)
    expect(lines.length).toBe(1)
    expect(lines[0]!.start).toBe(0) // index unchanged
    expect(lines[0]!.end).toBe(6)
    // Both trailing spaces drop (60 → 40); the two leading ones stay, per
    // the control above — the pen consumes them, so the width must too.
    expect(lines[0]!.width).toBe(40)
  })
})
