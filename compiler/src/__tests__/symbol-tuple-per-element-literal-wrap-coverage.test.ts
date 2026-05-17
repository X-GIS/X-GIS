// Pin Mapbox v8 strict per-element literal-wrap unwrap inside the
// symbol-layer numeric-tuple accessors: text-offset, text-translate,
// icon-offset, text-variable-anchor-offset per-pair offsets.
// Pre-fix outer `["literal", [a, b]]` unwrapped but each scalar
// element stayed wrapped — `typeof === 'number'` rejected each, the
// pair landed null, offset silently dropped (label stayed at anchor).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function symbolStyle(layout: Record<string, unknown>, paint: Record<string, unknown> = {}) {
  return {
    version: 8,
    sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'l',
        type: 'symbol',
        source: 's',
        layout: { 'text-field': '{name}', ...layout },
        paint,
      },
    ],
  }
}

describe('symbol numeric-tuple per-element literal-wrap unwrap', () => {
  it('text-offset double-wrap still emits label-offset-{x,y}', () => {
    const code = convertMapboxStyle(symbolStyle({
      'text-offset': ['literal', [['literal', 0], ['literal', -1.5]]],
    }) as never)
    expect(code).toContain('label-offset-y-[-1.5]')
    // x is 0 — no x utility emitted (zero-skip).
    expect(code).not.toContain('label-offset-x-')
  })

  it('text-translate double-wrap still emits label-translate-{x,y}', () => {
    const code = convertMapboxStyle(symbolStyle({}, {
      'text-translate': ['literal', [['literal', 3], ['literal', -8]]],
    }) as never)
    expect(code).toContain('label-translate-x-3')
    expect(code).toContain('label-translate-y-[-8]')
  })

  it('icon-offset double-wrap still emits label-icon-offset-{x,y}', () => {
    const code = convertMapboxStyle(symbolStyle({
      'icon-image': 'marker',
      'icon-offset': ['literal', [['literal', 2], ['literal', 4]]],
    }) as never)
    expect(code).toContain('label-icon-offset-x-2')
    expect(code).toContain('label-icon-offset-y-4')
  })

  it('text-variable-anchor-offset per-pair double-wrap emits label-vao-i-{x,y}', () => {
    // Outer wrap on whole list + per-pair wrap + per-scalar wrap.
    const code = convertMapboxStyle(symbolStyle({
      'text-variable-anchor-offset': [
        'literal',
        ['top', ['literal', [['literal', 0], ['literal', 1]]]],
      ],
    }) as never)
    expect(code).toContain('label-anchor-top')
    expect(code).toContain('label-vao-0-y-1')
  })

  it('bare tuple still works (regression guard)', () => {
    const code = convertMapboxStyle(symbolStyle({
      'text-offset': [0, -1.5],
    }) as never)
    expect(code).toContain('label-offset-y-[-1.5]')
  })
})
