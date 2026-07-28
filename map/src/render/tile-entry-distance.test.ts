// The phase origin for INC-1: where a line-label polyline enters its own tile.
// MVT geometry carries a buffer, so vertex 0 is outside the tile bounds and the
// overhang is exactly the phase error against MapLibre (see the module header).

import { describe, it, expect } from 'vitest'
import { tileEntryDistance } from './tile-entry-distance'

const RECT = [0, 0, 100, 100] as const
const entry = (xs: number[], ys: number[]) =>
  tileEntryDistance(xs, ys, xs.length, RECT[0], RECT[1], RECT[2], RECT[3])

describe('tileEntryDistance', () => {
  it('is 0 when the polyline already starts inside the tile', () => {
    expect(entry([10, 50, 90], [50, 50, 50])).toBe(0)
  })

  it('measures the buffer overhang when the polyline starts outside', () => {
    // Enters at x=0 after 20 units of buffer.
    expect(entry([-20, 80], [50, 50])).toBeCloseTo(20, 6)
  })

  it('measures along the PATH, not the straight-line distance', () => {
    // A dog-leg in the buffer: (-30,-30) → (-30,40) is 70 units, then the second
    // segment crosses x=0 after another 30 — 100 units of path, against a
    // straight-line start-to-crossing distance of only ~76.
    expect(entry([-30, -30, 40], [-30, 40, 40])).toBeCloseTo(100, 6)
  })

  it('enters on whichever edge the line actually crosses', () => {
    // From the south: crosses y=0.
    expect(entry([50, 50], [-15, 60])).toBeCloseTo(15, 6)
    // From the north.
    expect(entry([50, 50], [140, 40])).toBeCloseTo(40, 6)
    // From the east.
    expect(entry([160, 40], [50, 50])).toBeCloseTo(60, 6)
  })

  it('finds the crossing in a LATER segment, accumulating the earlier ones', () => {
    expect(entry([-50, -30, -10, 30], [50, 50, 50, 50])).toBeCloseTo(50, 6)
  })

  it('a vertex exactly on the boundary counts as inside', () => {
    expect(entry([0, 50], [50, 50])).toBe(0)
  })

  it('returns 0 for a polyline that never enters — total, not throwing', () => {
    // Caller then walks from vertex 0, i.e. the pre-INC-1 behaviour.
    expect(entry([-50, -40], [-50, -40])).toBe(0)
    expect(entry([200, 300], [200, 300])).toBe(0)
  })

  it('handles degenerate input', () => {
    expect(tileEntryDistance([], [], 0, 0, 0, 100, 100)).toBe(0)
    expect(tileEntryDistance([-5], [50], 1, 0, 0, 100, 100)).toBe(0)
  })

  it('a single segment spanning the whole tile still reports its entry', () => {
    // The endpoint-test version returned 0 here: neither vertex is inside, so the
    // buffer overhang vanished and the phase error came straight back.
    expect(entry([-20, 200], [50, 50])).toBeCloseTo(20, 6)
  })

  it('the measured OFM case: ~119 px of buffer at z16.7', () => {
    // Sketch of tile 14/13962/6331 at that zoom — ~3327 px wide, the line running
    // WSW→ENE from the west buffer and out through the east buffer in one span.
    const tile = 3327
    const overhang = 119.8
    expect(
      tileEntryDistance([-overhang, tile + overhang], [50, 50], 2, 0, 0, tile, tile),
    ).toBeCloseTo(overhang, 4)
  })
})
