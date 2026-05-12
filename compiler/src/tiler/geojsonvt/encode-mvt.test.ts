// Round-trip test for the MVT encoder. We slice a GeoJSON FC with
// the geojsonvt port, encode the resulting tile to PBF bytes, then
// run the bytes through the existing decodeMvtTile (the same code
// path PMTiles archives flow through). The decoded features should
// recover the same geometry topology + same properties that the
// tile carried.

import { describe, it, expect } from 'vitest'
import { geojsonvt } from './index'
import { encodeMVT } from './encode-mvt'
import { decodeMvtTile } from '../../input/mvt-decoder'
import type { GeoJSONInput } from './types'

const TWO_FEATURES: GeoJSONInput = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 1,
      properties: { name: 'A', rank: 3, hot: true },
      geometry: { type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] },
    },
    {
      type: 'Feature',
      id: 2,
      properties: { name: 'B', class: 'ocean' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [10, 5], [20, 0]] },
    },
  ],
} as GeoJSONInput

describe('encodeMVT — round-trip via decodeMvtTile', () => {
  it('polygon + line at z=0 round-trip preserves properties and feature count', () => {
    const idx = geojsonvt(TWO_FEATURES)
    const tile = idx.getTile(0, 0, 0)
    expect(tile).not.toBeNull()

    const bytes = encodeMVT([{ name: 'src', tile: tile! }])
    expect(bytes.length).toBeGreaterThan(0)

    const decoded = decodeMvtTile(bytes, 0, 0, 0)
    expect(decoded.length).toBe(2)

    const polygon = decoded.find(f => f.properties?.name === 'A')
    const line = decoded.find(f => f.properties?.name === 'B')
    expect(polygon).toBeDefined()
    expect(line).toBeDefined()

    expect(polygon!.geometry.type).toBe('Polygon')
    expect(line!.geometry.type).toBe('LineString')

    // Properties survive (modulo _layer addition by decoder)
    expect(polygon!.properties).toMatchObject({ name: 'A', rank: 3, hot: true, _layer: 'src' })
    expect(line!.properties).toMatchObject({ name: 'B', class: 'ocean', _layer: 'src' })
  })

  it('emits empty bytes when no features in any layer', () => {
    const empty: GeoJSONInput = { type: 'FeatureCollection', features: [] } as GeoJSONInput
    const idx = geojsonvt(empty)
    const tile = idx.getTile(0, 0, 0)
    // geojsonvt returns null for empty input; encoder handles that
    // via a synthetic empty-tile shim.
    if (tile === null) {
      // No tile to encode at all → bytes should also be empty.
      const bytes = encodeMVT([])
      expect(bytes.length).toBe(0)
      return
    }
    const bytes = encodeMVT([{ name: 'src', tile }])
    // 0 features → no Layer message written → empty Tile.
    expect(bytes.length).toBe(0)
  })

  it('multi-layer encoding emits one Layer per source', () => {
    const a: GeoJSONInput = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'a-poly' },
        geometry: { type: 'Polygon', coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]] },
      }],
    } as GeoJSONInput
    const b: GeoJSONInput = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'b-line' },
        geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] },
      }],
    } as GeoJSONInput
    const tileA = geojsonvt(a).getTile(0, 0, 0)!
    const tileB = geojsonvt(b).getTile(0, 0, 0)!

    const bytes = encodeMVT([
      { name: 'layer_a', tile: tileA },
      { name: 'layer_b', tile: tileB },
    ])
    const decoded = decodeMvtTile(bytes, 0, 0, 0)
    expect(decoded.length).toBe(2)
    const aFeature = decoded.find(f => f.properties?._layer === 'layer_a')
    const bFeature = decoded.find(f => f.properties?._layer === 'layer_b')
    expect(aFeature?.properties?.name).toBe('a-poly')
    expect(bFeature?.properties?.name).toBe('b-line')
  })

  it('preserves feature id when set as integer', () => {
    const idx = geojsonvt(TWO_FEATURES)
    const tile = idx.getTile(0, 0, 0)!
    const bytes = encodeMVT([{ name: 'src', tile }])
    const decoded = decodeMvtTile(bytes, 0, 0, 0)
    // decodeMvtTile doesn't surface id on its GeoJSONFeature, but
    // the bytes contain it — sanity-check by re-decoding via raw
    // @mapbox/vector-tile to confirm round-trip.
    const { VectorTile } = require('@mapbox/vector-tile') as typeof import('@mapbox/vector-tile')
    const Pbf = require('pbf').default ?? require('pbf')
    const tileObj = new VectorTile(new Pbf(bytes))
    const layer = tileObj.layers['src']
    const ids = new Set<number>()
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i) as unknown as { id?: number }
      if (f.id !== undefined) ids.add(f.id)
    }
    expect(ids.has(1)).toBe(true)
    expect(ids.has(2)).toBe(true)
    // Avoid unused-var lint
    void decoded
  })
})
