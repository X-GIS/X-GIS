// Pin distinct warnings for GeoJSON source data field failure modes:
//   - undefined / null / missing → "has no data field"
//   - non-string non-object (number / boolean) → "must be a URL string
//     or inline object; got X"
// Pre-fix both fell to the same "missing" warning, sending users
// chasing the wrong fix when the real issue was a wrong-shape value.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('GeoJSON source data field validation', () => {
  it('missing data field warns specifically', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson' } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/has no data field/)
  })

  it('numeric data warns about type', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: 42 } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/data field must be a URL string or inline object; got number/)
  })

  it('boolean data warns about type', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: true } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/data field must be a URL string or inline object; got boolean/)
  })

  it('null data is treated as missing (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: null } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/has no data field/)
  })
})
