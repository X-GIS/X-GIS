import { describe, expect, it } from 'vitest'
import { bandedRampColor } from '../color-ramp'
import {
  s111ArrowScale,
  s111ArrowLengthPx,
  s111HasArrow,
  S111_ARROW_BASE_PX,
  S111_OUTLINE_FRAC,
  S111_SCALE_FLOOR,
  S111_SCALE_CEILING,
  S111_SCALE_PER_KNOT,
  S111_SPEED_RAMP,
  s111BandTable,
  S111_BAND_COUNT,
  S111_BAND_STRIDE,
  S111_BAND_TOP_SENTINEL,
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

describe('S111_OUTLINE_FRAC (SVGStyle_S111day.css .sCHBLK — black outline stroke width)', () => {
  it("is a positive fraction (loc-space units — a proportion of each arrow's own size, not a flat px)", () => {
    expect(S111_OUTLINE_FRAC).toBeGreaterThan(0)
    expect(S111_OUTLINE_FRAC).toBeLessThan(0.5) // sane upper bound — never swamps the fill
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

// ── The band table the advected-arrow shader indexes (#1409) ─────────────────────────────
//
// An advected arrow leaves its origin cell, so its band has to be re-decided every frame from
// the speed under its CURRENT position. That decision runs in a shader, and the whole point of
// uploading a table is that the shader holds no threshold and no colour of its own. These gates
// are what make that claim true: the table must reproduce `bandedRampColor` and `s111ArrowScale`
// EXACTLY, so a catalogue revision that touches either one and not the table fails here rather
// than shipping an arrow that moves correctly and is coloured wrongly.

describe('s111BandTable — the catalogue rule as GPU-indexable data', () => {
  const table = s111BandTable()

  it('has one aligned row per catalogue band', () => {
    expect(table).toHaveLength(S111_BAND_COUNT * S111_BAND_STRIDE)
    expect(S111_BAND_COUNT).toBe(9)
    expect(S111_BAND_STRIDE % 4, 'rows are vec4-aligned on both backends').toBe(0)
  })

  it('carries the catalogue upper edges, ascending, with a finite top sentinel', () => {
    const edges = Array.from({ length: S111_BAND_COUNT }, (_, b) => table[b * S111_BAND_STRIDE]!)
    expect(edges.slice(0, 8)).toEqual([0.5, 1, 2, 3, 5, 7, 10, 13])
    // Band 9 is `geSemiInterval` — unbounded. Infinity is not comparable in an f32 buffer, so
    // a large finite sentinel stands in; every speed at or above 13 still lands in band 9.
    expect(edges[8]).toBe(S111_BAND_TOP_SENTINEL)
    for (let b = 1; b < S111_BAND_COUNT; b++) expect(edges[b]!).toBeGreaterThan(edges[b - 1]!)
  })

  /** The lookup the shader performs: first band whose upper edge exceeds the speed. */
  const rowFor = (speed: number) => {
    for (let b = 0; b < S111_BAND_COUNT; b++) {
      if (speed < table[b * S111_BAND_STRIDE]!) return b
    }
    return S111_BAND_COUNT - 1
  }

  it('reproduces bandedRampColor for every band — the palette is NOT restated', () => {
    for (const speed of [0.01, 0.4, 0.6, 1.5, 2.5, 4, 6, 8.5, 11, 13, 20, 100]) {
      const o = rowFor(speed) * S111_BAND_STRIDE
      const want = bandedRampColor(S111_SPEED_RAMP, speed)!
      expect(
        [table[o + 4]!, table[o + 5]!, table[o + 6]!].map((v) => Math.round(v * 255)),
        `band colour at ${speed} kn`,
      ).toEqual(want)
      expect(table[o + 7], 'opaque').toBe(1)
    }
  })

  it('reproduces s111ArrowScale exactly, as an affine pair with no branch', () => {
    // scale = constant + perKnot × speed. Every catalogue band is affine, so this is not an
    // approximation — it is the same function, evaluated without a conditional in the shader.
    for (const speed of [0.01, 0.4, 0.6, 1.5, 1.999, 2, 2.5, 4, 6, 8.5, 11, 12.999, 13, 20, 100]) {
      const o = rowFor(speed) * S111_BAND_STRIDE
      const got = table[o + 1]! + table[o + 2]! * speed
      // 6 decimals, not 12: the table is a Float32Array, so every entry is f32-rounded on the
      // way in. Demanding f64 agreement would be asserting something the upload cannot carry.
      expect(got, `scale at ${speed} kn`).toBeCloseTo(s111ArrowScale(speed), 6)
    }
  })

  it('pins the scale SHAPE per band, so a flattened rule cannot pass the sampling above', () => {
    const perKnot = (b: number) => table[b * S111_BAND_STRIDE + 2]!
    // Bands 1–3 and 9 are constant; 4–8 are speed-proportional. A table that made every band
    // constant would still match at the probe points if those happened to be the midpoints.
    for (const b of [0, 1, 2, 8]) expect(perKnot(b), `band ${b + 1} is constant`).toBe(0)
    for (const b of [3, 4, 5, 6, 7])
      // `Math.fround`, not the raw constant: the table stores f32, and 0.2 has no exact f32
      // representation. Comparing against the rounded value asserts the SAME number rather
      // than a tolerance that would also accept a genuinely different one.
      expect(perKnot(b), `band ${b + 1} scales with speed`).toBe(Math.fround(S111_SCALE_PER_KNOT))
    // ...and the constant bands carry the catalogue's own floor/ceiling.
    expect(table[0 * S111_BAND_STRIDE + 1]).toBeCloseTo(S111_SCALE_FLOOR, 6)
    expect(table[8 * S111_BAND_STRIDE + 1]).toBeCloseTo(S111_SCALE_CEILING, 6)
  })
})
