// Pin null-as-omit on circle-sort-key (layout). Pre-fix the gate only
// checked !== undefined, so an explicit null (Mapbox spec: null means
// "property omitted") triggered a spurious "ignored properties"
// warning. Mirror of the null-as-omit treatment on every other
// ignored-prop gate.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('circle-sort-key null-as-omit', () => {
  it('null circle-sort-key does NOT emit ignored warning', () => {
    const w: string[] = []
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          layout: { 'circle-sort-key': null },
          paint: { 'circle-color': '#000' },
        },
      ],
    }
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const code = convertMapboxStyle(style as never, { coverage } as never)
    w.push(...coverage.warnings)
    expect(code).toBeTruthy()
    // Warning should NOT mention circle-sort-key when explicit null.
    expect(w.join('\n')).not.toMatch(/circle-sort-key \(layout\)/)
  })

  it('explicit numeric circle-sort-key still triggers warning (regression guard)', () => {
    const w: string[] = []
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          layout: { 'circle-sort-key': 5 },
          paint: { 'circle-color': '#000' },
        },
      ],
    }
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const code = convertMapboxStyle(style as never, { coverage } as never)
    w.push(...coverage.warnings)
    expect(code).toBeTruthy()
    expect(w.join('\n')).toMatch(/circle-sort-key \(layout\)/)
  })
})
