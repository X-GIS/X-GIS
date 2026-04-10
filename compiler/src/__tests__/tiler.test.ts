import { describe, expect, it } from 'vitest'
import {
  encodeCoords, decodeCoords,
  encodeIndices, decodeIndices,
  zigzagEncode, zigzagDecode,
} from '../tiler/encoding'
import { simplify, toleranceForZoom } from '../tiler/simplify'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'
import type { GeoJSONFeatureCollection } from '../../../runtime/src/loader/geojson'

describe('ZigZag Encoding', () => {
  it('encodes and decodes zigzag', () => {
    expect(zigzagEncode(0)).toBe(0)
    expect(zigzagEncode(-1)).toBe(1)
    expect(zigzagEncode(1)).toBe(2)
    expect(zigzagEncode(-2)).toBe(3)
    expect(zigzagEncode(2)).toBe(4)

    expect(zigzagDecode(0)).toBe(0)
    expect(zigzagDecode(1)).toBe(-1)
    expect(zigzagDecode(2)).toBe(1)
    expect(zigzagDecode(3)).toBe(-2)
  })
})

describe('Coordinate Encoding', () => {
  it('round-trips coordinate arrays', () => {
    const coords = [127.0, 37.5, 127.1, 37.6, 127.05, 37.55]
    const encoded = encodeCoords(coords)
    const decoded = decodeCoords(encoded)

    expect(decoded.length).toBe(coords.length)
    for (let i = 0; i < coords.length; i++) {
      expect(decoded[i]).toBeCloseTo(coords[i], 5)
    }
  })

  it('compresses delta sequences efficiently', () => {
    // Small deltas should compress well
    const coords: number[] = []
    for (let i = 0; i < 100; i++) {
      coords.push(127.0 + i * 0.001, 37.5 + i * 0.001)
    }
    const encoded = encodeCoords(coords)
    const rawSize = coords.length * 4 // Float32 = 4 bytes each
    expect(encoded.byteLength).toBeLessThan(rawSize * 0.6) // significant compression
  })
})

describe('Index Encoding', () => {
  it('round-trips index arrays', () => {
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6])
    const encoded = encodeIndices(indices)
    const decoded = decodeIndices(encoded)
    expect([...decoded]).toEqual([...indices])
  })
})

describe('Douglas-Peucker Simplification', () => {
  it('simplifies a line', () => {
    const ring = [
      [0, 0], [1, 0.1], [2, 0], [3, 0.05], [4, 0],
    ]
    const simplified = simplify(ring, 0.2)
    expect(simplified.length).toBeLessThan(ring.length)
    expect(simplified[0]).toEqual([0, 0])
    expect(simplified[simplified.length - 1]).toEqual([4, 0])
  })

  it('preserves shape within tolerance', () => {
    const ring = [[0, 0], [1, 1], [2, 0]]
    // With very low tolerance, should keep all points
    const simplified = simplify(ring, 0.001)
    expect(simplified.length).toBe(3)
  })

  it('returns input for short arrays', () => {
    expect(simplify([[0, 0], [1, 1]], 1)).toEqual([[0, 0], [1, 1]])
    expect(simplify([[0, 0]], 1)).toEqual([[0, 0]])
  })

  it('tolerance decreases with zoom', () => {
    expect(toleranceForZoom(0)).toBe(1.0)
    expect(toleranceForZoom(1)).toBe(0.5)
    expect(toleranceForZoom(10)).toBeCloseTo(1 / 1024)
  })
})

describe('Vector Tiler', () => {
  const simpleGeoJSON: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
        },
        properties: { name: 'square' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
        },
        properties: { name: 'square2' },
      },
    ],
  }

  it('creates a tile set with overview levels', () => {
    const tileSet = compileGeoJSONToTiles(simpleGeoJSON, { minZoom: 0, maxZoom: 4 })

    expect(tileSet.featureCount).toBe(2)
    expect(tileSet.levels.length).toBeGreaterThan(0)
    expect(tileSet.bounds[0]).toBeCloseTo(0) // minLon
    expect(tileSet.bounds[2]).toBeCloseTo(30) // maxLon
  })

  it('has sparse tiles (only where data exists)', () => {
    const tileSet = compileGeoJSONToTiles(simpleGeoJSON, { minZoom: 0, maxZoom: 3 })

    // At zoom 0, there should be 1 tile (covers whole world)
    const level0 = tileSet.levels.find(l => l.zoom === 0)
    expect(level0).toBeDefined()
    expect(level0!.tiles.size).toBe(1) // both features in one tile

    // At higher zooms, tiles should be sparse
    for (const level of tileSet.levels) {
      for (const [, tile] of level.tiles) {
        // Every tile should have actual data
        expect(tile.vertices.length + tile.lineVertices.length).toBeGreaterThan(0)
      }
    }
  })

  it('produces GPU-ready vertex format (stride 3)', () => {
    const tileSet = compileGeoJSONToTiles(simpleGeoJSON, { minZoom: 0, maxZoom: 0 })
    const level0 = tileSet.levels[0]
    const tile = [...level0.tiles.values()][0]

    // Vertices should be stride 3: [lon, lat, feat_id, ...]
    expect(tile.vertices.length % 3).toBe(0)
    // Indices should reference valid vertices
    for (let i = 0; i < tile.indices.length; i++) {
      expect(tile.indices[i]).toBeLessThan(tile.vertices.length / 3)
    }
  })

  it('simplifies geometry at lower zoom levels', () => {
    // A detailed polygon
    const detailed: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [Array.from({ length: 50 }, (_, i) => {
            const a = (i / 50) * Math.PI * 2
            return [10 + Math.cos(a) * 5, 10 + Math.sin(a) * 5]
          })],
        },
        properties: {},
      }],
    }

    const tileSet = compileGeoJSONToTiles(detailed, { minZoom: 0, maxZoom: 8 })
    const level0Tile = [...tileSet.levels[0].tiles.values()][0]
    const highZoomLevel = tileSet.levels[tileSet.levels.length - 1]

    // Find a tile at the highest zoom that contains data
    const highTiles = [...highZoomLevel.tiles.values()]
    if (highTiles.length > 0) {
      // Higher zoom should have more vertices (less simplified)
      const totalHighVerts = highTiles.reduce((sum, t) => sum + t.vertices.length, 0)
      // Low zoom tile should have fewer vertices
      expect(level0Tile.vertices.length).toBeLessThanOrEqual(totalHighVerts)
    }
  })
})
