// GeometryCollection decomposition (RFC 7946 §3.1.8).
//
// A valid GeoJSON Feature whose geometry is a GeometryCollection must
// contribute one GeometryPart per member geometry. Before the fix,
// decomposeFeatures' type switch had no GeometryCollection branch, so
// such a feature produced ZERO parts — silent data loss (it rendered as
// nothing). The sibling geojson-vt path (geojsonvt/convert.ts) already
// recurses GeometryCollection.geometries; this pins the same intent for
// the default inline-GeoJSON tiler path.

import { describe, expect, it } from 'vitest'
import { decomposeFeatures } from './vector-tiler'
import type { GeoJSONFeature } from './geojson-types'

// The compiler's minimal GeoJSONGeometry union omits GeometryCollection,
// so build the feature via a cast — runtime user data (whose union DOES
// include it) reaches decomposeFeatures through map.ts's inline path.
function gcFeature(): GeoJSONFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 0] },
        { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      ],
    } as unknown as GeoJSONFeature['geometry'],
  }
}

describe('decomposeFeatures: GeometryCollection (RFC 7946 §3.1.8)', () => {
  it('decomposes each member geometry (point + line), not zero', () => {
    const parts = decomposeFeatures([gcFeature()])
    expect(parts.length).toBe(2)

    const pointPart = parts.find((p) => p.type === 'point')
    const linePart = parts.find((p) => p.type === 'line')
    expect(pointPart).toBeDefined()
    expect(linePart).toBeDefined()

    // Both parts carry the parent feature's resolved id (default = index 0).
    expect(pointPart!.featureIndex).toBe(0)
    expect(linePart!.featureIndex).toBe(0)

    // The point part keeps its coordinate; the line keeps its vertices.
    expect(pointPart!.point).toEqual([0, 0])
    expect(linePart!.coords!.length).toBeGreaterThanOrEqual(2)
  })

  it('honors a custom idResolver for each produced part', () => {
    const parts = decomposeFeatures([gcFeature()], () => 42)
    expect(parts.length).toBe(2)
    for (const p of parts) expect(p.featureIndex).toBe(42)
  })
})
