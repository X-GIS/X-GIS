// sky layer skip handling — Mapbox `sky` layer renders an
// atmospheric gradient dome. X-GIS doesn't implement it; the
// converter now explicitly skips it with a descriptive note rather
// than falling through to the generic fallback which would emit
// a malformed body.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('sky layer skip', () => {
  it('emits a SKIPPED comment with descriptive reason', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{ id: 'sky', type: 'sky', paint: { 'sky-color': '#88aaff' } }],
    }
    const warnings: string[] = []
    const xgis = convertMapboxStyle(style as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(xgis).toContain('// SKIPPED layer "sky" type="sky"')
    expect(xgis).toContain('sky layer')
    // Warning carries the same reason for diagnostic surface.
    expect(warnings.some((w) => w.includes('sky layer'))).toBe(true)
  })

  it('non-sky layers still convert when a sky layer is also present', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        { id: 'sky', type: 'sky', paint: { 'sky-color': '#88aaff' } },
        {
          id: 'land',
          type: 'fill',
          source: 'v',
          'source-layer': 'land',
          paint: { 'fill-color': '#ddd' },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    // Sky → skipped, land → real layer
    expect(xgis).toContain('// SKIPPED')
    expect(xgis).toContain('layer land')
  })
})
