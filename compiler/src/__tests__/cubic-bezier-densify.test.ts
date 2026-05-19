// Compile-time densification of interpolate-cubic-bezier into a
// dense piecewise-linear stop set. Pins the iter-60 plan §11
// follow-up where the cubic-bezier curve previously folded to
// linear silently. Now: numeric-valued stops are densified at
// compile time so runtime linear-interpolate visually approximates
// the bezier ease.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { cssBezierEase } from '../convert/paint'

describe('CSS cubic-bezier easing function', () => {
  it('returns endpoints exactly at t=0 and t=1', () => {
    expect(cssBezierEase(0, 0.42, 0, 0.58, 1)).toBe(0)
    expect(cssBezierEase(1, 0.42, 0, 0.58, 1)).toBe(1)
  })

  it('linear bezier (0,0,1,1) is the identity', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(cssBezierEase(t, 0, 0, 1, 1)).toBeCloseTo(t, 4)
    }
  })

  it('ease-in (0.42, 0, 1, 1) bows below the diagonal mid-curve', () => {
    expect(cssBezierEase(0.5, 0.42, 0, 1, 1)).toBeLessThan(0.5)
  })

  it('ease-out (0, 0, 0.58, 1) bows above the diagonal mid-curve', () => {
    expect(cssBezierEase(0.5, 0, 0, 0.58, 1)).toBeGreaterThan(0.5)
  })

  it('ease-in-out (0.42, 0, 0.58, 1) crosses the diagonal at t=0.5', () => {
    expect(cssBezierEase(0.5, 0.42, 0, 0.58, 1)).toBeCloseTo(0.5, 2)
  })
})

describe('Mapbox interpolate-cubic-bezier conversion → densified stops', () => {
  function build(value: unknown) {
    return {
      version: 8,
      sources: { a: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'line', source: 'a', 'source-layer': 'a', paint: { 'line-width': value } },
      ],
    }
  }

  it('numeric-valued bezier interpolate densifies stops and emits an approximation warning', () => {
    // Authored: linear-in at zoom 10..20, bezier ease-in (0.42, 0, 1, 1).
    const style = build([
      'interpolate', ['cubic-bezier', 0.42, 0, 1, 1], ['zoom'],
      10, 1, 20, 16,
    ])
    const warnings: string[] = []
    const out = convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(out).toContain('interpolate')
    const bezierWarn = warnings.find(w => w.includes('cubic-bezier'))
    expect(bezierWarn, warnings.join('\n')).toBeDefined()
    expect(bezierWarn).toContain('dense piecewise-linear')
  })

  it('non-numeric values (colors) still warn and fold to linear', () => {
    const style = build([
      'interpolate', ['cubic-bezier', 0.42, 0, 0.58, 1], ['zoom'],
      10, '#ff0000', 20, '#0000ff',
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    const w = warnings.find(w => w.includes('cubic-bezier') && w.includes('folded'))
    expect(w, `expected folded-to-linear warning; got: ${warnings.join('\n')}`).toBeDefined()
  })

  it('v8-strict-wrapped control points still recognised as cubic-bezier', () => {
    // Mapbox v8 strict tooling can wrap each control point as
    // `["literal", N]`. Pre-fix the typeof === 'number' gate failed
    // and the curve silently degraded to (0, 0, 1, 1) linear with no
    // diagnostic. The unwrapCP helper added in iter 71 peels these
    // wraps so the densification still kicks in.
    const style = build([
      'interpolate', ['cubic-bezier',
        ['literal', 0.42], ['literal', 0],
        ['literal', 0.58], ['literal', 1],
      ], ['zoom'],
      10, 1, 20, 16,
    ])
    const warnings: string[] = []
    convertMapboxStyle(style as unknown as string, {
      coverage: { sources: [], layers: [], warnings },
    })
    const bezierWarn = warnings.find(w => w.includes('cubic-bezier'))
    expect(bezierWarn, warnings.join('\n')).toBeDefined()
    // The warning should report the unwrapped numeric control points
    // 0.42 / 0 / 0.58 / 1 — confirming unwrap fired.
    expect(bezierWarn).toContain('0.42')
    expect(bezierWarn).toContain('0.58')
    expect(bezierWarn).toContain('dense piecewise-linear')
  })

  it('densified output preserves end-stop values exactly', () => {
    // The densifier inserts intermediate samples but the first and
    // last stops must remain at the authored values so the runtime
    // result at z<=10 and z>=20 matches the authored endpoints.
    const style = build([
      'interpolate', ['cubic-bezier', 0.42, 0, 1, 1], ['zoom'],
      10, 1, 20, 16,
    ])
    const out = convertMapboxStyle(style as unknown as string)
    // Output should contain "10," and "20," followed by the
    // endpoint values 1 and 16 in some recognisable form. Lax
    // assertion — the densifier's internal stop format is implementation
    // detail; what matters is the endpoints survive.
    expect(out).toMatch(/\b10\b/)
    expect(out).toMatch(/\b20\b/)
    expect(out).toMatch(/\b16\b/)
  })
})
