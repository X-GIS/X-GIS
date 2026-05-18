// Pin warning when a layer references a source id not declared in
// `style.sources`. Pre-fix the runtime saw no tiles + the layer
// rendered blank with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer references undeclared source', () => {
  it('warns when source id missing from style.sources', () => {
    const style = {
      version: 8,
      sources: {
        present: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'l', type: 'fill', source: 'missing', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/references undeclared source "missing"/)
  })

  it('declared source does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        present: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'l', type: 'fill', source: 'present', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/undeclared source/)
  })

  it('background layer without source does NOT warn', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/undeclared source/)
  })

  it('layer with missing source field does NOT warn (spec allows)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        // No source — uncommon but spec permits e.g. for symbol layers
        // that read from a separately-attached collection. Falls
        // through without warning here; downstream handles the missing
        // source gracefully.
        { id: 'l', type: 'fill', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/undeclared source/)
  })
})
