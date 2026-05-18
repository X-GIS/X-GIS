// Pin distinct warnings for layer.type failure modes — mirror of
// the source-type validation. Pre-fix missing / non-string / unknown
// type fell through to the main convertLayer body, paintToUtilities
// returned [] because no `type === …` matched, the emitted block
// had no utilities, and dead-layer-elim killed it silently.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer type validation modes', () => {
  it('missing type field warns specifically', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', source: 's', paint: { 'fill-color': '#abc' } } as unknown,
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing the required type field/)
  })

  it('null type field warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: null, source: 's' } as unknown,
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing the required type field/)
  })

  it('non-string type warns with typeof', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 42, source: 's' } as unknown,
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/type field must be a string \(got number\)/)
  })

  it('unknown type string warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'polygon', source: 's' } as unknown,
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/unknown type "polygon"/)
  })

  it('valid type does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/missing the required type field/)
    expect(code).not.toMatch(/unknown type/)
  })
})
