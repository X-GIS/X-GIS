import { describe, expect, it } from 'vitest'
import { availableRamps } from './color-ramp'

describe('Color Ramp', () => {
  it('has built-in ramps', () => {
    const ramps = availableRamps()
    expect(ramps).toContain('viridis')
    expect(ramps).toContain('hot')
    expect(ramps).toContain('blues')
    expect(ramps).toContain('reds')
    expect(ramps).toContain('rdylgn')
    expect(ramps).toContain('coolwarm')
    expect(ramps).toContain('ocean')
    expect(ramps).toContain('terrain')
    expect(ramps).toContain('plasma')
    expect(ramps).toContain('grayscale')
    expect(ramps.length).toBeGreaterThanOrEqual(10)
  })
})
