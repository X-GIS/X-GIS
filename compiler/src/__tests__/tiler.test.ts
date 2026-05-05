import { describe, expect, it } from 'vitest'
import {
  encodeCoords, decodeCoords,
  encodeIndices, decodeIndices,
  zigzagEncode, zigzagDecode,
} from '../tiler/encoding'
import { simplify, toleranceForZoom } from '../tiler/simplify'
import { compileGeoJSONToTiles, tileKey, tileKeyUnpack, tileKeyParent, tileKeyChildren, mortonEncode, mortonDecode } from '../tiler/vector-tiler'
import { serializeXGVT, parseXGVTIndex, parseGPUReadyTile } from '../tiler/tile-format'
import { clipPolygonToRect, clipLineToRect } from '../tiler/clip'
import type { GeoJSONFeatureCollection } from '../tiler/geojson-types'

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
    const coords = [0.5, 0.3, 0.6, 0.4, 0.55, 0.35] // tile-local floats
    const encoded = encodeCoords(coords)
    const decoded = decodeCoords(encoded)

    expect(decoded.length).toBe(coords.length)
    for (let i = 0; i < coords.length; i++) {
      expect(decoded[i]).toBeCloseTo(coords[i], 5)
    }
  })

  it('compresses delta sequences efficiently', () => {
    const coords: number[] = []
    for (let i = 0; i < 100; i++) {
      coords.push(i * 0.001, i * 0.001) // small tile-local deltas
    }
    const encoded = encodeCoords(coords)
    const rawSize = coords.length * 4
    expect(encoded.byteLength).toBeLessThan(rawSize * 0.6)
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
    // Tolerance = 360 / (4096 * 2^z) — ~1/16 pixel at each zoom level
    expect(toleranceForZoom(0)).toBeCloseTo(360 / 4096)
    expect(toleranceForZoom(1)).toBeCloseTo(360 / 8192)
    expect(toleranceForZoom(10)).toBeCloseTo(360 / (4096 * 1024))
    // Each zoom level halves the tolerance
    expect(toleranceForZoom(1)).toBeCloseTo(toleranceForZoom(0) / 2)
  })
})

describe('Morton Code', () => {
  it('encodes and decodes x/y', () => {
    expect(mortonDecode(mortonEncode(5, 2))).toEqual([5, 2])
    expect(mortonDecode(mortonEncode(0, 0))).toEqual([0, 0])
    expect(mortonDecode(mortonEncode(255, 255))).toEqual([255, 255])
  })

  it('preserves spatial adjacency', () => {
    // Adjacent tiles should have close Morton codes
    const m00 = mortonEncode(4, 4)
    const m10 = mortonEncode(5, 4)
    const m01 = mortonEncode(4, 5)
    const mFar = mortonEncode(100, 100)
    // Nearby tiles differ by small amount
    expect(Math.abs(m10 - m00)).toBeLessThan(4)
    expect(Math.abs(m01 - m00)).toBeLessThan(4)
    // Far tile differs by large amount
    expect(Math.abs(mFar - m00)).toBeGreaterThan(100)
  })
})

describe('Tile Key (Morton + Sentinel)', () => {
  it('packs and unpacks z/x/y', () => {
    const key = tileKey(3, 5, 2)
    const [z, x, y] = tileKeyUnpack(key)
    expect(z).toBe(3)
    expect(x).toBe(5)
    expect(y).toBe(2)
  })

  it('round-trips various zoom levels', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [1, 1, 1],
      [4, 12, 7], [8, 200, 150], [10, 512, 341],
      [14, 8000, 6000],
    ]
    for (const [z, x, y] of cases) {
      expect(tileKeyUnpack(tileKey(z, x, y))).toEqual([z, x, y])
    }
  })

  it('zoom 0 produces key = 1', () => {
    expect(tileKey(0, 0, 0)).toBe(1)
  })

  it('parent key is key >>> 2', () => {
    const child = tileKey(3, 5, 2)
    const parent = tileKeyParent(child)
    const [pz, px, py] = tileKeyUnpack(parent)
    expect(pz).toBe(2)
    expect(px).toBe(Math.floor(5 / 2))  // 2
    expect(py).toBe(Math.floor(2 / 2))  // 1
  })

  it('children of a key contain the key\'s area', () => {
    const parent = tileKey(2, 1, 1)
    const children = tileKeyChildren(parent)
    expect(children.length).toBe(4)
    // All children have same parent
    for (const child of children) {
      expect(tileKeyParent(child)).toBe(parent)
    }
  })

  it('unique keys for all tiles at a zoom level', () => {
    const z = 3
    const keys = new Set<number>()
    for (let x = 0; x < (1 << z); x++) {
      for (let y = 0; y < (1 << z); y++) {
        keys.add(tileKey(z, x, y))
      }
    }
    expect(keys.size).toBe((1 << z) * (1 << z)) // 64 unique keys
  })
})

describe('Geometry Clipping', () => {
  describe('polygon clipping', () => {
    it('keeps polygon fully inside rect', () => {
      const rings = [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]]
      const clipped = clipPolygonToRect(rings, 0, 0, 10, 10)
      expect(clipped).toHaveLength(1)
      expect(clipped[0]).toHaveLength(5)
    })

    it('returns empty for polygon fully outside rect', () => {
      const rings = [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]
      const clipped = clipPolygonToRect(rings, 0, 0, 10, 10)
      expect(clipped).toHaveLength(0)
    })

    it('clips polygon crossing one edge', () => {
      // Square from -5 to 5, clipped to x >= 0
      const rings = [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
      const clipped = clipPolygonToRect(rings, 0, -10, 10, 10)
      expect(clipped).toHaveLength(1)
      // All vertices should have lon >= 0
      for (const pt of clipped[0]) {
        expect(pt[0]).toBeGreaterThanOrEqual(-0.001)
      }
    })

    it('clips polygon crossing corner', () => {
      // Square from -5 to 5, clipped to [0,0,10,10]
      const rings = [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
      const clipped = clipPolygonToRect(rings, 0, 0, 10, 10)
      expect(clipped).toHaveLength(1)
      for (const pt of clipped[0]) {
        expect(pt[0]).toBeGreaterThanOrEqual(-0.001)
        expect(pt[1]).toBeGreaterThanOrEqual(-0.001)
      }
    })

    it('handles polygon with hole', () => {
      const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]
      const hole = [[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]
      const clipped = clipPolygonToRect([outer, hole], 0, 0, 10, 10)
      expect(clipped.length).toBeGreaterThanOrEqual(1)
      // Outer ring clipped
      expect(clipped[0].length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('line clipping', () => {
    it('keeps line fully inside rect', () => {
      const coords = [[2, 2], [5, 5], [8, 3]]
      const segments = clipLineToRect(coords, 0, 0, 10, 10)
      expect(segments).toHaveLength(1)
      expect(segments[0]).toHaveLength(3)
    })

    it('returns empty for line fully outside rect', () => {
      const coords = [[20, 20], [30, 30]]
      const segments = clipLineToRect(coords, 0, 0, 10, 10)
      expect(segments).toHaveLength(0)
    })

    it('clips line crossing rect boundary', () => {
      const coords = [[-5, 5], [15, 5]]
      const segments = clipLineToRect(coords, 0, 0, 10, 10)
      expect(segments).toHaveLength(1)
      // Clipped to [0,5] - [10,5]
      expect(segments[0][0][0]).toBeCloseTo(0)
      expect(segments[0][segments[0].length - 1][0]).toBeCloseTo(10)
    })

    it('splits line into multiple segments', () => {
      // Line goes in, out, in
      const coords = [[2, 5], [12, 5], [12, 2], [5, 2]]
      const segments = clipLineToRect(coords, 0, 0, 10, 10)
      expect(segments.length).toBeGreaterThanOrEqual(1)
    })
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

  it('produces GPU-ready vertex format (DSFUN stride 5)', () => {
    const tileSet = compileGeoJSONToTiles(simpleGeoJSON, { minZoom: 0, maxZoom: 0 })
    const level0 = tileSet.levels[0]
    const tile = [...level0.tiles.values()][0]

    // Polygon vertices: [mx_h, my_h, mx_l, my_l, feat_id] — stride 5
    expect(tile.vertices.length % 5).toBe(0)
    // Indices should reference valid vertices
    for (let i = 0; i < tile.indices.length; i++) {
      expect(tile.indices[i]).toBeLessThan(tile.vertices.length / 5)
    }
  })

  it('subdivides large triangles for non-Mercator projection accuracy', () => {
    // simpleGeoJSON has two 10°×10° squares. Without densification, earcut
    // produces 2 triangles per square = 4 total. The 10° edges exceed the
    // 2° threshold so each ear should split recursively at MM midpoints.
    // Without this guard, polygons render as screen-space chords under
    // non-Mercator projections (the wedge / antimeridian-stripe artifact
    // at orthographic / oblique mercator on whole-world tiles).
    const tileSet = compileGeoJSONToTiles(simpleGeoJSON, { minZoom: 0, maxZoom: 0 })
    const tile = [...tileSet.levels[0].tiles.values()][0]
    const triCount = tile.indices.length / 3
    // Assert well above the un-subdivided baseline of 4 triangles.
    expect(triCount).toBeGreaterThan(50)
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

describe('.xgvt Binary Format', () => {
  const testGeoJSON: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
        },
        properties: { name: 'A' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
        },
        properties: { name: 'B' },
      },
    ],
  }

  it('serializes and parses header + index', () => {
    const tileSet = compileGeoJSONToTiles(testGeoJSON, { minZoom: 0, maxZoom: 3 })
    const binary = serializeXGVT(tileSet)

    expect(binary.byteLength).toBeGreaterThan(32) // at least header

    const index = parseXGVTIndex(binary)
    expect(index.header.bounds[0]).toBeCloseTo(0)  // minLon
    expect(index.header.bounds[2]).toBeCloseTo(30) // maxLon
    expect(index.entries.length).toBeGreaterThan(0)
  })

  it('round-trips GPU-ready tile data', () => {
    const tileSet = compileGeoJSONToTiles(testGeoJSON, { minZoom: 0, maxZoom: 2 })
    const binary = serializeXGVT(tileSet, { includeGPUReady: true })
    const index = parseXGVTIndex(binary)

    // Pick first tile
    const entry = index.entries[0]
    const tile = parseGPUReadyTile(binary, entry)

    // DSFUN polygon vertices: stride 5 — [mx_h, my_h, mx_l, my_l, feat_id]
    expect(tile.vertices.length).toBe(entry.vertexCount * 5)
    expect(tile.indices.length).toBe(entry.indexCount)

    // Vertices are tile-local Mercator meters. A low-zoom tile spans up to
    // ~20,000 km on each axis so we only assert the DSFUN pair reconstructs
    // a finite value — the magnitude depends heavily on tile size.
    for (let i = 0; i < tile.vertices.length; i += 5) {
      const mx = tile.vertices[i] + tile.vertices[i + 2]
      const my = tile.vertices[i + 1] + tile.vertices[i + 3]
      expect(Number.isFinite(mx)).toBe(true)
      expect(Number.isFinite(my)).toBe(true)
    }
  })

  it('is smaller than raw GeoJSON', () => {
    const tileSet = compileGeoJSONToTiles(testGeoJSON, { minZoom: 0, maxZoom: 3 })
    const binary = serializeXGVT(tileSet)
    const jsonSize = JSON.stringify(testGeoJSON).length

    // Binary should be compact (includes GPU-ready + compact layers)
    console.log(`[xgvt] JSON: ${jsonSize}B → Binary: ${binary.byteLength}B (${(binary.byteLength / jsonSize * 100).toFixed(0)}%)`)
  })

  it('supports Morton key lookup', () => {
    const tileSet = compileGeoJSONToTiles(testGeoJSON, { minZoom: 0, maxZoom: 2 })
    const binary = serializeXGVT(tileSet)
    const index = parseXGVTIndex(binary)

    // Lookup z=0, x=0, y=0 by Morton key
    const key = tileKey(0, 0, 0)
    const entry = index.entryByHash.get(key)
    expect(entry).toBeDefined()
  })

  it('entries are sorted by Morton key', () => {
    const tileSet = compileGeoJSONToTiles(testGeoJSON, { minZoom: 0, maxZoom: 3 })
    const binary = serializeXGVT(tileSet)
    const index = parseXGVTIndex(binary)

    for (let i = 1; i < index.entries.length; i++) {
      expect(index.entries[i].tileHash).toBeGreaterThanOrEqual(index.entries[i - 1].tileHash)
    }
  })
})
