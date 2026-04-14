import { describe, expect, it } from 'vitest'
import { compileSingleTile, decomposeFeatures } from '../tiler/vector-tiler'

// Regression: the Sutherland-Hodgman clipper prepends a duplicate closure
// vertex to polygon rings, which used to slip into outlineIndices as a
// degenerate (v,v) self-loop. That self-loop poisoned the runtime adjacency
// lookup in buildLineSegments (picking the degenerate edge as "first other"
// neighbor) and left real edges with zero prev/next tangents — joins failed
// and polygon outlines rendered as visibly disconnected AB/BC/CD/DA strokes.

describe('polygon outline adjacency', () => {
  it('produces no degenerate self-loops in outlineIndices', () => {
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
        },
      }],
    }
    const parts = decomposeFeatures(geojson.features as any)
    const tile = compileSingleTile(parts, 2, 2, 1, 2)
    expect(tile).not.toBeNull()
    const oi = tile!.outlineIndices
    expect(oi.length).toBeGreaterThan(0)
    // Exactly 4 edges for a 4-sided polygon (no extra degenerate edge).
    expect(oi.length / 2).toBe(4)
    // No self-loops.
    for (let i = 0; i < oi.length; i += 2) {
      expect(oi[i]).not.toBe(oi[i + 1])
    }
  })

  it('each outline vertex appears in exactly 2 edges (closed ring)', () => {
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
        },
      }],
    }
    const parts = decomposeFeatures(geojson.features as any)
    const tile = compileSingleTile(parts, 2, 2, 1, 2)!
    const oi = tile.outlineIndices
    const degree = new Map<number, number>()
    for (let i = 0; i < oi.length; i++) {
      degree.set(oi[i], (degree.get(oi[i]) ?? 0) + 1)
    }
    // Every vertex in a clean closed ring must have degree exactly 2
    // (one incoming + one outgoing edge). If clipping left a dangling or
    // duplicated index, this would fail and the runtime's prev/next
    // tangent lookup would produce zero vectors → broken joins.
    for (const [, d] of degree) expect(d).toBe(2)
  })
})
