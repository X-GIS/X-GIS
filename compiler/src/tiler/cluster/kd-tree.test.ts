// The k-d tree under the cluster hierarchy, checked against brute force (#2050).
//
// WHY THIS FILE EXISTS SEPARATELY: every other witness in this directory uses four points
// or fewer, and `sortKd` returns immediately below `NODE_SIZE` (64) — so the whole SPLIT
// path, the quickselect that places each median and the pruning that skips a half-space,
// would ship completely unexercised. Its failure mode is not a crash: it is SILENTLY
// LOSING a point, which reads downstream as "that cluster is one short" and would be
// chased in the wrong file. A brute-force oracle over the same inputs is the only cheap
// check that distinguishes "the tree answered" from "the tree answered correctly".

import { describe, expect, it } from 'vitest'
import { ClusterKdTree } from './kd-tree'

/** Deterministic LCG — a fixed corpus, so a failure is reproducible from the seed alone. */
function coords(n: number, seed: number, spread: number) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const x = new Int32Array(n)
  const y = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = Math.round((rnd() - 0.5) * spread)
    y[i] = Math.round((rnd() - 0.5) * spread)
  }
  return { x, y }
}

const sortNum = (a: number[]) => [...a].sort((p, q) => p - q)

function bruteRange(
  x: Int32Array,
  y: Int32Array,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
) {
  const out: number[] = []
  for (let i = 0; i < x.length; i++) {
    if (x[i] >= minX && x[i] <= maxX && y[i] >= minY && y[i] <= maxY) out.push(i)
  }
  return out
}

function bruteWithin(x: Int32Array, y: Int32Array, qx: number, qy: number, r: number) {
  const out: number[] = []
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - qx
    const dy = y[i] - qy
    if (dx * dx + dy * dy <= r * r) out.push(i)
  }
  return out
}

describe('ClusterKdTree: range() matches brute force above the leaf threshold', () => {
  // 500 > NODE_SIZE, so the build really splits and the queries really prune.
  const { x, y } = coords(500, 7, 2_000_000)
  const tree = new ClusterKdTree(x, y, 500)

  it.each([
    [-1_000_000, -1_000_000, 1_000_000, 1_000_000], // everything
    [0, 0, 400_000, 400_000], // a quadrant
    [-50_000, 900_000, 50_000, 1_100_000], // a sliver that prunes hard
    [5_000_000, 5_000_000, 6_000_000, 6_000_000], // empty
  ])('box (%s, %s)-(%s, %s)', (minX, minY, maxX, maxY) => {
    expect(sortNum(tree.range(minX, minY, maxX, maxY))).toEqual(
      bruteRange(x, y, minX, minY, maxX, maxY),
    )
  })

  it('finds a hand-planted point that sits exactly on a split value', () => {
    // The pruning comparisons are `<=` / `>=` on purpose: a strict `<` drops every point
    // whose coordinate equals the splitter, and with quantized coordinates that is not a
    // rare case.
    const px = new Int32Array(200).fill(1234)
    const py = new Int32Array(200)
    for (let i = 0; i < 200; i++) py[i] = i
    const t = new ClusterKdTree(px, py, 200)
    expect(sortNum(t.range(1234, 0, 1234, 199))).toEqual(bruteRange(px, py, 1234, 0, 1234, 199))
    expect(t.range(1234, 0, 1234, 199)).toHaveLength(200)
  })
})

describe('ClusterKdTree: within() matches brute force above the leaf threshold', () => {
  const { x, y } = coords(500, 11, 2_000_000)
  const tree = new ClusterKdTree(x, y, 500)

  it.each([
    [0, 0, 100_000],
    [0, 0, 3_000_000],
    [750_000, -600_000, 250_000],
    [5_000_000, 5_000_000, 10],
  ])('circle at (%s, %s) r=%s', (qx, qy, r) => {
    expect(sortNum(tree.within(qx, qy, r))).toEqual(bruteWithin(x, y, qx, qy, r))
  })

  it('is closed — a point exactly r away is INSIDE', () => {
    const px = Int32Array.from([0, 100, -100, 0])
    const py = Int32Array.from([0, 0, 0, 100])
    const t = new ClusterKdTree(px, py, 4)
    expect(sortNum(t.within(0, 0, 100))).toEqual([0, 1, 2, 3])
    expect(sortNum(t.within(0, 0, 99))).toEqual([0])
  })
})

describe('ClusterKdTree: heavy duplicates are the realistic degenerate input', () => {
  it('answers correctly when most coordinates are identical', () => {
    // A hundred features geocoded to one city centroid. A two-way partition would be
    // O(n²) here; correctness has to hold either way, so this asserts the ANSWER and the
    // three-way partition earns its keep on the clock, not on this assertion.
    const n = 400
    const x = new Int32Array(n)
    const y = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      x[i] = i % 4 === 0 ? i : 500
      y[i] = i % 3 === 0 ? i : -500
    }
    const tree = new ClusterKdTree(x, y, n)
    expect(sortNum(tree.range(-1000, -1000, 1000, 1000))).toEqual(
      bruteRange(x, y, -1000, -1000, 1000, 1000),
    )
    expect(sortNum(tree.within(500, -500, 0))).toEqual(bruteWithin(x, y, 500, -500, 0))
  })

  it('an empty tree answers empty rather than throwing', () => {
    const tree = new ClusterKdTree(new Int32Array(0), new Int32Array(0), 0)
    expect(tree.range(-1e9, -1e9, 1e9, 1e9)).toEqual([])
    expect(tree.within(0, 0, 1e9)).toEqual([])
  })
})
