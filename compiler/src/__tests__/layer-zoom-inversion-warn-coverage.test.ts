// Pin warning when a layer has `minzoom > maxzoom` — the visible-
// zoom range is empty so the layer NEVER renders. Pre-fix this
// dropped silently with no diagnostic; common typo when copying
// zoom-band-segmented layers between styles or hand-editing JSON.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer minzoom > maxzoom inversion', () => {
  it('warns on inverted range', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'never-renders',
          type: 'fill',
          source: 's',
          minzoom: 14,
          maxzoom: 10,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/minzoom=14 > maxzoom=10/)
  })

  it('equal zooms do NOT warn (degenerate but valid one-zoom band)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: 10,
          maxzoom: 10,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/minzoom=.* > maxzoom/)
  })

  it('normal range does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: 5,
          maxzoom: 18,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/minzoom=.* > maxzoom/)
  })
})
