import { describe, it, expect } from 'vitest'
import { formatBearing } from './gis-formatter'

// Compass-bearing convention is the half-open range 000-359 where 360° == 000°.
// formatBearing must never emit an out-of-range "360°": values in [359.5, 360)
// round UP to 360 and must fold back to 000. Military-precision domain.

describe('formatBearing wrap-around boundary', () => {
  it('values that round up to 360 fold back to 000', () => {
    expect(formatBearing(359.6)).toBe('000°')
    expect(formatBearing(359.9)).toBe('000°')
  })

  it('exact 360 is 000', () => {
    expect(formatBearing(360)).toBe('000°')
  })

  it('negative wrap that rounds up folds to 000', () => {
    // -0.4 wraps to 359.6, which rounds to 360 -> must become 000
    expect(formatBearing(-0.4)).toBe('000°')
  })

  it('just below the boundary stays at 359', () => {
    expect(formatBearing(359.4)).toBe('359°')
  })

  it('mid and small values are unchanged', () => {
    expect(formatBearing(90)).toBe('090°')
    expect(formatBearing(5)).toBe('005°')
    expect(formatBearing(0)).toBe('000°')
  })
})
