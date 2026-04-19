import { describe, expect, it } from 'vitest'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'
import { serializeXGVT, parseGPUReadyTile, parseXGVTIndex } from '../tiler/tile-format'

interface MinimalGeoJSON {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: Record<string, unknown>
    geometry: { type: 'Polygon'; coordinates: number[][][] }
  }>
}

// CPU regression: the binary .xgvt decoder used to leave outlineVertices
// empty, forcing the runtime to fall back to a per-tile BFS chain
// walker (which reset arc_start at every tile boundary and produced
// the dashed-border bug). After unification the decoder runs the same
// augmentRingWithArc + tessellateLineToArrays helpers the live tiler
// uses, so binary-loaded tiles ship outlineVertices with proper
// per-ring monotonic arc.
//
// This test compiles a polygon → serializes through .xgvt → parses
// back, and asserts the parsed tile carries non-empty outlineVertices
// with arcs that match the original ring perimeter.

const STRIDE = 10
const ARC_OFFSET = 5

describe('polygon outline arc — binary .xgvt round-trip', () => {
  it('decoded tile carries outlineVertices with monotonic per-ring arc', () => {
    const geojson: MinimalGeoJSON = {
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
    // Compile fully (z=2 to exercise the binary path) and serialize
    // with no GPU-ready overlay so parseGPUReadyTile falls through to
    // the compact ring-decode path (where the outline derivation lives).
    const set = compileGeoJSONToTiles(geojson as never, { minZoom: 2, maxZoom: 2 })
    const buf = serializeXGVT(set, { includeGPUReady: false })

    const index = parseXGVTIndex(buf)
    expect(index.entries.length).toBeGreaterThan(0)

    let foundOutline = false
    let perimeter = -Infinity
    for (const entry of index.entries) {
      const tile = parseGPUReadyTile(buf, entry)
      if (tile.outlineVertices.length === 0) continue
      foundOutline = true
      const n = tile.outlineVertices.length / STRIDE
      // Monotonic arc per chain (line-list pairs).
      for (let s = 0; s < tile.outlineLineIndices.length; s += 2) {
        const a = tile.outlineLineIndices[s], b = tile.outlineLineIndices[s + 1]
        expect(tile.outlineVertices[b * STRIDE + ARC_OFFSET])
          .toBeGreaterThanOrEqual(tile.outlineVertices[a * STRIDE + ARC_OFFSET])
      }
      // Track the largest arc seen (the wrap vertex carries perimeter).
      for (let i = 0; i < n; i++) {
        const arc = tile.outlineVertices[i * STRIDE + ARC_OFFSET]
        if (arc > perimeter) perimeter = arc
      }
    }
    expect(foundOutline).toBe(true)
    // Ring perimeter ≈ 2 × (10° lat at ~15°N + 10° lon at equator-ish)
    // → roughly a few million meters. Just assert it's a positive,
    // ring-scale value (>1e5 m), not a per-tile reset to ≈0.
    expect(perimeter).toBeGreaterThan(1e5)
  })
})
