// Pin defensive guard against malformed sources. Mapbox spec requires
// object bodies but partial / hand-edited JSON in the wild can have
// null source bodies. Pre-fix convertSource crashed at `src.tiles` /
// `src.scheme` etc. — the WHOLE style failed to convert (one bad
// source dropped every layer).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source null body guard', () => {
  it('null source body emits placeholder, does not crash', () => {
    const style = {
      version: 8,
      sources: { bad: null as unknown, good: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 'good', paint: { 'fill-color': '#000' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source bad')
    // The unrelated `good` source + layer still convert through.
    expect(code).toContain('source good')
    expect(code).toContain('layer l')
  })

  it('non-object source body emits placeholder', () => {
    const style = {
      version: 8,
      sources: { bad: 'not-an-object' as unknown },
      layers: [],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source bad')
    expect(code).toContain('invalid source body')
  })

  it('regression: valid source still emits normally', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).not.toContain('invalid source body')
  })
})
