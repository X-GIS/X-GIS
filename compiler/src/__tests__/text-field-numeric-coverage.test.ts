// Pin text-field numeric / boolean handling. Mapbox spec: text-field
// can be a number or boolean — the runtime stringifies it for label
// rendering. Pre-fix textFieldToXgisExpr only accepted string + array
// inputs; any number / boolean fell to the null return and the whole
// symbol layer dropped with a "not convertible" warning.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emit(field: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'symbol',
      source: 'v',
      'source-layer': 'place',
      layout: { 'text-field': field },
    }],
  } as never)
}

describe('text-field numeric / boolean values', () => {
  it('text-field: 42 emits a numeric label binding', () => {
    const out = emit(42)
    expect(out).toMatch(/label-\[42\]/)
    expect(out).not.toContain('SKIPPED')
  })

  it('text-field: 0 (falsy) still emits — regression guard', () => {
    // Pre-fix the falsy `0` wouldn't have reached the layer body
    // (the textFieldToXgisExpr null short-circuit dropped the
    // whole layer). With the new arm, 0 is a valid numeric label.
    const out = emit(0)
    expect(out).toMatch(/label-\[0\]/)
  })

  it('text-field: true emits boolean label binding', () => {
    const out = emit(true)
    expect(out).toMatch(/label-\[true\]/)
  })

  it('text-field: ["literal", 42] also emits via the array arm', () => {
    // The array branch routes through exprToXgis → literal unwrap
    // → numeric String. Already worked pre-fix but pin for parity.
    const out = emit(['literal', 42])
    expect(out).toMatch(/label-\[42\]/)
  })

  it('text-field: "{name}" (token string) still emits FieldAccess (regression guard)', () => {
    const out = emit('{name}')
    expect(out).toMatch(/label-\[\.name\]/)
  })
})
