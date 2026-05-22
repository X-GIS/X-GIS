// iter-318 — Text layout edge probes. Label corruption (iter-268/
// 272/274/280) is the most user-reported class. The two pure layout
// functions — wrap (Knuth-Plass line breaking) + mlVerticalLayout
// (per-line baseline) — feed glyph quad positions directly. A NaN
// baseline or a wrap that returns no lines = invisible / misplaced
// label.
//
// Render-error contracts:
//   wrap:  every line covers a contiguous, in-bounds glyph range;
//          union of ranges == full input; widths finite ≥ 0.
//   mlVerticalLayout: every baselineY finite; blockTop ≤ blockBottom.

import { describe, it, expect } from 'vitest'
import { wrapForTesting, mlVerticalLayout } from './text-stage'

// Uniform-advance helper: n glyphs each `adv` px wide.
function uniform(n: number, cp = 65, adv = 10): { cps: number[]; adv: number[] } {
  return {
    cps: Array.from({ length: n }, () => cp),
    adv: Array.from({ length: n }, () => adv),
  }
}

describe('iter-318 wrap (Knuth-Plass) edge cases', () => {
  it('empty input → no lines (or one empty line), no crash', () => {
    expect(() => wrapForTesting([], [], 100)).not.toThrow()
    const lines = wrapForTesting([], [], 100)
    // Either [] or a single zero-width line — never NaN width.
    for (const l of lines) expect(Number.isFinite(l.width)).toBe(true)
  })

  it('single glyph fits → one line covering [0,1)', () => {
    const { cps, adv } = uniform(1)
    const lines = wrapForTesting(cps, adv, 100)
    expect(lines.length).toBe(1)
    expect(lines[0]!.start).toBe(0)
    expect(lines[0]!.end).toBe(1)
    expect(Number.isFinite(lines[0]!.width)).toBe(true)
  })

  it('one long unbreakable word wider than maxWidth → still emitted (overflow line)', () => {
    // No space codepoints → no break opportunity. MapLibre emits the
    // word on a single overflowing line rather than dropping it.
    const { cps, adv } = uniform(20, 65, 10)  // 200 px word
    const lines = wrapForTesting(cps, adv, 50)  // maxWidth 50
    expect(lines.length).toBeGreaterThanOrEqual(1)
    // Union of ranges must cover all 20 glyphs.
    const covered = lines.reduce((s, l) => s + (l.end - l.start), 0)
    expect(covered).toBe(20)
    for (const l of lines) expect(Number.isFinite(l.width)).toBe(true)
  })

  it('zero maxWidth → no crash, ranges still cover all glyphs', () => {
    const { cps, adv } = uniform(5)
    expect(() => wrapForTesting(cps, adv, 0)).not.toThrow()
    const lines = wrapForTesting(cps, adv, 0)
    const covered = lines.reduce((s, l) => s + (l.end - l.start), 0)
    expect(covered).toBe(5)
  })

  it('negative maxWidth → no crash', () => {
    const { cps, adv } = uniform(3)
    expect(() => wrapForTesting(cps, adv, -10)).not.toThrow()
  })

  it('lines cover the full input contiguously (no gap / no overlap)', () => {
    // Mix in spaces (cp 32) so there ARE break opportunities.
    const cps = [72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]  // "Hello World"
    const adv = cps.map(() => 12)
    const lines = wrapForTesting(cps, adv, 60)
    let cursor = 0
    for (const l of lines) {
      expect(l.start).toBe(cursor)  // contiguous
      expect(l.end).toBeGreaterThan(l.start)
      cursor = l.end
    }
    expect(cursor).toBe(cps.length)  // covers all
  })

  it('all widths finite + non-negative across 100 random strings', () => {
    let s = 0x7a11
    const rng = () => { s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0; return (s >>> 0) / 0x1_0000_0000 }
    for (let t = 0; t < 100; t++) {
      const n = 1 + Math.floor(rng() * 30)
      const cps = Array.from({ length: n }, () => (rng() < 0.2 ? 32 : 65 + Math.floor(rng() * 26)))
      const adv = cps.map(() => 4 + rng() * 16)
      const lines = wrapForTesting(cps, adv, 40 + rng() * 100)
      const covered = lines.reduce((acc, l) => acc + (l.end - l.start), 0)
      expect(covered).toBe(n)
      for (const l of lines) {
        expect(Number.isFinite(l.width)).toBe(true)
        expect(l.width).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('iter-318 mlVerticalLayout edge cases', () => {
  it('single line, center align → finite baseline + blockTop ≤ blockBottom', () => {
    const r = mlVerticalLayout(0.5, 1, 24, 16)
    expect(r.baselineY.length).toBe(1)
    expect(Number.isFinite(r.baselineY[0]!)).toBe(true)
    expect(r.blockTop).toBeLessThanOrEqual(r.blockBottom)
  })

  it('multi-line baselines monotonically increase (top→bottom)', () => {
    const r = mlVerticalLayout(0.5, 4, 24, 16)
    expect(r.baselineY.length).toBe(4)
    for (let i = 1; i < 4; i++) {
      expect(r.baselineY[i]!).toBeGreaterThan(r.baselineY[i - 1]!)
      expect(Number.isFinite(r.baselineY[i]!)).toBe(true)
    }
  })

  it('all three vAlign values finite (top / center / bottom)', () => {
    for (const va of [0, 0.5, 1] as const) {
      const r = mlVerticalLayout(va, 3, 24, 16)
      for (let i = 0; i < r.baselineY.length; i++) {
        expect(Number.isFinite(r.baselineY[i]!)).toBe(true)
      }
      expect(Number.isFinite(r.blockTop)).toBe(true)
      expect(Number.isFinite(r.blockBottom)).toBe(true)
    }
  })

  it('top-align block top is at/above center-align block top', () => {
    const top = mlVerticalLayout(0, 3, 24, 16)
    const ctr = mlVerticalLayout(0.5, 3, 24, 16)
    const bot = mlVerticalLayout(1, 3, 24, 16)
    // top anchor → block extends downward (blockTop ≈ 0);
    // bottom anchor → block extends upward (blockTop most negative).
    expect(top.blockTop).toBeGreaterThanOrEqual(bot.blockTop)
    expect(ctr.blockTop).toBeGreaterThanOrEqual(bot.blockTop)
    expect(ctr.blockTop).toBeLessThanOrEqual(top.blockTop)
  })

  it('zero lineCount → empty baselines, no crash', () => {
    expect(() => mlVerticalLayout(0.5, 0, 24, 16)).not.toThrow()
    const r = mlVerticalLayout(0.5, 0, 24, 16)
    expect(r.baselineY.length).toBe(0)
  })

  it('large lineCount (50) all finite', () => {
    const r = mlVerticalLayout(0.5, 50, 20, 14)
    expect(r.baselineY.length).toBe(50)
    for (let i = 0; i < 50; i++) expect(Number.isFinite(r.baselineY[i]!)).toBe(true)
  })

  it('blockBottom − blockTop scales with lineCount × lineHeight', () => {
    const one = mlVerticalLayout(0.5, 1, 24, 16)
    const four = mlVerticalLayout(0.5, 4, 24, 16)
    const h1 = one.blockBottom - one.blockTop
    const h4 = four.blockBottom - four.blockTop
    // 4-line block ~4× taller than 1-line.
    expect(h4).toBeGreaterThan(h1 * 3)
  })
})
