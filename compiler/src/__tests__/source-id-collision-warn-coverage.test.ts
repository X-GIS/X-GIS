// Pin source-id sanitization-collision warning. Pre-fix distinct
// raw ids (`world-tiles`, `world_tiles`) both collapsed to the same
// xgis identifier; the runtime registered only the last emitted
// source and every layer referencing the FIRST raw id silently
// switched to the overriding source's tiles. Mirror of the layer-id
// collision pre-walk.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source id sanitization collision', () => {
  it('warns when two distinct raw ids sanitize to the same identifier', () => {
    const style = {
      version: 8,
      sources: {
        'world-tiles': { type: 'vector', url: 'https://a.example.com/v.pmtiles' },
        'world_tiles': { type: 'vector', url: 'https://b.example.com/v.pmtiles' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/sanitizes to "world_tiles" — collides with another source "world-tiles"/)
  })

  it('distinct sanitized ids do NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        'world': { type: 'vector', url: 'https://a.example.com/v.pmtiles' },
        'continents': { type: 'vector', url: 'https://b.example.com/v.pmtiles' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/collides/)
  })

  it('digit-leading collapse warns (1km vs _1km)', () => {
    const style = {
      version: 8,
      sources: {
        '1km': { type: 'vector', url: 'https://a.example.com/v.pmtiles' },
        '_1km': { type: 'vector', url: 'https://b.example.com/v.pmtiles' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/sanitizes to "_1km" — collides/)
  })
})
