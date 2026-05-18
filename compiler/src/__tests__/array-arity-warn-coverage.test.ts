// Pin ["array"] missing-payload warning. Pre-fix the bare form
// silently picked v[0] = "array" itself as the value and emitted
// the literal string "array" — surfaced visually as a label
// rendering the word "array" instead of dropping.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('["array"] missing payload warning', () => {
  it('bare ["array"] warns and does not emit "array" string', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['array'] as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["array"\] expression: missing inner value/)
    expect(code).not.toMatch(/label-\["array"\]/)
  })

  it('well-formed ["array", value] does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['array', ['literal', ['a', 'b']]] as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["array"\]/)
  })
})
