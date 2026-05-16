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
import { wrapForTesting } from './text-stage'

const A = 0x41          // Latin 'A' — not breakable, not ideographic
const SP = 0x20         // space — whitespace + breakable
const CJK = 0x4e2d      // '中' — ideographic-breakable, not whitespace
const ZWSP = 0x200b     // zero-width space

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
    // space break wins: ["AAA ", "中中中中中中中​"].
    const cps = [A, A, A, SP, CJK, CJK, CJK, CJK, CJK, CJK, CJK, ZWSP]
    const adv = cps.map(cp => (cp === ZWSP ? 0 : 10))
    const lines = wrapForTesting(cps, adv, 55)
    expect(lines.length).toBe(2)
    expect(lines[0]!.end).toBe(4)   // break right after the space
  })

  it('B: determineAverageLineWidth includes whitespace advance (drives lineCount)', () => {
    // "A A A A A", A=30, space=10. Excluding spaces totalWidth=150 →
    // ceil(150/160)=1 line. Including them totalWidth=190 →
    // ceil(190/160)=2 lines. MapLibre includes whitespace.
    const cps = [A, SP, A, SP, A, SP, A, SP, A]
    const adv = cps.map(cp => (cp === SP ? 10 : 30))
    const lines = wrapForTesting(cps, adv, 160)
    expect(lines.length).toBe(2)
  })
})
