// Pin NaN/Infinity rejection at 4 more constant-numeric paint emit
// sites: fill-extrusion-height, fill-extrusion-base, line-offset,
// line-blur. Same class as the prior batch — `typeof NaN ===
// 'number'` slipped past the type gate and emitted `-NaN`-suffixed
// utility names that the parser rejected.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('extrude/line constant NaN guards', () => {
  it('NaN fill-extrusion-height does not emit -NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: { 'fill-extrusion-color': '#abc', 'fill-extrusion-height': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/fill-extrusion-height-NaN/)
  })

  it('NaN fill-extrusion-base does not emit -NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: { 'fill-extrusion-color': '#abc', 'fill-extrusion-base': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/fill-extrusion-base-NaN/)
  })

  it('NaN line-offset does not emit -NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#abc', 'line-offset': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/stroke-offset-(?:left|right)-NaN/)
  })

  it('NaN line-blur does not emit -NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#abc', 'line-blur': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/stroke-blur-NaN/)
  })

  it('valid extrude/line values emit (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: { 'fill-extrusion-color': '#abc', 'fill-extrusion-height': 100 },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('fill-extrusion-height-100')
  })
})
