// Pin defensive filter on src.tiles non-string entries. Pre-fix a
// mixed array like [42, "real-url"] picked up the number at [0],
// regex coerced it to "42", and the emitted xgis carried `url: 42`
// (a bare number) where the parser expects a quoted string.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source.tiles non-string entries dropped', () => {
  it('mixed numeric / string entries: only strings emit', () => {
    const style = {
      version: 8,
      sources: {
        s: {
          type: 'raster',
          tiles: [42 as unknown, 'https://real.example.com/{z}/{x}/{y}.png'],
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('https://real.example.com/{z}/{x}/{y}.png')
    expect(code).not.toMatch(/url: 42/)
  })

  it('all-numeric tiles falls back to placeholder', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'raster', tiles: [1 as unknown, 2 as unknown, 3 as unknown] } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/url: \d/)
    expect(code).toMatch(/TODO: raster source missing url\/tiles/)
  })

  it('regression: all-string tiles still emit first', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://a.example.com/{z}/{x}/{y}.png', 'https://b.example.com/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('https://a.example.com')
  })
})
