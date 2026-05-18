// Pin null-as-omit treatment for fill-pattern / line-pattern warnings.
// Pre-fix the check was `fill-color === undefined` only; an authored
// `fill-color: null + fill-pattern: "..."` slipped past with no
// diagnostic even though the layer's only visual cue (pattern atlas)
// isn't supported yet. Mapbox spec treats null as "property omitted".

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('pattern-without-color null-as-omit', () => {
  it('fill-pattern + explicit null fill-color warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': null, 'fill-pattern': 'wetland' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/fill-pattern declared without fill-color/)
  })

  it('line-pattern + explicit null line-color warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': null, 'line-pattern': 'dashes' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/line-pattern declared without line-color/)
  })

  it('fill-color + fill-pattern coexist does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#abc', 'fill-pattern': 'wetland' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/fill-pattern declared without/)
  })
})
