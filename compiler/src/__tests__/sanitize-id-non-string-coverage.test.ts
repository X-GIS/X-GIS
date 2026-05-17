// Pin sanitizeId tolerance of non-string inputs. Pre-fix a numeric
// layer id (legacy v0/v1 Mapbox tooling or hand-edited JSON) crashed
// at `s.replace(...)` because numbers don't have `.replace`. The
// whole layer dropped — and on the convert-style call path, every
// layer past the first numeric-id one was lost too because the
// thrown error propagated up.

import { describe, it, expect } from 'vitest'
import { sanitizeId } from '../convert/utils'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('sanitizeId non-string tolerance', () => {
  it('numeric id is coerced to string and sanitised', () => {
    expect(sanitizeId(5 as unknown as string)).toBe('_5')
  })

  it('null id is coerced to "null" identifier', () => {
    expect(sanitizeId(null as unknown as string)).toBe('null')
  })

  it('undefined id is coerced to "undefined" identifier', () => {
    expect(sanitizeId(undefined as unknown as string)).toBe('undefined')
  })

  it('numeric-id layer in style converts without crash', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 42 as unknown as string, type: 'fill', source: 's', paint: { 'fill-color': '#000' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer _42')
  })

  it('regression: string id still unchanged', () => {
    expect(sanitizeId('road-major')).toBe('road_major')
  })
})
