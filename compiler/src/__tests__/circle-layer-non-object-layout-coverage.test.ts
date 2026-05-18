// Pin defensive read of circle layer's layout via safePropsBag. Pre-
// fix `convertCircleLayer` re-read `layer.layout` raw for the
// circle-sort-key (layout) ignored-prop check — a malformed layer
// with `layout: "..."` (string) would let the lookup index a char
// and emit garbage in the ignored-props warning.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('circle layer non-object layout defensive guard', () => {
  it('string-typed layout does not crash + emits no garbage warning', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          layout: 'not-an-object' as unknown,
          paint: { 'circle-color': '#abc' },
        },
      ],
    }
    // Just calling convertMapboxStyle is the regression check —
    // pre-fix this either crashed (index access on the string
    // returned a char that broke downstream truthy checks) or
    // produced a "Circle layer ... — ignored properties: <char>"
    // warning. Now it converts cleanly without spurious ignored-
    // prop noise from a non-existent circle-sort-key.
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer l')
    expect(code).not.toMatch(/ignored properties:.*circle-sort-key \(layout\)/)
  })

  it('array-typed layout does not crash', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          layout: [1, 2, 3] as unknown,
          paint: { 'circle-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer l')
  })
})
