// iter-314 — DSFUN (double-single float) precision fuzz. Render-
// critical: the GPU reconstructs each vertex's tile-local meters
// via (pos_h - cam_h) + (pos_l - cam_l). If splitF64 /
// packDSFUNPolygonVertices lose precision, vertices land at the
// WRONG screen position → visible geometry drift (esp. at deep
// zoom where tile-local meters are tiny vs absolute Mercator
// magnitude ~2e7).
//
// Tests the round-trip the SHADER performs: hi + lo must
// reconstruct the f64 tile-local value to f32-machine-epsilon ×
// magnitude — and crucially, the hi/lo SPLIT must cancel the
// absolute-Mercator magnitude so deep-zoom vertices keep sub-mm
// precision.

import { describe, it, expect } from 'vitest'
import {
  splitF64, packDSFUNPolygonVertices, packDSFUNLineVertices,
  lonLatToMercF64,
} from './vector-tiler'

function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5; s |= 0
    return ((s >>> 0) / 0x1_0000_0000)
  }
}

describe('iter-314 splitF64 round-trip', () => {
  it('hi + lo reconstructs the input to f64 precision (random)', () => {
    const rng = makeRng(0xd5f)
    for (let i = 0; i < 5000; i++) {
      // Mercator-meter magnitudes: ±2e7.
      const x = (rng() * 2 - 1) * 2e7
      const [h, l] = splitF64(x)
      // The shader does (h - camH) + (l - camL); the pure
      // reconstruction is h + l. Must equal x within f64 epsilon
      // at this magnitude.
      const recon = h + l
      expect(Math.abs(recon - x)).toBeLessThan(Math.abs(x) * 1e-9 + 1e-6)
    }
  })

  it('hi is a clean f32 (fround idempotent)', () => {
    const rng = makeRng(0xabc)
    for (let i = 0; i < 1000; i++) {
      const x = (rng() * 2 - 1) * 2e7
      const [h] = splitF64(x)
      expect(Math.fround(h)).toBe(h)  // already f32
    }
  })

  it('zero / tiny / huge magnitudes', () => {
    for (const x of [0, 1e-9, -1e-9, 1, -1, 2.00375e7, -2.00375e7]) {
      const [h, l] = splitF64(x)
      expect(Math.abs((h + l) - x)).toBeLessThan(Math.abs(x) * 1e-9 + 1e-9)
    }
  })

  it('NaN / Infinity in → hi/lo not silently 0 (documents behaviour)', () => {
    // splitF64 uses Math.fround — fround(NaN)=NaN, fround(Inf)=Inf.
    // Document the contract: non-finite propagates (caller must
    // pre-clamp, as the clip pipeline does).
    const [hN] = splitF64(NaN)
    expect(Number.isNaN(hN)).toBe(true)
    const [hI] = splitF64(Infinity)
    expect(hI).toBe(Infinity)
  })
})

describe('iter-314 packDSFUNPolygonVertices reconstruction', () => {
  it('deep-zoom vertex keeps sub-mm precision after tile-origin cancel', () => {
    // Seoul at z=18-ish: absolute Mercator ~1.4e7 m, tile origin
    // close by. The hi/lo split must cancel the 1.4e7 magnitude so
    // the ~few-hundred-meter tile-local value keeps mm precision.
    const [mx, my] = lonLatToMercF64(126.9779, 37.5665)
    // Tile origin a few hundred metres away.
    const tileMx = mx - 137.3
    const tileMy = my - 88.6
    const packed = packDSFUNPolygonVertices([mx, my, 0], tileMx, tileMy)
    // Shader reconstruction: (hi - 0) + (lo - 0) = hi + lo, then
    // that IS the tile-local value (cam at tile origin here).
    const localMxRecon = packed[0]! + packed[2]!
    const localMyRecon = packed[1]! + packed[3]!
    expect(Math.abs(localMxRecon - 137.3)).toBeLessThan(1e-3)  // sub-mm
    expect(Math.abs(localMyRecon - 88.6)).toBeLessThan(1e-3)
  })

  it('feat_id passes through unchanged', () => {
    const packed = packDSFUNPolygonVertices([1e7, 1e7, 42], 0, 0)
    expect(packed[4]).toBe(42)
  })

  it('100 random deep-zoom vertices keep ≤1mm reconstruction error', () => {
    const rng = makeRng(0x9e0)
    for (let i = 0; i < 100; i++) {
      const lon = (rng() * 360) - 180
      const lat = (rng() * 150) - 75
      const [mx, my] = lonLatToMercF64(lon, lat)
      const dx = (rng() * 2 - 1) * 500  // tile-local up to ±500 m
      const dy = (rng() * 2 - 1) * 500
      const tileMx = mx - dx
      const tileMy = my - dy
      const packed = packDSFUNPolygonVertices([mx, my, 0], tileMx, tileMy)
      const reconX = packed[0]! + packed[2]!
      const reconY = packed[1]! + packed[3]!
      expect(Math.abs(reconX - dx)).toBeLessThan(1e-3)
      expect(Math.abs(reconY - dy)).toBeLessThan(1e-3)
    }
  })

  it('reconstruction beats naive single-f32 at deep zoom (the WHOLE point)', () => {
    // Naive: store absolute MM as a single f32, subtract camera f32.
    // DSFUN: store hi/lo, subtract camera hi/lo. DSFUN must be
    // strictly more accurate for a large absolute magnitude + tiny
    // local delta.
    const [mx] = lonLatToMercF64(139.7, 35.6)  // Tokyo, abs ~1.5e7
    const tileMx = mx - 12.345  // 12.345 m tile-local
    // Naive f32:
    const naive = Math.fround(mx) - Math.fround(tileMx)
    const naiveErr = Math.abs(naive - 12.345)
    // DSFUN:
    const packed = packDSFUNPolygonVertices([mx, 0, 0], tileMx, 0)
    const dsfun = packed[0]! + packed[2]!
    const dsfunErr = Math.abs(dsfun - 12.345)
    expect(dsfunErr).toBeLessThanOrEqual(naiveErr)
    expect(dsfunErr).toBeLessThan(1e-3)  // sub-mm absolute
  })
})

describe('iter-314 packDSFUNLineVertices reconstruction', () => {
  it('line vertex hi/lo reconstructs tile-local meters', () => {
    const [mx, my] = lonLatToMercF64(2.3488, 48.8534)  // Paris
    const tileMx = mx - 250.0
    const tileMy = my - 175.0
    // stride-4 input: [mx, my, fid, arc_start]
    const packed = packDSFUNLineVertices([mx, my, 7, 0], tileMx, tileMy)
    // line stride-6: [mx_h, my_h, mx_l, my_l, fid, arc_start]
    const reconX = packed[0]! + packed[2]!
    const reconY = packed[1]! + packed[3]!
    expect(Math.abs(reconX - 250.0)).toBeLessThan(1e-3)
    expect(Math.abs(reconY - 175.0)).toBeLessThan(1e-3)
    expect(packed[4]).toBe(7)  // fid preserved
  })
})
