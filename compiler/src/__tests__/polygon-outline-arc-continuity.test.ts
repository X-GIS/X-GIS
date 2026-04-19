import { describe, expect, it } from 'vitest'
import { compileGeoJSONToTiles, decomposeFeatures } from '../tiler/vector-tiler'

// Regression: polygon outlines used to flow through a per-tile BFS chain
// walker that reset arc_start at every tile boundary. Combined with the
// dash period being measured in Mercator meters, a polygon ring split
// across multiple tiles rendered each tile's edge with phase=0 — long
// synthetic boundary edges fit entirely in the dash "on" half and looked
// solid. The fix: route polygon outlines through the same augment +
// clip + tessellate pipeline as line features, so every outline vertex
// carries the global ring-relative arc length and the dash phase stays
// continuous across clipped tile fragments.
//
// This test asserts the invariant directly: a polygon ring large enough
// to span two tiles emits outlineVertices in BOTH tiles whose arc_start
// values lie on the SAME monotonic sequence (ring perimeter), not
// independent per-tile sequences starting at zero.
//
// Reading layout: outlineVertices is DSFUN stride-10 packed —
//   [mx_h, my_h, mx_l, my_l, feat_id, arc, tin_x, tin_y, tout_x, tout_y]
// We're only inspecting the arc field at index 5.

const STRIDE = 10
const ARC_OFFSET = 5

function arcsFromTile(outlineVerts: Float32Array): number[] {
  if (outlineVerts.length === 0) return []
  const n = outlineVerts.length / STRIDE
  const arr: number[] = new Array(n)
  for (let i = 0; i < n; i++) arr[i] = outlineVerts[i * STRIDE + ARC_OFFSET]
  return arr
}

describe('polygon outline arc continuity across tile boundaries', () => {
  it('a polygon spanning two horizontally adjacent tiles shares one arc-space', () => {
    // Polygon centered on the antimeridian-free 0° meridian so it splits
    // cleanly between west tile (x=0) and east tile (x=1) at zoom 1.
    // At z=1 the world is divided into a 2×2 tile grid; tile boundary
    // sits at lon=0. The polygon spans [-30, 30] lon × [-10, 10] lat —
    // crosses the meridian, so its outline must appear in BOTH x=0 and
    // x=1 at z=1.
    const geojson = {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            [-30, -10], [30, -10], [30, 10], [-30, 10], [-30, -10],
          ]],
        },
      }],
    }
    decomposeFeatures(geojson.features) // ensures parts decompose without throwing
    const set = compileGeoJSONToTiles(geojson, { minZoom: 1, maxZoom: 1 })
    expect(set.levels.length).toBeGreaterThan(0)
    const z1 = set.levels.find(l => l.zoom === 1)
    expect(z1).toBeDefined()
    // z=1 tiles: (z=1, x=0, y=0) west-north, (z=1, x=1, y=0) east-north,
    // (z=1, x=0, y=1) west-south, (z=1, x=1, y=1) east-south. Polygon
    // lat range [-10, 10] crosses the equator, so all four contain part
    // of the ring.
    const tiles = [...z1!.tiles.values()].filter(t => t.outlineVertices.length > 0)
    expect(tiles.length).toBeGreaterThanOrEqual(2)

    // Collect every arc value emitted across all tiles. Under the OLD
    // per-tile BFS path each tile's arc started at 0 — the union would
    // contain many duplicates near zero. Under the global-arc fix the
    // arcs lie on ONE monotonic sequence, so the maximum arc seen
    // across all tiles approximates the full ring perimeter.
    const allArcs: number[] = []
    for (const t of tiles) allArcs.push(...arcsFromTile(t.outlineVertices))
    const maxArc = Math.max(...allArcs)
    const minArc = Math.min(...allArcs)

    // Ring perimeter ≈ 2 × (60° lon at equator + 20° lat) in meters.
    // 60° at equator is ~6.7e6 m in Mercator; 20° lat is ~2.2e6 m.
    // Perimeter ≈ 1.78e7 m. We assert maxArc is in that ballpark
    // (>1e7) — under the buggy path, every tile's arc reset to 0 and
    // maxArc would only reach the longest single tile's contribution
    // (~3-4e6 m), well below 1e7.
    expect(maxArc).toBeGreaterThan(1e7)
    expect(minArc).toBeLessThanOrEqual(1) // first vertex starts at 0
  })

  it('arc values within a single tile increase monotonically along each clipped chain', () => {
    // A polygon entirely inside one tile has its outline emitted as a
    // single closed chain (or one chain per ring). Arc values must be
    // monotonically non-decreasing within each segment pair.
    const geojson = {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
        },
      }],
    }
    const set = compileGeoJSONToTiles(geojson, { minZoom: 2, maxZoom: 2 })
    const z2 = set.levels.find(l => l.zoom === 2)!
    const tile = [...z2.tiles.values()].find(t => t.outlineVertices.length > 0)
    expect(tile).toBeDefined()
    const arcs = arcsFromTile(tile!.outlineVertices)
    expect(arcs.length).toBeGreaterThan(0)
    // Walk by index pairs (line-list topology). Arc at index `b` must
    // be >= arc at index `a` for each segment because tessellateLineToArrays
    // emits chains in walk order.
    const indices = tile!.outlineLineIndices
    expect(indices.length % 2).toBe(0)
    for (let i = 0; i < indices.length; i += 2) {
      const a = indices[i], b = indices[i + 1]
      expect(arcs[b]).toBeGreaterThanOrEqual(arcs[a])
    }
  })
})
