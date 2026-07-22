import { describe, expect, it } from 'vitest'
import { availableRamps, interpolateBandedRamp, BANDED_RAMPS } from './color-ramp'

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

describe('S-111 official banded speed palette (s111-speed)', () => {
  it('is registered as an available ramp', () => {
    expect(availableRamps()).toContain('s111-speed')
  })

  it('bakes a STEPPED LUT with the exact IHO band colours over [0, 13] kn (no interpolation)', () => {
    const banded = BANDED_RAMPS['s111-speed']!
    expect(banded.domain).toEqual([0, 13])
    const lut = interpolateBandedRamp(banded, 256)
    // Sample the LUT at a speed value (the layer draws with range [0, 13], so t = v/13).
    const at = (v: number): [number, number, number] => {
      const i = Math.round((v / 13) * 255)
      return [lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!]
    }
    // Verbatim from 111_Portrayal_Catalogue_2.0.0 (colorProfile SCBN1..9, Day palette).
    expect(at(0.25)).toEqual([118, 82, 226]) // Band1 [0,0.5)  purple
    expect(at(0.75)).toEqual([72, 152, 211]) // Band2 [0.5,1)  blue
    expect(at(2.5)).toEqual([109, 188, 69]) // Band4 [2,3)    green
    expect(at(6.0)).toEqual([205, 193, 0]) // Band6 [5,7)     yellow
    expect(at(13)).toEqual([255, 30, 30]) // Band9 [13,inf)   red
    // HARD edges: EVERY texel is EXACTLY one of the 9 band colours (stepped, never blended).
    const bandSet = new Set(banded.bands.map((b) => b.color.join(',')))
    for (let i = 0; i < 256; i++)
      expect(bandSet.has([lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]].join(','))).toBe(true)
  })
})
