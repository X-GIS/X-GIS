// Pin precise warnings for Mapbox accessors with known-pending
// runtime support: ["heatmap-density"], ["line-progress"],
// ["feature-state"], ["image"], ["within"], etc. Pre-fix all fell
// to the generic "Expression not converted" catch-all and the user
// had to guess which roadmap item the gap belonged to.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('precise unsupported-accessor warnings', () => {
  it('heatmap-density outside a heatmap-color ramp warns it has no generic value', () => {
    // The accessor IS supported inside heatmap-color (heatmapRampToXgis
    // bakes the ramp); anywhere else it still has no value — the warning
    // now points at that split instead of the retired Batch-3 roadmap.
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
    expect(code).toMatch(/\["heatmap-density"\] not yet supported.*heatmap-color ramp/)
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

  it('within converts (no longer warns) — CPU containment predicate', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: [
            'within',
            {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          ],
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["within"\] not yet supported/)
    expect(code).toContain('within(get("$geometry")')
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
