// Pin warning when a raster `tiles` URL template is missing the
// required `{z}/{x}/{y}` placeholders. Mapbox spec requires all
// three; pre-fix a static URL silently went through and the runtime
// fetched the same image for every tile coordinate.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('raster tiles[] URL placeholder validation', () => {
  it('warns when {z}/{x}/{y} placeholders missing', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/static-image.png'], tileSize: 256 },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing required URL placeholders: \{z\}, \{x\}, \{y\}/)
  })

  it('warns when only {z} is present (missing x + y)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/{z}/zoom.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing required URL placeholders/)
  })

  it('does NOT warn when all three present (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/missing required URL placeholder/)
  })

  it('does NOT warn for TileJSON manifest URL (.json)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/tiles.json'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/missing required URL placeholder/)
  })

  it('does NOT warn when url is used (not tiles[])', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', url: 'https://example.com/static.png' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/missing required URL placeholder/)
  })
})
