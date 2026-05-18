// Pin warning when a layer reads from a vector/pmtiles/tilejson
// source but omits `source-layer`. Mapbox spec requires it — without
// it the runtime decoder has no MVT layer to read from and emits
// zero features → blank layer with no diagnostic. One of the top-3
// "my layer doesn't render" support cases on hand-edited styles.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('vector layer missing source-layer', () => {
  it('vector source layer without source-layer warns', () => {
    const style = {
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://example.com/v.pmtiles' },
      },
      layers: [
        { id: 'l', type: 'fill', source: 'v', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Layer "l" reads from vector source "v" but has no source-layer/)
  })

  it('pmtiles source layer without source-layer warns', () => {
    const style = {
      version: 8,
      sources: {
        p: { type: 'pmtiles', url: 'https://example.com/p.pmtiles' },
      },
      layers: [
        { id: 'l', type: 'fill', source: 'p', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/no source-layer/)
  })

  it('vector source with source-layer does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://example.com/v.pmtiles' },
      },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 'v',
          'source-layer': 'water',
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/no source-layer/)
  })

  it('raster layer does NOT require source-layer', () => {
    const style = {
      version: 8,
      sources: {
        r: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] },
      },
      layers: [
        { id: 'l', type: 'raster', source: 'r' },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/no source-layer/)
  })

  it('geojson layer does NOT require source-layer', () => {
    const style = {
      version: 8,
      sources: {
        g: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'l', type: 'fill', source: 'g', paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/no source-layer/)
  })
})
