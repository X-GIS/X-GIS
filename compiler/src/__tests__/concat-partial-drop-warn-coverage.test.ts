// Pin partial-drop warning for ["concat"]. Pre-fix a concat chain
// with one unsupported arg (e.g. ["image", "icon"] head) silently
// dropped the failing arg; the emitted concat call was missing the
// authored prefix/separator with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('concat partial-drop warning', () => {
  it('concat with unsupported arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': ['concat', ['image', 'icon-x'], ' ', ['get', 'name']],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["concat"\] dropped 1 of 3 non-null arg/)
  })

  it('concat with all valid args does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': ['concat', ['get', 'name'], ' (', ['get', 'class'], ')'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["concat"\] dropped/)
  })

  it('concat with null skip-arg does NOT warn (Mapbox spec)', () => {
    // null in concat is spec-valid "skip this segment" semantics.
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': ['concat', ['get', 'name'], null, ['get', 'suffix']],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["concat"\] dropped/)
  })
})
