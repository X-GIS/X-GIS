// iter-293 — fuzz probe for tileKey ↔ tileKeyUnpack bijection +
// tileKeyParent invariant. User: "bugs definitely remain, just edge
// cases not found." Property-based stress with random + boundary
// inputs to surface mismatches the hand-picked unit tests miss.

import { describe, it, expect } from 'vitest'
import { tileKey, tileKeyUnpack, tileKeyParent, tileKeyChildren } from './vector-tiler'

const MAX_Z = 22

/** Deterministic pseudo-random — seeded so failures repro. xorshift32 */
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

describe('iter-293 tileKey bijection — randomized fuzz', () => {
  it('every (z, x, y) in [0..22, 0..2^z, 0..2^z] round-trips', () => {
    const rng = makeRng(0xc001)
    for (let trial = 0; trial < 5000; trial++) {
      const z = Math.floor(rng() * (MAX_Z + 1))
      const n = Math.pow(2, z)
      const x = Math.floor(rng() * n)
      const y = Math.floor(rng() * n)
      const key = tileKey(z, x, y)
      const [zU, xU, yU] = tileKeyUnpack(key)
      expect([zU, xU, yU]).toEqual([z, x, y])
    }
  })

  it('boundary corners round-trip at every z', () => {
    for (let z = 0; z <= MAX_Z; z++) {
      const n = Math.pow(2, z)
      const cornerCoords: [number, number][] = [
        [0, 0],
        [n - 1, 0],
        [0, n - 1],
        [n - 1, n - 1],
      ]
      for (const [x, y] of cornerCoords) {
        const k = tileKey(z, x, y)
        const [zU, xU, yU] = tileKeyUnpack(k)
        expect([zU, xU, yU]).toEqual([z, x, y])
      }
    }
  })

  it('tileKeyParent equals tileKeyUnpack of parent (z-1)', () => {
    const rng = makeRng(0xbeef)
    for (let trial = 0; trial < 2000; trial++) {
      const z = 1 + Math.floor(rng() * MAX_Z) // z>=1
      const n = Math.pow(2, z)
      const x = Math.floor(rng() * n)
      const y = Math.floor(rng() * n)
      const k = tileKey(z, x, y)
      const parentKey = tileKeyParent(k)
      const expectedParent = tileKey(z - 1, x >> 1, y >> 1)
      expect(parentKey).toBe(expectedParent)
    }
  })

  it('tileKeyChildren(k) all unpack to (z+1, 2x..2x+1, 2y..2y+1)', () => {
    const rng = makeRng(0xdead)
    for (let trial = 0; trial < 1000; trial++) {
      const z = Math.floor(rng() * MAX_Z) // z<MAX so z+1 valid
      const n = Math.pow(2, z)
      const x = Math.floor(rng() * n)
      const y = Math.floor(rng() * n)
      const k = tileKey(z, x, y)
      const children = tileKeyChildren(k)
      expect(children.length).toBe(4)
      const wanted = new Set([
        tileKey(z + 1, 2 * x, 2 * y),
        tileKey(z + 1, 2 * x + 1, 2 * y),
        tileKey(z + 1, 2 * x, 2 * y + 1),
        tileKey(z + 1, 2 * x + 1, 2 * y + 1),
      ])
      for (const c of children) expect(wanted.has(c)).toBe(true)
    }
  })

  it('tileKey(0, 0, 0) === 1 (the documented root)', () => {
    expect(tileKey(0, 0, 0)).toBe(1)
  })

  it('parent of root is 0 (no further parent)', () => {
    expect(tileKeyParent(1)).toBe(0)
  })

  it('z=22 max corner is representable in JS number safely (Math.floor still bijective)', () => {
    const z = 22
    const n = Math.pow(2, z) // 4,194,304
    const corners: [number, number][] = [
      [0, 0],
      [n - 1, 0],
      [0, n - 1],
      [n - 1, n - 1],
    ]
    for (const [x, y] of corners) {
      const k = tileKey(z, x, y)
      // 4^22 = 1.7e13 + morton(22,22) — well under 2^53
      expect(Number.isSafeInteger(k)).toBe(true)
      const [zU, xU, yU] = tileKeyUnpack(k)
      expect([zU, xU, yU]).toEqual([z, x, y])
    }
  })

  // Same-input determinism — a key emitted twice for the same (z, x, y)
  // MUST equal itself. Catches inadvertent randomness / floating-point
  // accidents in the morton path.
  it('tileKey is deterministic — same input twice = same output', () => {
    const rng = makeRng(0xabc1)
    for (let trial = 0; trial < 500; trial++) {
      const z = Math.floor(rng() * (MAX_Z + 1))
      const n = Math.pow(2, z)
      const x = Math.floor(rng() * n)
      const y = Math.floor(rng() * n)
      expect(tileKey(z, x, y)).toBe(tileKey(z, x, y))
    }
  })
})
