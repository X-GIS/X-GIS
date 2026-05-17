// Pin colorToXgis multi-level literal-wrap unwrap. v8 strict tooling
// chained through preprocessors can emit `["literal", ["literal", "#fff"]]`.
// Pre-fix the single-pass unwrap left the inner wrapper intact, the
// typeof === 'string' gate failed, and the layer fell back to the
// runtime's default fill (or the layer dropped entirely).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('color double-literal-wrap unwrap', () => {
  it('fill-color double-wrap still emits constant utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['literal', ['literal', '#abcdef']] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('fill-#abcdef')
  })

  it('line-color triple-wrap also unwraps', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': ['literal', ['literal', ['literal', '#123456']]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-#123456')
  })

  it('single wrap still works (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['literal', '#fedcba'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('fill-#fedcba')
  })
})
