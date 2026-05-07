// Unit test for packQuantizedPolygonVertices — verifies the
// roundtrip Float64 → Int16 quantize → Float32 dequant preserves
// tile-local positions to within sub-mm at zoom 22 and within
// expected error envelope at coarser zooms.

import { describe, expect, it } from 'bun:test'
import {
  packQuantizedPolygonVertices,
  QUANT_POLY_STRIDE_BYTES,
  QUANT_POLY_RANGE,
} from '../tiler/vector-tiler'

const EARTH_R = 6378137
const TILE_EXTENT_AT_ZOOM = (z: number): number => (2 * Math.PI * EARTH_R) / Math.pow(2, z)

describe('packQuantizedPolygonVertices', () => {
  it('emits stride-8 ArrayBuffer (Int16x2 + Float32 fid)', () => {
    const tileExt = TILE_EXTENT_AT_ZOOM(10)
    const tileMx = 0
    const tileMy = 0
    // 3 vertices: corners + interior point
    const scratch = [
      0,         0,         42,
      tileExt,   0,         43,
      tileExt/2, tileExt/2, 44,
    ]
    const buf = packQuantizedPolygonVertices(scratch, tileMx, tileMy, tileExt)
    expect(buf.byteLength).toBe(3 * QUANT_POLY_STRIDE_BYTES)
    expect(buf.byteLength).toBe(24)

    // Read back
    const i16 = new Int16Array(buf)
    const f32 = new Float32Array(buf)
    // Vertex 0: localMx=0, localMy=0, fid=42
    expect(i16[0]).toBe(0)
    expect(i16[1]).toBe(0)
    expect(f32[1]).toBe(42)
    // Vertex 1: localMx=tileExt → mxQ = 65535 → stored as -1 (two's comp)
    expect(i16[4]).toBe(-1)
    expect(i16[5]).toBe(0)
    expect(f32[3]).toBe(43)
    // Vertex 2: ~midpoint → mxQ ≈ 32768 → stored as -32768 (two's comp)
    // (32768 > 32767 → falls to else branch: 32768 - 65536 = -32768)
    expect(i16[8]).toBeGreaterThanOrEqual(-32770)
    expect(i16[8]).toBeLessThanOrEqual(-32766)
    expect(f32[5]).toBe(44)
  })

  it('roundtrip precision sub-mm at zoom 22', () => {
    const z = 22
    const tileExt = TILE_EXTENT_AT_ZOOM(z)
    const tileMx = 0, tileMy = 0
    // Random points across the tile
    const scratch: number[] = []
    const N = 100
    for (let i = 0; i < N; i++) {
      scratch.push(Math.random() * tileExt, Math.random() * tileExt, i)
    }
    const buf = packQuantizedPolygonVertices(scratch, tileMx, tileMy, tileExt)
    const i16 = new Int16Array(buf)

    // Dequant and compare
    const tolMeters = tileExt / QUANT_POLY_RANGE * 0.5  // half-quantum
    for (let i = 0; i < N; i++) {
      const origMx = scratch[i * 3]
      const origMy = scratch[i * 3 + 1]
      // Read Int16 as unsigned 16-bit
      const mxRaw = i16[i * 4]
      const myRaw = i16[i * 4 + 1]
      const mxU = mxRaw < 0 ? mxRaw + 65536 : mxRaw
      const myU = myRaw < 0 ? myRaw + 65536 : myRaw
      const dequantMx = mxU / QUANT_POLY_RANGE * tileExt
      const dequantMy = myU / QUANT_POLY_RANGE * tileExt
      expect(Math.abs(dequantMx - origMx)).toBeLessThan(tolMeters)
      expect(Math.abs(dequantMy - origMy)).toBeLessThan(tolMeters)
    }
    // At z=22, half-quantum is tileExt/2 / 65535 ≈ 7.3e-5 m = 0.073 mm
    expect(tolMeters).toBeLessThan(0.0001)
  })

  it('handles tile-corner origin offset correctly', () => {
    const z = 10
    const tileExt = TILE_EXTENT_AT_ZOOM(z)
    const tileMx = 14_000_000  // ~Korea longitude in MM
    const tileMy = 4_500_000   // ~Korea latitude in MM
    const scratch = [
      tileMx,           tileMy,           1,
      tileMx + tileExt, tileMy + tileExt, 2,
    ]
    const buf = packQuantizedPolygonVertices(scratch, tileMx, tileMy, tileExt)
    const i16 = new Int16Array(buf)
    // First vertex at tile origin → (0, 0)
    expect(i16[0]).toBe(0)
    expect(i16[1]).toBe(0)
    // Second at far corner → (-1, -1) (65535 in two's-comp)
    expect(i16[4]).toBe(-1)
    expect(i16[5]).toBe(-1)
  })

  it('saturates out-of-range coords without crashing', () => {
    const tileExt = TILE_EXTENT_AT_ZOOM(10)
    const tileMx = 0, tileMy = 0
    // Out of range — clip pipeline shouldn't emit these but
    // saturation guards against bad input
    const scratch = [
      -100, -100, 1,           // negative → clamp to 0
      tileExt + 100, tileExt + 100, 2,  // > extent → clamp to 65535
    ]
    const buf = packQuantizedPolygonVertices(scratch, tileMx, tileMy, tileExt)
    const i16 = new Int16Array(buf)
    expect(i16[0]).toBe(0)
    expect(i16[1]).toBe(0)
    expect(i16[4]).toBe(-1) // 65535 as int16
    expect(i16[5]).toBe(-1)
  })
})
