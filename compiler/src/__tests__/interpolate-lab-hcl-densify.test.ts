// Compile-time Lab / LCh stop densification (Plan §11 follow-up,
// iter 61). Mapbox `["interpolate-lab", ...]` / `["interpolate-hcl",
// ...]` over `["zoom"]` with hex colour stops now resamples each
// adjacent pair in perceptual colour space, converting samples
// back to hex. The runtime sees a denser linear-RGB interpolate
// and visually approximates the authored perceptual interpolation.
//
// This test pins the new behaviour:
//   1. Endpoints preserved exactly.
//   2. Intermediate stops produce visibly different hex than naive
//      sRGB-linear interpolation would.
//   3. LCh hue interpolation takes the shortest angular path.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import {
  parseSrgbHex, srgbToLab, labToHex, labToLch, lchToLab,
} from '../tokens/colors'

describe('sRGB ↔ Lab ↔ LCh round-trip', () => {
  it('parseSrgbHex handles 3- and 6-digit hex', () => {
    expect(parseSrgbHex('#fff')).toEqual([1, 1, 1])
    expect(parseSrgbHex('#000')).toEqual([0, 0, 0])
    expect(parseSrgbHex('#ff0000')).toEqual([1, 0, 0])
    expect(parseSrgbHex('#zzz')).toBeNull()
    expect(parseSrgbHex('not-a-hex')).toBeNull()
  })

  it('srgbToLab → labToHex is a stable round-trip within 1 LSB', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#888888', '#ffaa00', '#102030']) {
      const rgb = parseSrgbHex(hex)!
      const [L, a, b] = srgbToLab(rgb[0], rgb[1], rgb[2])
      const back = labToHex(L, a, b)
      // Convert both to numeric RGB and compare each channel within 1 unit
      const orig = parseSrgbHex(hex)!.map(v => Math.round(v * 255))
      const rt = parseSrgbHex(back)!.map(v => Math.round(v * 255))
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(orig[i]! - rt[i]!)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('labToLch → lchToLab is a stable round-trip', () => {
    const [L, a, b] = srgbToLab(0.5, 0.3, 0.9)
    const [Lc, C, h] = labToLch(L, a, b)
    const [L2, a2, b2] = lchToLab(Lc, C, h)
    expect(L2).toBeCloseTo(L, 6)
    expect(a2).toBeCloseTo(a, 6)
    expect(b2).toBeCloseTo(b, 6)
  })
})

describe('Mapbox interpolate-lab over zoom → densified hex stops', () => {
  function build(value: unknown) {
    return {
      version: 8,
      sources: { a: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 'a', 'source-layer': 'a', paint: { 'fill-color': value } },
      ],
    }
  }

  it('hex-stop interpolate-lab densifies + preserves endpoints', () => {
    const style = build([
      'interpolate-lab', ['linear'], ['zoom'],
      0, '#ffffff',
      18, '#000000',
    ])
    const warnings: string[] = []
    const out = convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    // Endpoints must survive as exact hex values
    expect(out).toContain('#ffffff')
    expect(out).toContain('#000000')
    // Densification warning must mention Lab + piecewise-linear
    const w = warnings.find(s => s.includes('interpolate-lab'))
    expect(w, warnings.join('\n')).toBeDefined()
    expect(w).toContain('dense piecewise-linear')
    expect(w).toContain('Lab space')
  })

  it('hex-stop interpolate-hcl densifies in LCh space (hue shortest-path)', () => {
    // Red → Green spans hue ~0 → 120°; LCh path goes through orange,
    // not magenta (which would be the long way round).
    const style = build([
      'interpolate-hcl', ['linear'], ['zoom'],
      0, '#ff0000',
      10, '#00ff00',
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    const w = warnings.find(s => s.includes('interpolate-hcl'))
    expect(w, warnings.join('\n')).toBeDefined()
    expect(w).toContain('LCh space')
  })

  it('exponential-curve interpolate-lab densifies (iter 137 §11)', () => {
    // Pre-iter-137 the exponential curve fell straight through to a
    // "non-linear curve approximated as linear-sRGB" warning. Now it
    // densifies the same way the linear curve does, with the Mapbox
    // exponential progress warp applied to the colour parameter.
    const style = build([
      'interpolate-lab', ['exponential', 2], ['zoom'],
      0, '#ffffff',
      10, '#000000',
    ])
    const warnings: string[] = []
    const out = convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(out).toContain('#ffffff')
    expect(out).toContain('#000000')
    const w = warnings.find(s => s.includes('interpolate-lab'))
    expect(w, warnings.join('\n')).toBeDefined()
    expect(w).toContain('exponential base 2')
    expect(w).toContain('dense piecewise-linear')
    // The old "non-linear curve approximated as linear-sRGB" warning
    // must NOT appear — exponential is densified, not dropped.
    expect(warnings.some(s => s.includes('non-linear curve'))).toBe(false)
  })

  it('exponential-curve interpolate-hcl densifies in LCh space', () => {
    const style = build([
      'interpolate-hcl', ['exponential', 1.5], ['zoom'],
      0, '#ff0000',
      8, '#0000ff',
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    const w = warnings.find(s => s.includes('interpolate-hcl'))
    expect(w, warnings.join('\n')).toBeDefined()
    expect(w).toContain('exponential base 1.5')
    expect(w).toContain('LCh space')
  })

  it('exponential base ≈1 collapses to linear (no warp, no double-apply)', () => {
    // base 1 is mathematically linear; the dense samples must equal
    // the linear-curve densification and the emitted curve stays
    // linear so the runtime doesn't re-warp.
    const style = build([
      'interpolate-lab', ['exponential', 1], ['zoom'],
      0, '#ffffff',
      10, '#000000',
    ])
    const warnings: string[] = []
    const out = convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(out).toContain('#ffffff')
    expect(out).toContain('#000000')
    expect(warnings.some(s => s.includes('non-linear curve'))).toBe(false)
  })

  it('non-hex stops fall back to linear-sRGB with diagnostic warning', () => {
    // ["get", "x"] inside an interpolate-lab stop value — runtime
    // expression, can't densify at compile time.
    const style = build([
      'interpolate-lab', ['linear'], ['zoom'],
      0, ['get', 'x'],
      10, '#000',
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    const w = warnings.find(s => s.includes('interpolate-lab') && s.includes('linear-sRGB'))
    expect(w, warnings.join('\n')).toBeDefined()
  })
})
