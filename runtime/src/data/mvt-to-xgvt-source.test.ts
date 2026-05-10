// Integration test for the MVT → TileCatalog bridge used by
// loadPMTilesSource. Skips PMTiles network/file IO entirely — feeds
// a synthetic MVT (geojson-vt + vt-pbf) through the same pipeline
// (decodeMvtTile → decomposeFeatures → compileSingleTile →
// TileCatalog.addTileLevel) and asserts the resulting source is
// queryable and renders non-empty geometry.

import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import {
  decodeMvtTile, decomposeFeatures, compileSingleTile, tileKey,
  type CompiledTile, type PropertyTable, type TileLevel,
} from '@xgis/compiler'
import { TileCatalog } from './tile-catalog'

describe('MVT → TileCatalog pipeline (PMTiles bridge core)', () => {
  it('compiles an MVT tile into an TileCatalog that exposes the geometry', () => {
    const orig = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[-10, -10], [10, 10]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]],
          },
          properties: {},
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
    const tile = idx.getTile(0, 0, 0)
    const buf = vtpbf.fromGeojsonVt({ shapes: tile })

    const z = 0, x = 0, y = 0
    const features = decodeMvtTile(buf, z, x, y)
    expect(features.length).toBeGreaterThanOrEqual(2)

    const parts = decomposeFeatures(features)
    const compiled = compileSingleTile(parts, z, x, y, 0)
    expect(compiled).not.toBeNull()
    expect(compiled!.lineVertices.length).toBeGreaterThan(0)
    expect(compiled!.vertices.length).toBeGreaterThan(0)

    const tiles = new Map<number, CompiledTile>()
    tiles.set(tileKey(z, x, y), compiled!)
    const level: TileLevel = { zoom: z, tiles }

    const source = new TileCatalog()
    const propTable: PropertyTable = { fieldNames: [], fieldTypes: [], values: [] }
    source.addTileLevel(level, [-180, -90, 180, 90], propTable)

    expect(source.hasData()).toBe(true)
    expect(source.maxLevel).toBe(0)
    const data = source.getTileData(tileKey(z, x, y))
    expect(data).toBeDefined()
    expect(data!.lineVertices.length).toBeGreaterThan(0)
    expect(data!.vertices.length).toBeGreaterThan(0)
  })

  it('handles multi-layer MVTs by flattening + tagging _layer', () => {
    const water = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] },
        properties: {},
      }],
    }
    const t = geojsonVt(water, { maxZoom: 0, indexMaxZoom: 0 }).getTile(0, 0, 0)
    const buf = vtpbf.fromGeojsonVt({ water: t })

    const features = decodeMvtTile(buf, 0, 0, 0)
    expect(features.every(f => f.properties._layer === 'water')).toBe(true)
    const parts = decomposeFeatures(features)
    const compiled = compileSingleTile(parts, 0, 0, 0, 0)
    expect(compiled).not.toBeNull()
    expect(compiled!.vertices.length).toBeGreaterThan(0)
  })
})
