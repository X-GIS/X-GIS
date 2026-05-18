// Pin defensive handling for GeoJSON source with empty-string `data`.
// Pre-fix `data: ""` emitted `url: ""` verbatim, the runtime fetched
// "" which hits the current document URL and either returns the host
// HTML or 404s; the source rendered silently empty.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('GeoJSON empty-string data field', () => {
  it('empty data string does NOT emit url: ""', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: '' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/url: ""/)
    expect(code).toMatch(/data field is an empty string/)
  })

  it('non-empty data URL still emits url (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: 'https://example.com/f.geojson' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/f.geojson"')
  })

  it('inline data object still emits geojson stub', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: geojson')
    expect(code).not.toMatch(/data field is an empty string/)
  })
})
