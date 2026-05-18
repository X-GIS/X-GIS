// Pin geometric sanity checks for source bounds beyond pure
// finiteness:
//   - south > north → inverted latitude box; never intersects any
//     tile → source is dead.
//   - lat outside [-90, 90] / lon outside [-180, 180] → typo
//     (commonly swapped axes when copying from a CSV).
// west > east IS intentionally NOT flagged — Mapbox spec permits
// antimeridian-crossing bounds.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source bounds sanity checks', () => {
  it('inverted latitude (south > north) warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', bounds: [-1, 10, 1, -10] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/south=10 > north=-10/)
  })

  it('latitude out of range warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', bounds: [0, 100, 1, 200] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/latitude out of \[-90, 90\]/)
  })

  it('longitude out of range warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', bounds: [200, 0, 300, 10] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/longitude out of \[-180, 180\]/)
  })

  it('antimeridian-crossing bounds (west > east) does NOT warn', () => {
    // Bering-strait extent: from +170 wrapping past +180 to -170.
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', bounds: [170, 60, -170, 70] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/south=.* > north/)
    expect(code).not.toMatch(/longitude out of/)
  })

  it('normal bounds do NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', bounds: [-180, -85, 180, 85] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/south=.* > north/)
    expect(code).not.toMatch(/latitude out of/)
    expect(code).not.toMatch(/longitude out of/)
  })
})
