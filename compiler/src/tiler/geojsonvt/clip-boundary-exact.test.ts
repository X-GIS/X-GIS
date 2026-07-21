// #1228 — boundary-exact entering-intersect parity with upstream geojson-vt.
//
// Upstream clip.js (4.0.3, node_modules/geojson-vt/src/clip.js:117-128) uses
// INCLUSIVE comparisons on the entering branches:
//
//   if (a < k1)      { if (b >= k1) intersect(..., k1) }
//   else if (a > k2) { if (b <= k2) intersect(..., k2) }
//
// The port used strict `b > k1` / `b < k2`, so a segment whose entering
// endpoint lands EXACTLY on the clip boundary (b === k1 or b === k2) took the
// opposite branch: upstream emits the boundary intersection vertex (z=1, the
// t=1 degenerate intersect) FOLLOWED by the vertex itself on the next
// iteration; the strict port silently dropped the intersection vertex.
// Boundary-exact vertices are a real input class — tile-aligned grid lines,
// axis-aligned fixtures, boundary-snapped output of an earlier clip stage.
//
// These witnesses pin the upstream slice structure BY VALUE (the package's
// `exports` field blocks importing src/clip.js directly, so the expected
// arrays are derived from the upstream source cited above).

import { describe, it, expect } from 'vitest'
import { clip } from './clip'
import { createFeature } from './feature'
import type { FlatLine } from './types'

const line = (coords: [number, number][]): FlatLine => {
  const flat: number[] = []
  for (const [x, y] of coords) flat.push(x, y, 0)
  return flat as FlatLine
}

const lineFeature = (coords: [number, number][]) =>
  createFeature(null, 'LineString' as const, line(coords), null)

const clipOne = (coords: [number, number][], k1: number, k2: number): number[] => {
  const f = lineFeature(coords)
  const out = clip([f], 1, k1, k2, 0, f.minX, f.maxX)
  expect(out).toBeTruthy()
  expect(out!.length).toBe(1)
  // Spread strips FlatLine's own size/start/end props so the assertions
  // compare pure vertex data.
  return [...(out![0]!.geometry as FlatLine)]
}

describe('clipLine boundary-exact entering intersect (#1228, upstream parity)', () => {
  it('segment entering EXACTLY at k1 emits the boundary intersect vertex (b >= k1)', () => {
    // a=0.1 < k1, b === k1: upstream's inclusive branch fires the t=1
    // degenerate intersect (z=1) at the boundary, then the next iteration
    // adds the vertex itself — a duplicated boundary vertex by design.
    const g = clipOne(
      [
        [0.1, 0],
        [0.25, 0.1],
        [0.5, 0.2],
      ],
      0.25,
      0.75,
    )
    expect(g).toEqual([0.25, 0.1, 1, 0.25, 0.1, 0, 0.5, 0.2, 0])
  })

  it('segment entering EXACTLY at k2 emits the boundary intersect vertex (b <= k2)', () => {
    // Mirror case from the right: a=0.9 > k2, b === k2.
    const g = clipOne(
      [
        [0.9, 0],
        [0.75, 0.1],
        [0.5, 0.2],
      ],
      0.25,
      0.75,
    )
    expect(g).toEqual([0.75, 0.1, 1, 0.75, 0.1, 0, 0.5, 0.2, 0])
  })

  it('strictly-inside entering endpoint is unchanged (no spurious intersect)', () => {
    // b clearly inside the range — both upstream and the port emit one real
    // intersection at k1 (t < 1) then the interior vertices.
    const g = clipOne(
      [
        [0.1, 0],
        [0.3, 0.1],
        [0.5, 0.2],
      ],
      0.25,
      0.75,
    )
    // intersect at x=0.25: t=(0.25-0.1)/(0.3-0.1)=0.75 → y=ay+(by-ay)·t,
    // spelled with the exact intersectX float expression (a 0.075 literal
    // differs in the last ulp), z=1.
    const t = (0.25 - 0.1) / (0.3 - 0.1)
    expect(g).toEqual([0.25, 0 + (0.1 - 0) * t, 1, 0.3, 0.1, 0, 0.5, 0.2, 0])
  })
})
