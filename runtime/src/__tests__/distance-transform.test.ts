import { describe, it, expect } from 'vitest'
import { computeSDF, distanceTransform2D } from '../engine/text/sdf/distance-transform'

const INF = 1e20

/** Square root of (squared distance from each pixel to the closest
 *  zero in `field`), brute-force, for verification. */
function bruteForceDT(mask: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h)
  // Collect zero pixels
  const zeros: number[][] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 0) zeros.push([x, y])
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity
      for (const [zx, zy] of zeros) {
        const d = (x - zx!) ** 2 + (y - zy!) ** 2
        if (d < best) best = d
      }
      out[y * w + x] = best
    }
  }
  return out
}

function maskToField(mask: Uint8Array): Float64Array {
  const out = new Float64Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] === 0 ? 0 : INF
  return out
}

describe('distanceTransform2D', () => {
  it('identity: all zeros stays at zero distance', () => {
    const w = 4, h = 4
    const f = new Float64Array(w * h)  // all zero
    distanceTransform2D(f, w, h)
    for (let i = 0; i < f.length; i++) expect(f[i]).toBe(0)
  })

  it('single zero at center → ring of squared distances', () => {
    const w = 5, h = 5
    const mask = new Uint8Array(w * h).fill(255)
    mask[2 * w + 2] = 0
    const f = maskToField(mask)
    distanceTransform2D(f, w, h)
    // Corner (0,0) → distance² to (2,2) = 4 + 4 = 8
    expect(f[0]).toBe(8)
    // Edge (0,2) → distance² = 4
    expect(f[2 * w + 0]).toBe(4)
    // Adjacent (1,2) → distance² = 1
    expect(f[2 * w + 1]).toBe(1)
    // The zero itself
    expect(f[2 * w + 2]).toBe(0)
  })

  it('matches brute force on a random mask', () => {
    const w = 16, h = 12
    const mask = new Uint8Array(w * h)
    // Seed pseudo-randomly with a deterministic LCG so the test
    // doesn't flake.
    let s = 0xDEADBEEF
    for (let i = 0; i < mask.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0
      mask[i] = (s & 0xFF) < 64 ? 0 : 255
    }
    const expected = bruteForceDT(mask, w, h)
    const f = maskToField(mask)
    distanceTransform2D(f, w, h)
    for (let i = 0; i < f.length; i++) {
      expect(f[i]).toBeCloseTo(expected[i]!, 6)
    }
  })

  it('fully unset (all INF) leaves field unchanged', () => {
    const w = 5, h = 5
    const f = new Float64Array(w * h).fill(INF)
    distanceTransform2D(f, w, h)
    // No zero-set point — every cell should still be infinite.
    for (const v of f) expect(v).toBe(INF)
  })
})

describe('computeSDF', () => {
  it('all outside → all max-OUT byte', () => {
    const w = 8, h = 8
    const alpha = new Uint8Array(w * h)  // all zero (= outside)
    const sdf = computeSDF(alpha, w, h, 8)
    // No inside pixels means inside-distance is +∞ → signed
    // distance is `INF - 0 = INF` → byte clamps to 0
    // (since v = 192 - (INF/radius)*63 < 0 → clamped).
    expect(sdf[0]).toBe(0)
    expect(sdf[w * h - 1]).toBe(0)
  })

  it('all inside → all max-IN byte (255)', () => {
    const w = 8, h = 8
    const alpha = new Uint8Array(w * h).fill(255)
    const sdf = computeSDF(alpha, w, h, 8)
    expect(sdf[0]).toBe(255)
  })

  it('half-and-half edge maps to ~192 at the boundary', () => {
    const w = 8, h = 4
    const alpha = new Uint8Array(w * h)
    // Left half outside, right half inside
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        alpha[y * w + x] = x < 4 ? 0 : 255
      }
    }
    const sdf = computeSDF(alpha, w, h, 8)
    // Pixel at column 3 is just outside the boundary
    // (distance ≈ 1 px outside); column 4 is just inside (≈ 1 px in).
    // The edge sits between cols 3 and 4; both should be near 192
    // with tiny offset (1/8 * 63 ≈ 8 units).
    const v3 = sdf[1 * w + 3]!
    const v4 = sdf[1 * w + 4]!
    expect(Math.abs(v3 - 192)).toBeLessThan(15)
    expect(Math.abs(v4 - 192)).toBeLessThan(15)
    expect(v3).toBeLessThan(v4)  // outside < edge < inside in this packing
  })

  it('output dimensions match input', () => {
    const w = 13, h = 7
    const sdf = computeSDF(new Uint8Array(w * h), w, h, 4)
    expect(sdf.length).toBe(w * h)
  })
})
