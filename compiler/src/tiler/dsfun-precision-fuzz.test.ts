// iter-314 — DSFUN (double-single float) precision fuzz. Render-
// critical: the GPU reconstructs each vertex's tile-local meters
// via (pos_h - cam_h) + (pos_l - cam_l). If splitF64 /
// packDSFUNLineVertices lose precision, vertices land at the
// WRONG screen position → visible geometry drift (esp. at deep
// zoom where tile-local meters are tiny vs absolute Mercator
// magnitude ~2e7).
//
// Tests the round-trip the SHADER performs: hi + lo must
// reconstruct the f64 tile-local value to f32-machine-epsilon ×
// magnitude — and crucially, the hi/lo SPLIT must cancel the
// absolute-Mercator magnitude so deep-zoom vertices keep sub-mm
// precision.
//
// Phase 2 PR 2d.2 — packDSFUNPolygonVertices was deleted (final
// consumer migrated to packECEFPointFeatures); its tests in this
// file were removed along with the export. Polygon ECEF precision
// is covered by ecef-precision-fuzz.test.ts; point ECEF by
// ecef-point-precision-fuzz.test.ts.

import { describe, it, expect } from 'vitest'
import { splitF64, packDSFUNLineVertices, lonLatToMercF64 } from './ecef-packing'

function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 0x1_0000_0000
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
      expect(Math.fround(h)).toBe(h) // already f32
    }
  })

  it('zero / tiny / huge magnitudes', () => {
    for (const x of [0, 1e-9, -1e-9, 1, -1, 2.00375e7, -2.00375e7]) {
      const [h, l] = splitF64(x)
      expect(Math.abs(h + l - x)).toBeLessThan(Math.abs(x) * 1e-9 + 1e-9)
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

describe('iter-314 packDSFUNLineVertices reconstruction', () => {
  it('line vertex hi/lo reconstructs tile-local meters', () => {
    const [mx, my] = lonLatToMercF64(2.3488, 48.8534) // Paris
    const tileMx = mx - 250.0
    const tileMy = my - 175.0
    // stride-4 input: [mx, my, fid, arc_start]
    const packed = packDSFUNLineVertices([mx, my, 7, 0], tileMx, tileMy)
    // line stride-6: [mx_h, my_h, mx_l, my_l, fid, arc_start]
    const reconX = packed[0]! + packed[2]!
    const reconY = packed[1]! + packed[3]!
    expect(Math.abs(reconX - 250.0)).toBeLessThan(1e-3)
    expect(Math.abs(reconY - 175.0)).toBeLessThan(1e-3)
    expect(packed[4]).toBe(7) // fid preserved
  })
})
