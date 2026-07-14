import { describe, expect, it } from 'vitest'
import type { RingPolygon } from '@xgis/compiler'
import { clipRingPolygonToWindow } from './clip-ring-polygon'

// Focused unit tests for the RingPolygon window clip (the polygon half of the
// over-zoom sub-tile clip, #1082). Coordinate-space-agnostic — a unit square
// window [0,0,10,10] with plain integer rings. The helper wraps the canonical
// Sutherland-Hodgman rect clip; these tests pin the RingPolygon-level
// semantics it adds (drop-outside / keep-inside / clip-straddler + hole
// handling + featId preservation).

const W = 0,
  S = 0,
  E = 10,
  N = 10

/** Axis-aligned square ring (closed), CCW. */
function square(x0: number, y0: number, x1: number, y1: number): number[][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ]
}

function within(ring: number[][], eps = 1e-9): boolean {
  return ring.every(([x, y]) => x >= W - eps && x <= E + eps && y >= S - eps && y <= N + eps)
}

describe('clipRingPolygonToWindow', () => {
  it('keeps a fully-inside polygon unchanged (same reference, no copy)', () => {
    const poly: RingPolygon = { rings: [square(2, 2, 8, 8)], featId: 1 }
    const out = clipRingPolygonToWindow(poly, W, S, E, N)
    expect(out).toBe(poly) // exact vertices preserved via reference return
  })

  it('drops a fully-outside polygon (null)', () => {
    const poly: RingPolygon = { rings: [square(20, 20, 30, 30)], featId: 2 }
    expect(clipRingPolygonToWindow(poly, W, S, E, N)).toBeNull()
  })

  it('clips a straddler to the window, preserving featId', () => {
    const poly: RingPolygon = { rings: [square(5, 2, 15, 8)], featId: 3 } // crosses east edge
    const out = clipRingPolygonToWindow(poly, W, S, E, N)
    expect(out).not.toBeNull()
    expect(out).not.toBe(poly) // fresh, clipped
    expect(out!.featId).toBe(3)
    expect(within(out!.rings[0]), 'all outer vertices inside window').toBe(true)
    const maxX = Math.max(...out!.rings[0].map((p) => p[0]))
    expect(maxX).toBeLessThanOrEqual(E + 1e-9) // clamped at the east edge
  })

  it('keeps a polygon-with-hole unchanged when both rings are inside', () => {
    const poly: RingPolygon = { rings: [square(1, 1, 9, 9), square(3, 3, 7, 7)], featId: 4 }
    const out = clipRingPolygonToWindow(poly, W, S, E, N)
    expect(out).toBe(poly) // fully inside → reference return, hole intact
  })

  it('clips outer to the window and preserves an interior hole', () => {
    // Outer covers the whole window and overhangs all four edges; hole sits
    // fully inside.
    const poly: RingPolygon = { rings: [square(-5, -5, 15, 15), square(3, 3, 7, 7)], featId: 5 }
    const out = clipRingPolygonToWindow(poly, W, S, E, N)
    expect(out).not.toBeNull()
    expect(out!.rings.length, 'outer + hole survive').toBe(2)
    expect(within(out!.rings[0]), 'clipped outer within window').toBe(true)
    expect(within(out!.rings[1]), 'interior hole within window').toBe(true)
  })

  it('drops a hole that lies in the clipped-away region while the outer survives', () => {
    // Outer straddles the east edge; hole sits entirely east of the window
    // (in the part the clip removes), so the hole must be dropped.
    const poly: RingPolygon = { rings: [square(5, 2, 15, 8), square(12, 3, 14, 5)], featId: 6 }
    const out = clipRingPolygonToWindow(poly, W, S, E, N)
    expect(out).not.toBeNull()
    expect(out!.rings.length, 'only the outer survives').toBe(1)
    expect(within(out!.rings[0])).toBe(true)
  })

  it('drops a polygon whose outer ring is degenerate (<3 vertices)', () => {
    const poly: RingPolygon = {
      rings: [
        [
          [1, 1],
          [2, 2],
        ],
      ],
      featId: 7,
    }
    expect(clipRingPolygonToWindow(poly, W, S, E, N)).toBeNull()
  })

  it('drops a polygon with no rings', () => {
    const poly: RingPolygon = { rings: [], featId: 8 }
    expect(clipRingPolygonToWindow(poly, W, S, E, N)).toBeNull()
  })
})
