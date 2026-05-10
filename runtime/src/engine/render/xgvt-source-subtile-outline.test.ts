import { describe, expect, it } from 'vitest'
import { TileCatalog } from '../../data/tile-catalog'
import { decomposeFeatures, compileGeoJSONToTiles, tileKey } from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/compiler'

// CPU regression: when TileCatalog generates an over-zoom sub-tile from
// a parent tile, polygon outlines used to be re-clipped via per-segment
// Liang-Barsky on the parent's stride-5 outlineIndices — losing arc
// continuity at every sub-tile boundary. The fix runs the same
// augmentRingWithArc + clipLineToRect path the GeoJSON tiler uses,
// reconstructing outlineVertices from `parent.polygons` so each sub-
// tile's outline arc remains on the original ring's arc-space.
//
// This test compiles a polygon, addTileLevel into TileCatalog, then
// triggers generateSubTile and inspects the resulting TileData. Asserts
// outlineVertices is populated and every chain's arc values are
// monotonic per segment (line-list pairs).

const STRIDE = 10
const ARC_OFFSET = 5

describe('TileCatalog sub-tile outline arc continuity', () => {
  it('sub-tile inherits global ring arc from parent.polygons', () => {
    // Polygon spans roughly lon -30..30, lat -10..10 — large enough
    // that the z=1 parent tile (one of four) covers part of it and a
    // child sub-tile at z=2 inside that parent receives a meaningful
    // outline fragment.
    const geojson: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[-30, -10], [30, -10], [30, 10], [-30, 10], [-30, -10]]],
        },
      }],
    }

    decomposeFeatures(geojson.features)
    const set = compileGeoJSONToTiles(geojson, { minZoom: 1, maxZoom: 1 })
    const z1 = set.levels.find(l => l.zoom === 1)!
    expect(z1).toBeDefined()

    const source = new TileCatalog()
    source.addTileLevel(z1, set.bounds, set.propertyTable)

    // Pick a parent tile that we know has the polygon (any z=1 tile
    // inside the bounds — east hemisphere x=1 covers lon 0..180).
    const parentKey = tileKey(1, 1, 0)
    const parent = source.getTileData(parentKey)
    expect(parent).not.toBeNull()
    expect(parent!.polygons?.length ?? 0).toBeGreaterThan(0)

    // Generate a sub-tile at z=2 inside the parent (x=2, y=1 = lon 0..90,
    // lat 0..66 — the NE quadrant containing the east half of the polygon).
    const subKey = tileKey(2, 2, 1)
    const ok = source.generateSubTile(subKey, parentKey)
    expect(ok).toBe(true)

    const sub = source.getTileData(subKey)
    expect(sub).not.toBeNull()
    expect(sub!.outlineVertices).toBeDefined()
    expect(sub!.outlineVertices!.length).toBeGreaterThan(0)
    expect(sub!.outlineLineIndices).toBeDefined()

    const arcs: number[] = []
    const ov = sub!.outlineVertices!
    const oli = sub!.outlineLineIndices!
    for (let i = 0; i < ov.length / STRIDE; i++) arcs.push(ov[i * STRIDE + ARC_OFFSET])

    // Per-segment monotonicity (line-list pairs).
    for (let i = 0; i < oli.length; i += 2) {
      const a = oli[i], b = oli[i + 1]
      expect(arcs[b]).toBeGreaterThanOrEqual(arcs[a])
    }

    // Sub-tile outline arc must lie within the original ring's arc-
    // space (positive, less than ring perimeter ~1.78e7 m). If the
    // sub-tile path were re-resetting arc to 0 we'd see only a small
    // local range; we assert maxArc is at least 1e6 to confirm we're
    // sampling the ring's parametrization, not a per-tile reset.
    const maxArc = Math.max(...arcs)
    expect(maxArc).toBeGreaterThan(1e6)
  })
})
