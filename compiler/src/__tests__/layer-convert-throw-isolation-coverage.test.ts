// Pin per-layer error isolation. A throw inside convertLayer or
// expandPerFeatureColorMatch must NOT take down conversion of every
// other layer in the style. Pre-fix the throw propagated up through
// convertMapboxStyle, the host got a SyntaxError instead of a partial
// style, and the whole basemap silently failed to render.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer convert throw isolation', () => {
  it('one layer with a recursive get accessor does not kill the rest', () => {
    // Build a self-referential expression that the converter can't
    // recurse through safely. (Mapbox spec says expressions are
    // acyclic; circular ones are out-of-spec but possible from
    // hand-edited / programmatic styles.)
    const recursive: unknown[] = ['get']
    recursive.push(recursive)  // ['get', <self>]
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'bad', type: 'fill', source: 's', paint: { 'fill-color': '#000' }, filter: recursive },
        { id: 'good', type: 'fill', source: 's', paint: { 'fill-color': '#fff' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    // 'good' must still emit even though 'bad' might fail.
    expect(code).toContain('layer good')
  })

  it('regression: well-formed style still converts cleanly', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'a', type: 'fill', source: 's', paint: { 'fill-color': '#f00' } },
        { id: 'b', type: 'line', source: 's', paint: { 'line-color': '#0f0' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer a')
    expect(code).toContain('layer b')
    expect(code).not.toContain('SKIPPED')
  })
})
