import { describe, expect, it } from 'vitest'
import { bandedRampColor } from '../color-ramp'
import {
  s111ArrowScale,
  s111ArrowLengthPx,
  s111HasArrow,
  S111_ARROW_BASE_PX,
  S111_SCALE_FLOOR,
  S111_SCALE_CEILING,
} from './s111-portrayal'

// The authority for every number below is the vendored catalogue at docs/standards/s-111/
// (portrayal/XSLT/Rules/select_arrow.xsl, main.xsl, Symbols/SVGStyle_S111day.css).

describe('s111ArrowScale (select_arrow.xsl)', () => {
  it('bands 1–3 (< 2 kn) use the fixed floor 0.40', () => {
    expect(s111ArrowScale(0)).toBe(S111_SCALE_FLOOR)
    expect(s111ArrowScale(0.3)).toBe(0.4) // band 1
    expect(s111ArrowScale(0.7)).toBe(0.4) // band 2
    expect(s111ArrowScale(1.9)).toBe(0.4) // band 3
  })

  it('bands 4–8 (2–13 kn) scale as speed × 0.20', () => {
    expect(s111ArrowScale(2)).toBeCloseTo(0.4, 10) // continuous with the floor at the 2 kn join
    expect(s111ArrowScale(2.5)).toBeCloseTo(0.5, 10)
    expect(s111ArrowScale(5)).toBeCloseTo(1.0, 10)
    expect(s111ArrowScale(12.9)).toBeCloseTo(2.58, 10)
  })

  it('band 9 (≥ 13 kn) uses the fixed ceiling 2.60', () => {
    expect(s111ArrowScale(13)).toBe(S111_SCALE_CEILING) // continuous with speed×0.20 at 13
    expect(s111ArrowScale(20)).toBe(2.6)
  })
})

describe('s111ArrowLengthPx', () => {
  it('is basePx × scale, preserving the catalogue ratios', () => {
    expect(s111ArrowLengthPx(1)).toBeCloseTo(S111_ARROW_BASE_PX * 0.4, 10) // slow → uniform
    expect(s111ArrowLengthPx(5)).toBeCloseTo(S111_ARROW_BASE_PX * 1.0, 10)
    expect(s111ArrowLengthPx(1, 50)).toBeCloseTo(20, 10) // explicit base override
  })
})

describe('s111HasArrow (main.xsl note 4 — no symbol for speed 0 / noData)', () => {
  it('draws only for finite speed > 0', () => {
    expect(s111HasArrow(0)).toBe(false) // zero speed → no symbol
    expect(s111HasArrow(NaN)).toBe(false) // noData
    expect(s111HasArrow(-9999)).toBe(false) // fill sentinel (not > 0)
    expect(s111HasArrow(0.01)).toBe(true)
    expect(s111HasArrow(2.32)).toBe(true) // a real CBOFS max
  })
})

describe("bandedRampColor('s111-speed', …) matches SVGStyle_S111day.css fSCBN1..9", () => {
  const cases: [number, [number, number, number]][] = [
    [0.3, [118, 82, 226]], // band1 #7652E2
    [0.7, [72, 152, 211]], // band2 #4898D3
    [1.5, [97, 203, 229]], // band3 #61CBE5
    [2.5, [109, 188, 69]], // band4 #6DBC45
    [4, [180, 220, 0]], // band5 #B4DC00
    [6, [205, 193, 0]], // band6 #CDC100
    [8, [248, 167, 24]], // band7 #F8A718
    [11, [247, 162, 157]], // band8 #F7A29D
    [20, [255, 30, 30]], // band9 #FF1E1E
  ]
  it.each(cases)('speed %d kn → %j', (speed, rgb) => {
    expect(bandedRampColor('s111-speed', speed)).toEqual(rgb)
  })
  it('returns null for an unknown ramp', () => {
    expect(bandedRampColor('not-a-ramp', 1)).toBeNull()
  })
})
