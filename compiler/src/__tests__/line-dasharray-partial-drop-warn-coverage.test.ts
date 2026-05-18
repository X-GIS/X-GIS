// Pin warning when line-dasharray contains non-numeric entries.
// Pre-fix `[4, "two", 2]` silently dropped the non-numeric and
// emitted `stroke-dasharray-4-2` — a different dash pattern than
// authored, with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('line-dasharray partial-drop warning', () => {
  it('warns when dash array contains non-numeric entry', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-dasharray': [4, 'two', 2] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/dropped 1 non-numeric entry/)
  })

  it('all-numeric dash does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-dasharray': [4, 2] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/dropped \d+ non-numeric/)
    expect(code).toContain('stroke-dasharray-4-2')
  })
})
