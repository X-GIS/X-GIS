// Pin third-party "type": "tilejson" source declaration support.
// Mapbox spec uses `type: "vector"` + URL sniffing; some third-party
// tooling writes `"type": "tilejson"` directly. Pre-fix that fell to
// "unsupported source type" and the layer dropped entirely.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('explicit "type": "tilejson" source', () => {
  it('routes to xgis type: tilejson when URL is present', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {
        osm: { type: 'tilejson', url: 'https://example.com/manifest.json' } as never,
      },
      layers: [{
        id: 'l',
        type: 'fill',
        source: 'osm',
        'source-layer': 'water',
        paint: { 'fill-color': '#a4c8d5' },
      }],
    } as never)
    expect(out).toMatch(/source osm \{[\s\S]*type:\s*tilejson/)
    expect(out).toContain('"https://example.com/manifest.json"')
  })

  it('warns + emits placeholder when URL missing', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { x: { type: 'tilejson' } as never },
      layers: [],
    } as never)
    expect(out).toContain('TODO: tilejson source missing url')
  })

  it('accepts tiles[0] when url field is absent', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {
        s: { type: 'tilejson', tiles: ['https://x/{z}/{x}/{y}'] } as never,
      },
      layers: [],
    } as never)
    expect(out).toMatch(/url:\s*"https:\/\/x\/\{z\}\/\{x\}\/\{y\}"/)
  })
})
