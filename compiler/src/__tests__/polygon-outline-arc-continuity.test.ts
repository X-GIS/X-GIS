import { describe, expect, it } from 'vitest'
import { compileGeoJSONToTiles, decomposeFeatures } from '../tiler/vector-tiler'

// Arc parameter on polygon outlines. The outline now derives from the
// SAME per-tile `clipped` rings the fill tessellates (fill/outline
// coincidence fix), so arc is augmented PER-TILE and restarts near 0 in
// each tile. Cross-tile GLOBAL arc continuity (a former invariant, commit
// 3227174) was traded away to make the outline trace the fill's exact
// vertices — the only way to close the magnified fill/stroke gap. Two
// properties still hold and are pinned below:
//   1. a boundary-crossing polygon uses per-tile arc (NOT one global
//      sequence — the deliberate behavior change), and
//   2. arc is monotonic non-decreasing WITHIN each tile's chain (dash
//      phase + joins still work inside a tile).
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
  // SUPERSEDED by the fill/outline COINCIDENCE fix (d34aed2 made real).
  //
  // History: 3227174 routed the outline through a line-clip of the
  // ORIGINAL ring (Liang-Barsky) + augmentRingWithArc on the un-clipped
  // ring, so every clipped fragment inherited ONE global arc-space and
  // cross-tile dash phase was continuous. But that path's vertices came
  // from a DIFFERENT clipper than the fill (Sutherland-Hodgman), so the
  // outline landed up to a few metres off the fill edge at every tile
  // crossing — a gap visible under magnification (user-reported).
  //
  // The coincidence fix derives the outline from the SAME `clipped`
  // rings the fill tessellates. The clipped ring carries no whole-ring
  // parameter (Sutherland-Hodgman emits an independent ring per tile),
  // so arc is now augmented PER-TILE, starting near 0 in each tile.
  // Cross-tile GLOBAL arc continuity is the deliberate casualty:
  // recovering it would require non-clipped vertices, which reopens the
  // gap. Exact fill/outline coincidence won; dashed polygon outlines
  // (a niche style) lose phase continuity across tile seams.
  //
  // This test now PINS the new behavior: a boundary-crossing polygon's
  // outline arc is per-tile (max arc << full ring perimeter), NOT one
  // shared global sequence.
  it('a polygon spanning adjacent tiles uses PER-TILE arc (coincidence supersedes global arc)', () => {
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
    const tiles = [...z1!.tiles.values()].filter(t => t.outlineVertices.length > 0)
    expect(tiles.length).toBeGreaterThanOrEqual(2)

    // Per-tile arc: each tile's arc restarts near 0 and only spans that
    // tile's own clipped fragment. The max arc seen anywhere is a single
    // tile's contribution (~a few e6 m at the equator), well BELOW the
    // full ring perimeter (~1.78e7 m). Under the old global-arc path
    // maxArc reached the whole perimeter; that is intentionally gone.
    const allArcs: number[] = []
    for (const t of tiles) allArcs.push(...arcsFromTile(t.outlineVertices))
    const maxArc = Math.max(...allArcs)
    const minArc = Math.min(...allArcs)
    expect(maxArc).toBeLessThan(1e7)     // per-tile, NOT full perimeter
    expect(minArc).toBeLessThanOrEqual(1) // each tile's first vertex starts at 0
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
