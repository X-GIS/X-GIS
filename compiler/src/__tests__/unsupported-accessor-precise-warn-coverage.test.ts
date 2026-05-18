// Pin precise warnings for Mapbox accessors with known-pending
// runtime support: ["heatmap-density"], ["line-progress"],
// ["feature-state"], ["image"], ["within"], etc. Pre-fix all fell
// to the generic "Expression not converted" catch-all and the user
// had to guess which roadmap item the gap belonged to.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('precise unsupported-accessor warnings', () => {
  it('heatmap-density warns with Batch 3 hint', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['heatmap-density'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["heatmap-density"\] not yet supported.*Batch 3/)
  })

  it('line-progress warns with lineMetrics hint', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': ['line-progress'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["line-progress"\] not yet supported.*lineMetrics/)
  })

  it('feature-state warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['feature-state', 'hover'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["feature-state"\] not yet supported.*setFeatureState/)
  })

  it('within warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['within', { type: 'Polygon', coordinates: [[]] }],
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["within"\] not yet supported/)
  })

  it('unrelated unknown operator still falls to generic warning', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['totally-fake-op', 1] as unknown,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Expression not converted/)
  })
})
