// Smoke tests for the Mapbox spec oracle wrapper. The real
// differential / coverage tests live in
// __tests__/mapbox-spec-conformance.test.ts (WS-3); these just pin
// the oracle's own surface so a future style-spec major version bump
// can't silently break the wrapper.

import { describe, it, expect } from 'vitest'
import {
  specProperty, specDefault, specDefaultColorRgba,
  createSpecExpression, spec,
} from './oracle'

describe('mapbox spec oracle', () => {
  it('exposes the raw spec object', () => {
    expect(spec).toBeDefined()
    expect((spec as { $version: number }).$version).toBeGreaterThanOrEqual(8)
  })

  it('returns property defs with type + default + property-type', () => {
    const p = specProperty('symbol', 'paint', 'text-halo-color')
    expect(p).toBeDefined()
    expect(p?.type).toBe('color')
    expect(p?.default).toBe('rgba(0, 0, 0, 0)')
  })

  it('specDefault returns the raw default value', () => {
    expect(specDefault('symbol', 'layout', 'text-size')).toBe(16)
    expect(specDefault('line', 'paint', 'line-width')).toBe(1)
    expect(specDefault('symbol', 'paint', 'text-color')).toBe('#000000')
  })

  it('specDefaultColorRgba parses the spec\'s CSS string default', () => {
    // The textbook case — the very bug that motivated PR #105.
    expect(specDefaultColorRgba('symbol', 'text-halo-color'))
      .toEqual([0, 0, 0, 0])
    // text-color default is "#000000" — should parse to opaque black.
    expect(specDefaultColorRgba('symbol', 'text-color'))
      .toEqual([0, 0, 0, 1])
  })

  it('returns undefined for unknown properties (does NOT throw)', () => {
    expect(specProperty('line', 'paint', 'made-up-name' as never)).toBeUndefined()
    expect(specDefault('line', 'paint', 'made-up-name' as never)).toBeUndefined()
  })

  it('createSpecExpression matches MapLibre interpolation arithmetic', () => {
    const lineWidth = ['interpolate', ['exponential', 1.2], ['zoom'],
      12, 0.5, 14, 2, 20, 11.5] as const
    const expr = createSpecExpression('line', 'paint', 'line-width', lineWidth)
    expect(expr.result).toBe('success')
    if (expr.result !== 'success') return
    const eval_ = (z: number): number =>
      expr.value.evaluate({ zoom: z }, { type: 1, properties: {} } as never) as number
    expect(eval_(8)).toBe(0.5)        // clamped to first stop
    expect(eval_(14)).toBeCloseTo(2, 4)
    expect(eval_(20)).toBe(11.5)
  })

  it('throws on unknown property in createSpecExpression', () => {
    expect(() => createSpecExpression('line', 'paint', 'no-such-prop' as never, ['literal', 1]))
      .toThrow(/unknown spec property/)
  })
})
