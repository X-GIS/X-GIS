// Pin layer-id collision warnings. Pre-fix two failure modes were
// silent:
//   1. Mapbox spec violation — duplicate raw layer id.
//   2. sanitizeId collapse — distinct raw ids (`a-b`, `a_b`) both
//      map to the same xgis identifier, the later emitted block
//      silently overrode the earlier in the runtime registry.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer id collision warnings', () => {
  it('exact duplicate raw id warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'foo', type: 'fill', source: 's', paint: { 'fill-color': '#abc' } },
        { id: 'foo', type: 'fill', source: 's', paint: { 'fill-color': '#def' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Duplicate layer id "foo"/)
  })

  it('sanitization collision warns (a-b vs a_b)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'a-b', type: 'fill', source: 's', paint: { 'fill-color': '#abc' } },
        { id: 'a_b', type: 'fill', source: 's', paint: { 'fill-color': '#def' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/sanitizes to "a_b" — collides/)
  })

  it('distinct ids do NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'foo', type: 'fill', source: 's', paint: { 'fill-color': '#abc' } },
        { id: 'bar', type: 'fill', source: 's', paint: { 'fill-color': '#def' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Duplicate layer id/)
    expect(code).not.toMatch(/sanitizes to .*collides/)
  })

  it('background layer is exempt (handled separately)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
        { id: 'bg', type: 'background', paint: { 'background-color': '#000' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Duplicate layer id/)
  })
})
