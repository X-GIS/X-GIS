// Pin filterToXgis multi-wrap null = "no filter" treatment.
// Pre-fix `["literal", null]` filter fell through to exprToXgis
// which emitted the bare 'null' identifier. Runtime evaluated the
// filter to null → toBool(null) = false → EVERY feature dropped →
// the layer silently rendered empty.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('filter multi-wrap null', () => {
  it('["literal", null] filter returns null (no filter)', () => {
    const w: string[] = []
    expect(filterToXgis(['literal', null], w)).toBeNull()
  })

  it('["literal", ["literal", null]] (double-wrap) also returns null', () => {
    const w: string[] = []
    expect(filterToXgis(['literal', ['literal', null]], w)).toBeNull()
  })

  it('integration: layer with wrapped-null filter renders all features', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['literal', null] as unknown,
          paint: { 'fill-color': '#000' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // No filter clause should be emitted (which means: accept all features).
    expect(code).not.toContain('filter:')
    expect(code).toContain('layer l')
  })

  it('regression: real filter still emits', () => {
    const w: string[] = []
    expect(filterToXgis(['==', ['get', 'x'], 5], w)).toBe('.x == 5')
  })
})
