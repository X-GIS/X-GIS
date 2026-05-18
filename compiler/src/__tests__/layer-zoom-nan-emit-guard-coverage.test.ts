// Pin NaN/Infinity rejection at layer minzoom/maxzoom emit sites.
// Pre-fix `typeof NaN === 'number'` slipped past the type gate and
// emitted `minzoom: NaN` / `maxzoom: NaN` in the xgis output, which
// the parser rejected at lex time. Three convert paths affected:
// convertLayer main body (~340), convertCircleLayer (~1064), and
// symbol-segment zoom intersection (~1276).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer minzoom/maxzoom NaN guard at emit sites', () => {
  it('fill layer with NaN minzoom does not emit minzoom: NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: NaN as unknown,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/minzoom: NaN/)
    expect(code).not.toMatch(/maxzoom: NaN/)
  })

  it('circle layer with NaN maxzoom does not emit maxzoom: NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          maxzoom: NaN as unknown,
          paint: { 'circle-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/maxzoom: NaN/)
  })

  it('valid zooms still emit (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: 5,
          maxzoom: 18,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('minzoom: 5')
    expect(code).toContain('maxzoom: 18')
  })
})
