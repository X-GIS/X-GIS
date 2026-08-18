// #1775 half 2 — identity pin for the preallocated-scratch rewrite of
// `simplifyLineSphere`. The production function now inlines
// `mercatorToECEFSphere`'s math directly into a module-level scratch
// Float64Array/Uint8Array reused ACROSS CALLS (grown, never shrunk), instead
// of allocating one `[x,y,z]` array per vertex plus one fresh Uint8Array /
// Float64Array per invocation (see simplify.ts).
//
// `simplifyLineSphereReference` below is an independent reimplementation of
// the PRE-#1775 algorithm — fresh buffers every call, and the REAL exported
// `mercatorToECEFSphere` (not the inlined copy) for the per-vertex
// projection. Diffing the two catches both a semantic slip in the DP walk
// AND a single-ULP drift in the inlined sphere math, since the reference
// exercises the canonical shared implementation independently.

import { describe, it, expect } from 'vitest'
import { EARTH, mercatorToECEFSphere } from '@xgis/shared'
import { simplifyLineSphere, mercatorToleranceForZoom } from './simplify'

// ── Reference (pre-#1775) implementation — verbatim, fresh-allocation ──

function dpStepRef(
  first: number,
  last: number,
  sqTolerance: number,
  keep: Uint8Array,
  sqDist: (i: number, lo: number, hi: number) => number,
): void {
  const stack: number[] = [first, last]
  while (stack.length > 0) {
    const hi = stack.pop()!
    const lo = stack.pop()!
    let maxDist = 0
    let maxIdx = lo
    let hasLocked = false
    for (let i = lo + 1; i < hi; i++) {
      if (keep[i]) {
        hasLocked = true
        if (i - lo > 1) stack.push(lo, i)
        if (hi - i > 1) stack.push(i, hi)
        break
      }
      const dist = sqDist(i, lo, hi)
      if (dist > maxDist) {
        maxDist = dist
        maxIdx = i
      }
    }
    if (hasLocked) continue
    if (maxDist > sqTolerance) {
      keep[maxIdx] = 1
      if (maxIdx - lo > 1) stack.push(lo, maxIdx)
      if (hi - maxIdx > 1) stack.push(maxIdx, hi)
    }
  }
}

function sqDistToSegmentRef(p: number[], a: number[], b: number[]): number {
  let x = a[0],
    y = a[1]
  let dx = b[0] - x,
    dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

function sqDistToSegment3Ref(pts: Float64Array, i: number, lo: number, hi: number): number {
  const ax = pts[lo * 3],
    ay = pts[lo * 3 + 1],
    az = pts[lo * 3 + 2]
  let x = ax,
    y = ay,
    z = az
  let dx = pts[hi * 3] - ax,
    dy = pts[hi * 3 + 1] - ay,
    dz = pts[hi * 3 + 2] - az
  if (dx !== 0 || dy !== 0 || dz !== 0) {
    const t =
      ((pts[i * 3] - x) * dx + (pts[i * 3 + 1] - y) * dy + (pts[i * 3 + 2] - z) * dz) /
      (dx * dx + dy * dy + dz * dz)
    if (t > 1) {
      x = pts[hi * 3]
      y = pts[hi * 3 + 1]
      z = pts[hi * 3 + 2]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
      z += dz * t
    }
  }
  dx = pts[i * 3] - x
  dy = pts[i * 3 + 1] - y
  dz = pts[i * 3 + 2] - z
  return dx * dx + dy * dy + dz * dz
}

function simplifyLineSphereReference(
  coords: number[][],
  tolerance: number,
  isLocked?: (coord: number[]) => boolean,
): number[][] {
  if (coords.length <= 2) return coords
  if (tolerance <= 0) return coords

  const sqTolerance = tolerance * tolerance
  const keep = new Uint8Array(coords.length)
  keep[0] = 1
  keep[coords.length - 1] = 1
  if (isLocked) {
    for (let i = 0; i < coords.length; i++) {
      if (isLocked(coords[i])) keep[i] = 1
    }
  }

  const ecef = new Float64Array(coords.length * 3)
  for (let i = 0; i < coords.length; i++) {
    const [x, y, z] = mercatorToECEFSphere(coords[i][0], coords[i][1], 0, EARTH)
    ecef[i * 3] = x
    ecef[i * 3 + 1] = y
    ecef[i * 3 + 2] = z
  }

  dpStepRef(0, coords.length - 1, sqTolerance, keep, (i, lo, hi) => {
    const planar = sqDistToSegmentRef(coords[i], coords[lo], coords[hi])
    return Math.max(planar, sqDistToSegment3Ref(ecef, i, lo, hi))
  })

  const result: number[][] = []
  for (let i = 0; i < coords.length; i++) {
    if (keep[i]) result.push(coords[i])
  }
  return result.length >= 2 ? result : coords
}

// ── Deterministic corpus generators ──

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

/** Random Mercator-meter coords within EARTH's world extent. */
function randomLineMM(rng: () => number, n: number): number[][] {
  const half = EARTH.worldMerc / 2
  const coords: number[][] = []
  for (let i = 0; i < n; i++) {
    coords.push([(rng() - 0.5) * 2 * half, (rng() - 0.5) * 2 * half])
  }
  return coords
}

/** A densified line of constant Mercator-y (constant latitude) — collinear
 *  in the render plane, curved on the sphere. This is the exact #1522
 *  motivating shape for the OR'd planar/sphere test. */
function parallelMM(n: number, my: number): number[][] {
  const half = EARTH.worldMerc / 2
  const coords: number[][] = []
  for (let i = 0; i < n; i++) {
    coords.push([-half + (i / (n - 1)) * half * 2, my])
  }
  return coords
}

/** A closed ring: random walk that returns to its start point. */
function closedRingMM(rng: () => number, n: number): number[][] {
  const coords: number[][] = [[0, 0]]
  let x = 0,
    y = 0
  for (let i = 1; i < n; i++) {
    x += (rng() - 0.5) * 200_000
    y += (rng() - 0.5) * 200_000
    coords.push([x, y])
  }
  coords.push([0, 0]) // close
  return coords
}

const TOL = mercatorToleranceForZoom(4)

function assertIdentical(
  coords: number[][],
  tolerance: number,
  isLocked?: (coord: number[]) => boolean,
  label = '',
): void {
  const scratch = simplifyLineSphere(coords, tolerance, isLocked)
  const reference = simplifyLineSphereReference(coords, tolerance, isLocked)
  expect(scratch, label).toEqual(reference)
}

describe('#1775 half 2 — simplifyLineSphere scratch-buffer output identity', () => {
  it('2-vertex line: both return input untouched', () => {
    assertIdentical(
      [
        [0, 0],
        [1_000_000, 500_000],
      ],
      TOL,
    )
  })

  it('3-vertex plane-collinear run collapses identically', () => {
    assertIdentical(
      [
        [0, 0],
        [500_000, 500_000],
        [1_000_000, 1_000_000],
      ],
      TOL,
    )
  })

  it('long Mercator-collinear parallel (curved on sphere): sphere metric retains vertices identically', () => {
    const line = parallelMM(400, 5_000_000)
    const scratch = simplifyLineSphere(line, TOL)
    const reference = simplifyLineSphereReference(line, TOL)
    expect(scratch).toEqual(reference)
    // Sanity: this is the #1522 shape — the sphere test must actually be
    // retaining interior vertices, not just trivially agreeing on a collapse.
    expect(scratch.length).toBeGreaterThan(2)
  })

  it('closed ring (first === last): output identical', () => {
    const rng = makeRng(0x1775)
    const ring = closedRingMM(rng, 250)
    assertIdentical(ring, TOL)
  })

  it('isLocked = always-true: both keep every vertex identically', () => {
    const rng = makeRng(0xaaaa)
    const line = randomLineMM(rng, 80)
    assertIdentical(line, TOL, () => true)
  })

  it('isLocked = always-false: behaves like no isLocked, identically', () => {
    const rng = makeRng(0xbbbb)
    const line = randomLineMM(rng, 80)
    assertIdentical(line, TOL, () => false)
  })

  it('isLocked on every 7th vertex: identical locked-run splitting', () => {
    const rng = makeRng(0xcccc)
    const line = randomLineMM(rng, 140)
    assertIdentical(line, TOL, (c) => Math.floor(c[0]) % 7 === 0)
  })

  it('tolerance = 0 / negative: both return input unchanged, identically', () => {
    const rng = makeRng(0xdddd)
    const line = randomLineMM(rng, 30)
    assertIdentical(line, 0)
    assertIdentical(line, -1)
  })

  it('randomized fuzz corpus: 300 trials, varying size/tolerance/lock, all identical', () => {
    const rng = makeRng(0x1775_02)
    for (let trial = 0; trial < 300; trial++) {
      const n = 3 + Math.floor(rng() * 400)
      const line = randomLineMM(rng, n)
      const tolerance = rng() * mercatorToleranceForZoom(Math.floor(rng() * 10))
      const lockEvery = 3 + Math.floor(rng() * 10)
      const isLocked = rng() < 0.5 ? (c: number[]) => Math.floor(c[1]) % lockEvery === 0 : undefined
      assertIdentical(line, tolerance, isLocked, `trial ${trial} (n=${n})`)
    }
  })

  it('large single call (10k vertices) matches reference', () => {
    const rng = makeRng(0x1775_03)
    const line = randomLineMM(rng, 10_000)
    assertIdentical(line, TOL)
  })

  it('scratch buffer reuse across shrinking/growing calls stays correct', () => {
    // Exercises the grow-not-shrink scratch buffer specifically: a large
    // call grows scratchKeep/scratchEcef, then smaller calls must see a
    // freshly-cleared `keep` window (not stale 1s from the larger call),
    // and a subsequent larger call must still grow correctly.
    const rng = makeRng(0x1775_04)
    const sizes = [2000, 5, 800, 3, 1500, 4, 1]
    for (const n of sizes) {
      const line = n === 1 ? [[0, 0]] : randomLineMM(rng, n)
      assertIdentical(line, TOL, undefined, `size ${n}`)
    }
  })
})
