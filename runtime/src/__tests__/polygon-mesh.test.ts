// Unit tests for polygon-mesh utilities (3D extrusion side walls).
//
// quantizePolygonVertices is exercised at multiple zooms + the
// is_top flag bit. generateWallMesh covers single edges, closed
// rings, multi-ring polygons, and the index-buffer correctness
// (so callers can concat onto the existing top-face buffer
// without index collisions).

import { describe, expect, it } from 'vitest'
import { generateWallMesh, quantizePolygonVertices } from '../engine/polygon-mesh'

const TILE_EXTENT_M = (z: number) => (2 * Math.PI * 6378137) / Math.pow(2, z)

describe('quantizePolygonVertices', () => {
  it('packs DSFUN stride-5 → quantized stride-8', () => {
    // 2 vertices: (0, 0) and (extent, extent), feat_ids 1 and 2
    const ext = TILE_EXTENT_M(10)
    const dsfun = new Float32Array([
      0, 0, 0, 0, 1,
      ext, ext, 0, 0, 2,
    ])
    const buf = quantizePolygonVertices(dsfun, ext)
    expect(buf.byteLength).toBe(2 * 8)
    const u16 = new Uint16Array(buf)
    const f32 = new Float32Array(buf)
    expect(u16[0]).toBe(0)              // mx[0] = 0 quanta
    expect(u16[1]).toBe(0)              // my[0] = 0 quanta
    expect(f32[1]).toBe(1)              // fid[0]
    expect(u16[4] & 0x7FFF).toBe(32767) // mx[1] = max 15-bit
    expect(u16[5]).toBe(32767)          // my[1] = max
    expect(f32[3]).toBe(2)              // fid[1]
  })

  it('encodes is_top flag in bit 15 of x', () => {
    const ext = TILE_EXTENT_M(10)
    const dsfun = new Float32Array([ext / 2, ext / 2, 0, 0, 1])
    const flat = quantizePolygonVertices(dsfun, ext, { isTop: false })
    const top = quantizePolygonVertices(dsfun, ext, { isTop: true })
    const flatX = new Uint16Array(flat)[0]
    const topX = new Uint16Array(top)[0]
    expect(flatX & 0x8000).toBe(0)        // flat: bit 15 clear
    expect(topX & 0x8000).toBe(0x8000)    // top: bit 15 set
    expect(flatX & 0x7FFF).toBe(topX & 0x7FFF) // same position
  })

  it('roundtrip precision is sub-mm at zoom 22', () => {
    const z = 22
    const ext = TILE_EXTENT_M(z)
    const points: number[] = []
    const N = 50
    for (let i = 0; i < N; i++) {
      points.push(Math.random() * ext, Math.random() * ext, 0, 0, i)
    }
    const buf = quantizePolygonVertices(new Float32Array(points), ext)
    const u16 = new Uint16Array(buf)
    const tolMeters = ext / POS_RANGE * 0.5
    for (let i = 0; i < N; i++) {
      const mxQ = u16[i * 4] & 0x7FFF
      const myQ = u16[i * 4 + 1]
      const dequantX = mxQ / POS_RANGE * ext
      const dequantY = myQ / POS_RANGE * ext
      expect(Math.abs(dequantX - points[i * 5])).toBeLessThan(tolMeters)
      expect(Math.abs(dequantY - points[i * 5 + 1])).toBeLessThan(tolMeters)
    }
    expect(tolMeters).toBeLessThan(0.0002)
  })
})

const POS_RANGE = 32767

describe('generateWallMesh', () => {
  it('emits 4 vertices + 6 indices per ring edge', () => {
    const ext = TILE_EXTENT_M(10)
    // Single triangle ring: 3 vertices, closed ring (last == first)
    // 3 edges
    const polys = [{
      rings: [[[0, 0], [ext / 2, 0], [0, ext / 2], [0, 0]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    expect(mesh.vertices.byteLength).toBe(3 * 4 * 8)  // 3 edges × 4 verts × 8 bytes
    expect(mesh.indices.length).toBe(3 * 6)            // 3 edges × 6 indices
  })

  it('handles unclosed rings (no duplicated last vertex)', () => {
    const ext = TILE_EXTENT_M(10)
    // 3 vertices, NOT closed — generates 3 edges (2 + wrap)
    const polys = [{
      rings: [[[0, 0], [ext / 2, 0], [0, ext / 2]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    expect(mesh.vertices.byteLength).toBe(3 * 4 * 8)
    expect(mesh.indices.length).toBe(3 * 6)
  })

  it('first wall vertex pair has is_top=0, last pair has is_top=1', () => {
    const ext = TILE_EXTENT_M(10)
    const polys = [{
      rings: [[[0, 0], [ext / 2, 0], [0, ext / 2]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    const u16 = new Uint16Array(mesh.vertices)
    // First wall: vertices 0..3 in order (a_bot, b_bot, a_top, b_top)
    expect(u16[0 * 4] & 0x8000).toBe(0)        // a_bot: is_top=0
    expect(u16[1 * 4] & 0x8000).toBe(0)        // b_bot: is_top=0
    expect(u16[2 * 4] & 0x8000).toBe(0x8000)   // a_top: is_top=1
    expect(u16[3 * 4] & 0x8000).toBe(0x8000)   // b_top: is_top=1
  })

  it('indices form valid triangles (every index < vertex count)', () => {
    const ext = TILE_EXTENT_M(10)
    const polys = [{
      rings: [[[0, 0], [ext, 0], [ext, ext], [0, ext], [0, 0]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    const vertCount = mesh.vertices.byteLength / 8
    for (const idx of mesh.indices) {
      expect(idx).toBeLessThan(vertCount)
    }
  })

  it('handles multi-ring polygons (e.g. polygon with hole)', () => {
    const ext = TILE_EXTENT_M(10)
    const polys = [{
      rings: [
        [[0, 0], [ext, 0], [ext, ext], [0, ext], [0, 0]],          // outer 4 edges
        [[ext / 4, ext / 4], [ext * 3 / 4, ext / 4], [ext * 3 / 4, ext * 3 / 4], [ext / 4, ext * 3 / 4], [ext / 4, ext / 4]], // inner 4 edges
      ],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    expect(mesh.vertices.byteLength).toBe(8 * 4 * 8)  // 8 edges × 4 verts × 8 bytes
    expect(mesh.indices.length).toBe(8 * 6)
  })

  it('skips degenerate rings (< 2 vertices)', () => {
    const ext = TILE_EXTENT_M(10)
    const polys = [{
      rings: [[], [[0, 0]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, 0, 0)
    expect(mesh.vertices.byteLength).toBe(0)
    expect(mesh.indices.length).toBe(0)
  })

  it('encodes positions relative to tile origin', () => {
    const ext = TILE_EXTENT_M(10)
    const tileMx = 1_000_000
    const tileMy = 2_000_000
    // Point at the tile origin
    const polys = [{
      rings: [[[tileMx, tileMy], [tileMx + ext, tileMy], [tileMx, tileMy + ext]]],
      featId: 1,
    }]
    const mesh = generateWallMesh(polys, ext, tileMx, tileMy)
    const u16 = new Uint16Array(mesh.vertices)
    // First wall: edge (origin, +x) — a_bot at (0, 0)
    expect(u16[0] & 0x7FFF).toBe(0)
    expect(u16[1]).toBe(0)
    // a_top at (0, 0) with bit 15 set
    expect(u16[2 * 4] & 0x7FFF).toBe(0)
    expect(u16[2 * 4] & 0x8000).toBe(0x8000)
  })
})
