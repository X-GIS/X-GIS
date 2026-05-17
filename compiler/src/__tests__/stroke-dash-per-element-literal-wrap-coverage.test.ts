// Pin Mapbox v8 strict per-element literal-wrap unwrap inside the
// line-dasharray paint accessor. Pre-fix the outer
// `["literal", [...]]` unwrap fired but each element stayed wrapped
// as `["literal", 4]`; the typeof === 'number' filter rejected every
// element, nums.length < 2, and the dash silently dropped to a
// warning instead of emitting `stroke-dasharray-4-2`.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('line-dasharray per-element literal-wrap unwrap', () => {
  it('outer + inner per-element wrap still emits stroke-dasharray-N-M', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#000',
            'line-dasharray': ['literal', [['literal', 4], ['literal', 2]]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-4-2')
  })

  it('bare-array form still works (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'line', source: 's', paint: { 'line-color': '#000', 'line-dasharray': [4, 2] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-4-2')
  })

  it('outer-only literal-wrap still works (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#000', 'line-dasharray': ['literal', [3, 1]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-3-1')
  })

  it('negative dash element after unwrap clamps to 0', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#000',
            'line-dasharray': ['literal', [['literal', -4], ['literal', 2]]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-0-2')
  })
})
