// Vertical line-box parity with MapLibre `shaping.ts` (`shapeLines`
// + `align()` + SHAPING_DEFAULT_OFFSET). MapLibre stacks lines in a
// CONSTANT lineHeight box and places each baseline at a fixed
// −17/24-em offset — NOT from per-glyph ink metrics. The old X-GIS
// model used maxAscent/maxDescent, which drifted from MapLibre when
// a bilingual label's lines had different scripts (Latin vs Hangul
// have different ascent/descent). Hand-computed from MapLibre's
// formula: baselineY(li) = li·LH + (−17·sizePx/24) + (−vAlign·n·LH
// + 0.5·LH); blockTop = −vAlign·n·LH.

import { describe, it, expect } from 'vitest'
import { verticalLayoutForTesting as v } from './text-stage'

const LH = 28.8     // 1.2 (text-line-height) * 24 (sizePx)
const SIZE = 24     // → em→px factor 1, SHAPING_DEFAULT_OFFSET px = −17

describe('vertical layout — MapLibre shapeLines parity', () => {
  it('single line, center anchor → baseline at the −17 em offset', () => {
    const r = v(0.5, 1, LH, SIZE)
    expect(r.baselineY).toHaveLength(1)
    expect(r.baselineY[0]!).toBeCloseTo(-17, 6)
    expect(r.blockTop).toBeCloseTo(-14.4, 6)
    expect(r.blockBottom).toBeCloseTo(14.4, 6)
  })

  it('two lines, center anchor → block centered on the anchor', () => {
    const r = v(0.5, 2, LH, SIZE)
    expect(r.baselineY[0]!).toBeCloseTo(-31.4, 6)
    expect(r.baselineY[1]!).toBeCloseTo(-2.6, 6)
    expect(r.blockTop).toBeCloseTo(-28.8, 6)
    expect(r.blockBottom).toBeCloseTo(28.8, 6)
    // Symmetric about the anchor (center alignment).
    expect(r.blockTop + r.blockBottom).toBeCloseTo(0, 6)
  })

  it('two lines, top anchor → block starts at the anchor', () => {
    const r = v(0, 2, LH, SIZE)
    expect(r.baselineY[0]!).toBeCloseTo(-2.6, 6)
    expect(r.baselineY[1]!).toBeCloseTo(26.2, 6)
    expect(r.blockTop).toBeCloseTo(0, 6)
    expect(r.blockBottom).toBeCloseTo(57.6, 6)
  })

  it('two lines, bottom anchor → block ends at the anchor', () => {
    const r = v(1, 2, LH, SIZE)
    expect(r.baselineY[0]!).toBeCloseTo(-60.2, 6)
    expect(r.baselineY[1]!).toBeCloseTo(-31.4, 6)
    expect(r.blockTop).toBeCloseTo(-57.6, 6)
    expect(r.blockBottom).toBeCloseTo(0, 6)
  })

  it('inter-line spacing is exactly lineHeightPx regardless of script', () => {
    const r = v(0.5, 3, LH, SIZE)
    expect(r.baselineY[1]! - r.baselineY[0]!).toBeCloseTo(LH, 6)
    expect(r.baselineY[2]! - r.baselineY[1]!).toBeCloseTo(LH, 6)
  })
})
