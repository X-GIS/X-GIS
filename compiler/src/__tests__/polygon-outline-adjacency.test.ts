import { describe, expect, it } from 'vitest'
import { compileSingleTile, decomposeFeatures } from '../tiler/vector-tiler'

// Regression: after the polygon-outline pipeline was unified onto the
// line-feature path (augmentRingWithArc → clipLineToRect →
// tessellateLineToArrays → DSFUN stride-10 outlineVertices), the
// invariants this test enforces moved from `outlineIndices` (legacy
// stride-5 indices into the polygon fill buffer) to `outlineLineIndices`
// (stride-10 into the dedicated `outlineVertices` buffer).
//
// The historical concern still applies though: clipping algorithms
// occasionally emit a degenerate "edge to self" when a closure vertex
// gets duplicated. Such an edge poisons the runtime adjacency lookup
// in buildLineSegments (the degenerate self-loop wins as the "first
// other neighbour" and real edges end up with zero prev/next tangents
// → broken joins). tessellateLineToArrays is supposed to avoid that
// by emitting consecutive-pair indices into a freshly tessellated
// vertex buffer, so degeneracy here would point at a regression in
// either the augment step or the clip step.

describe('polygon outline adjacency', () => {
  it('produces no degenerate self-loops in outlineLineIndices', () => {
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
    const parts = decomposeFeatures(geojson.features)
    const tile = compileSingleTile(parts, 2, 2, 1, 2)
    expect(tile).not.toBeNull()
    const oli = tile!.outlineLineIndices
    expect(oli.length).toBeGreaterThan(0)
    // Closed quad → 4 actual segments around the perimeter.
    expect(oli.length / 2).toBe(4)
    for (let i = 0; i < oli.length; i += 2) {
      expect(oli[i]).not.toBe(oli[i + 1])
    }
  })

  it('every outline vertex appears in exactly 2 segments (closed ring)', () => {
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
    const parts = decomposeFeatures(geojson.features)
    const tile = compileSingleTile(parts, 2, 2, 1, 2)!
    const oli = tile.outlineLineIndices
    // Group vertex appearances by spatial position rather than raw index
    // so the wrap vertex (geometrically identical to vertex 0 but stored
    // separately so arc=perimeter survives) gets counted with vertex 0.
    // outlineVertices is DSFUN stride-10: [mx_h, my_h, mx_l, my_l, fid, arc, tin_x, tin_y, tout_x, tout_y].
    const ov = tile.outlineVertices
    const STRIDE = 10
    const posKey = (i: number) => {
      const mxH = ov[i * STRIDE], myH = ov[i * STRIDE + 1]
      const mxL = ov[i * STRIDE + 2], myL = ov[i * STRIDE + 3]
      // Round the reconstructed mercator coord to ~mm to fold wrap-vertex
      // duplicates with their geometric twin.
      return `${Math.round((mxH + mxL) * 1000)}|${Math.round((myH + myL) * 1000)}`
    }
    const degree = new Map<string, number>()
    for (let i = 0; i < oli.length; i++) {
      const k = posKey(oli[i])
      degree.set(k, (degree.get(k) ?? 0) + 1)
    }
    for (const [, d] of degree) expect(d).toBe(2)
  })
})
