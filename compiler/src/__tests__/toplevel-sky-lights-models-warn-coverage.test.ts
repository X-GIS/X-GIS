// Pin warning surfacing for Mapbox v2+ / v3 top-level style fields
// not implemented in X-GIS: `sky` (atmospheric haze), `lights` (v3
// standard-style ambient + directional rig), `models` (v3 standard-
// style 3D glTF placements). Pre-fix these dropped silently.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('top-level v2+/v3 fields surface as gaps', () => {
  it('sky warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      sky: { 'sky-color': '#88c' },
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/sky/)
    expect(code).toMatch(/Top-level style fields ignored/)
  })

  it('lights warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      lights: [{ id: 'ambient', type: 'ambient', properties: { color: '#fff' } }],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/lights/)
  })

  it('models warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      models: { 'tree-1': 'https://example.com/tree.glb' },
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/models/)
  })

  it('plain style does NOT warn (regression guard)', () => {
    const style = { version: 8, sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Top-level style fields ignored/)
  })
})
