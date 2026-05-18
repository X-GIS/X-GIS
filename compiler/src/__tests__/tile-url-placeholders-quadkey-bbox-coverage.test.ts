// Pin warnings for Mapbox tile URL templates using {quadkey} (Bing
// scheme) or {bbox-epsg-3857} (WMS bbox). X-GIS runtime substitutes
// only {z}/{x}/{y} so the unsubstituted text reaches fetch and 404s.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('tile URL placeholders beyond {z}/{x}/{y}', () => {
  it('quadkey placeholder warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://t.tiles.virtualearth.net/tiles/r{quadkey}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/uses \{quadkey\} placeholder/)
  })

  it('bbox-epsg-3857 placeholder warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/wms?bbox={bbox-epsg-3857}'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/uses \{bbox-epsg-3857\} placeholder/)
  })

  it('standard {z}/{x}/{y} does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/uses \{quadkey\}/)
    expect(code).not.toMatch(/uses \{bbox-epsg-3857\}/)
  })

  it('url field with quadkey also warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', url: 'https://t.tiles.virtualearth.net/r/{quadkey}.png' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/uses \{quadkey\}/)
  })
})
