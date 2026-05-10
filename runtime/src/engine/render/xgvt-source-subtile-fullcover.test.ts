import { describe, expect, it } from 'vitest'
import { TileCatalog } from '../../data/tile-catalog'
import {
  decomposeFeatures,
  compileGeoJSONToTiles,
  tileKey,
  TILE_FLAG_FULL_COVER,
} from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/compiler'

// Regression for 95d7f44: when compileSingleTile detects that a polygon
// fully covers a sub-tile, it clears the scratch buffers and emits
// `fullCover: true` with empty vertices — expecting the caller to
// synthesize the quad from the entry's fullCoverFeatureId.
// TileCatalog.compileTileOnDemand used to route that empty buffer
// straight into cacheTileData, so the renderer received a tile with
// vertices.length === 0 and drew nothing. Surfaced on the
// fixture_stress_many_layers demo — each per-layer filter's polygon
// fully covers many z>6 sub-tiles, and those layers went blank.
//
// The fix branches to createFullCoverTileData when
// (tile.fullCover && tile.vertices.length === 0). These tests cover
// both the positive case (quad synthesized, drawable) and the negative
// case (non-full-cover sub-tile still goes through the normal path).

function makeWorldCoverGeoJSON(): GeoJSONFeatureCollection {
  // Two features so featureIndex (used as fid) can be > 0 — one distant
  // feature (ignored) plus the world-covering polygon that triggers the
  // fullCover path with a non-zero fid.
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'distant' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-179, -89], [-178, -89], [-178, -88], [-179, -88], [-179, -89]]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'world' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]]],
        },
      },
    ],
  }
}

function makeSmallPolygonGeoJSON(): GeoJSONFeatureCollection {
  // Much smaller polygon so deep sub-tiles are NOT fully covered and
  // the normal (non-fullCover) path is exercised.
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
      },
    }],
  }
}

describe('TileCatalog full-cover sub-tile generation', () => {
  it('runtime-generated full-cover sub-tile is drawable (quad synthesized)', () => {
    const geojson = makeWorldCoverGeoJSON()
    const parts = decomposeFeatures(geojson.features)
    const set = compileGeoJSONToTiles(geojson, { minZoom: 0, maxZoom: 0 })

    const source = new TileCatalog()
    source.addTileLevel(set.levels[0], set.bounds, set.propertyTable)
    source.setRawParts(parts, 22)

    // Request a z=6 sub-tile at the equator. At this zoom the polygon
    // fully contains the tile, so compileSingleTile returns fullCover.
    const subKey = tileKey(6, 32, 32)
    const ok = source.compileTileOnDemand(subKey)
    expect(ok).toBe(true)

    const sub = source.getTileData(subKey)
    expect(sub).not.toBeNull()
    // Pre-fix failure mode: vertices.length === 0, indices.length === 0.
    // Post-fix: createFullCoverTileData synthesized a 4-vertex quad
    // (stride 5 × 4 = 20 floats) + 6 indices (two triangles).
    expect(sub!.vertices.length).toBe(20)
    expect(sub!.indices.length).toBe(6)
  })

  it('the synthetic entry carries the TILE_FLAG_FULL_COVER flag and feature id round-trip', () => {
    const geojson = makeWorldCoverGeoJSON()
    const parts = decomposeFeatures(geojson.features)
    const set = compileGeoJSONToTiles(geojson, { minZoom: 0, maxZoom: 0 })

    const source = new TileCatalog()
    source.addTileLevel(set.levels[0], set.bounds, set.propertyTable)
    source.setRawParts(parts, 22)

    const subKey = tileKey(6, 32, 32)
    source.compileTileOnDemand(subKey)

    const index = source.getIndex()
    expect(index).not.toBeNull()
    const entry = index!.entryByHash.get(subKey)
    expect(entry).toBeDefined()
    // Entry flags encoded as TILE_FLAG_FULL_COVER | (fid << 1).
    expect(entry!.flags & TILE_FLAG_FULL_COVER).toBe(TILE_FLAG_FULL_COVER)
    // Feature id (the second feature's index = 1, since it covers the
    // sub-tile — feature 0 is the distant dummy).
    expect(entry!.fullCoverFeatureId).toBe(1)
    // flags >>> 1 reconstructs the fid encoded into the upper bits.
    expect(entry!.flags >>> 1).toBe(entry!.fullCoverFeatureId)
  })

  it('non-full-cover sub-tile does NOT receive a synthetic quad', () => {
    // The small polygon covers only a sliver of a z=6 sub-tile — the
    // fullCover branch should NOT fire. compileSingleTile returns
    // regular triangulated geometry or null (tile too empty). Either
    // way, we should NOT see the synthetic quad pattern (4 verts × 6
    // indices, TILE_FLAG_FULL_COVER set).
    const geojson = makeSmallPolygonGeoJSON()
    const parts = decomposeFeatures(geojson.features)
    const set = compileGeoJSONToTiles(geojson, { minZoom: 0, maxZoom: 0 })

    const source = new TileCatalog()
    source.addTileLevel(set.levels[0], set.bounds, set.propertyTable)
    source.setRawParts(parts, 22)

    // z=6 sub-tile covering lon 0-5.625°, lat 0-5.625° contains the tiny polygon
    const subKey = tileKey(6, 32, 31)
    source.compileTileOnDemand(subKey)

    const index = source.getIndex()
    const entry = index!.entryByHash.get(subKey)
    if (entry) {
      // If an entry was created, it must NOT have the full-cover flag.
      expect(entry.flags & TILE_FLAG_FULL_COVER).toBe(0)
    }
  })
})
