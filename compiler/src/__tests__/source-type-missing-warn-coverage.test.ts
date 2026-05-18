// Pin distinct warning shapes for source-type failure modes:
//   1. type missing entirely (undefined / null)
//   2. type is non-string
//   3. type is an unsupported string
// Pre-fix all three collapsed to the generic "unsupported type X"
// warning where X was JSON-stringified — the missing-field case
// surfaced as "unsupported type undefined", which sent users
// chasing the wrong fix.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source type validation modes', () => {
  it('missing type field warns specifically', () => {
    const style = {
      version: 8,
      sources: { s: { url: 'https://example.com/v.pmtiles' } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing the required type field/)
    expect(code).not.toMatch(/unsupported type "undefined"/)
  })

  it('null type field warns specifically', () => {
    const style = {
      version: 8,
      sources: { s: { type: null, url: 'x' } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing the required type field/)
  })

  it('non-string type warns with typeof', () => {
    const style = {
      version: 8,
      sources: { s: { type: 42 } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/type field must be a string \(got number\)/)
  })

  it('unsupported string type still warns (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'rasterclonic' } as unknown },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/unsupported type "rasterclonic"/)
  })
})
