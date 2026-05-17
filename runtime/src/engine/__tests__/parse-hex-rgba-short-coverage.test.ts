// Pin parseHexColor handling of CSS Color Module 4 short-alpha
// `#rgba` form. Pre-fix length 5 fell to the default [0,0,0,1] and
// the colour silently turned black on any style emitting `#xxxa`.

import { describe, it, expect } from 'vitest'
import { parseHexColor } from '../feature-helpers'

describe('parseHexColor #rgba short alpha form', () => {
  it('#f008 (short-alpha) → red with ~53% alpha', () => {
    const [r, g, b, a] = parseHexColor('#f008')
    expect(r).toBeCloseTo(1.0, 5)
    expect(g).toBeCloseTo(0, 5)
    expect(b).toBeCloseTo(0, 5)
    // 8 → 0x88 = 136 / 255 ≈ 0.533
    expect(a).toBeCloseTo(136 / 255, 5)
  })

  it('#000f (opaque black) → black, a=1', () => {
    const [r, g, b, a] = parseHexColor('#000f')
    expect(r).toBeCloseTo(0, 5)
    expect(g).toBeCloseTo(0, 5)
    expect(b).toBeCloseTo(0, 5)
    expect(a).toBeCloseTo(1, 5)
  })

  it('#fff0 (fully transparent white) → white, a=0', () => {
    const [r, g, b, a] = parseHexColor('#fff0')
    expect(r).toBeCloseTo(1, 5)
    expect(g).toBeCloseTo(1, 5)
    expect(b).toBeCloseTo(1, 5)
    expect(a).toBeCloseTo(0, 5)
  })

  it('regression: #fff (3-digit) still works', () => {
    const [r, g, b, a] = parseHexColor('#fff')
    expect(r).toBeCloseTo(1, 5)
    expect(g).toBeCloseTo(1, 5)
    expect(b).toBeCloseTo(1, 5)
    expect(a).toBeCloseTo(1, 5)
  })

  it('regression: #ff000088 (8-digit) still works', () => {
    const [r, g, b, a] = parseHexColor('#ff000088')
    expect(r).toBeCloseTo(1, 5)
    expect(g).toBeCloseTo(0, 5)
    expect(b).toBeCloseTo(0, 5)
    expect(a).toBeCloseTo(136 / 255, 5)
  })
})
