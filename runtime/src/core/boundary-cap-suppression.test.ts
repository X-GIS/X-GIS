// Verify buildLineSegments suppresses caps at tile-boundary endpoints
// EVEN when the input vertex carries an explicit tout / tin marker
// from augmentChainWithArc (polygon outline arcs).
//
// Before the fix: `!isRealEndpointA` guard blocked boundary-cap
// suppression for any chain whose start vertex had tout != 0,
// causing visible cap-stacks along tile-rect edges wherever many
// polygons clipped at the same longitude (countries_boundary on
// demotiles Russia z=2.40).

import { describe, it, expect } from 'vitest'
import { buildLineSegments } from './line-segment-build'

// Stride-10 vertex: [mx_h, my_h, mx_l, my_l, fid, arc, tin_x, tin_y, tout_x, tout_y]
function v10(
  mx: number, my: number, fid: number, arc: number,
  tinX: number, tinY: number, toutX: number, toutY: number,
): number[] {
  const mxH = Math.fround(mx), mxL = Math.fround(mx - mxH)
  const myH = Math.fround(my), myL = Math.fround(my - myH)
  return [mxH, myH, mxL, myL, fid, arc, tinX, tinY, toutX, toutY]
}

describe('buildLineSegments — tile-boundary cap suppression', () => {
  const TILE_W = 5009377 // z=3 tile width in MM (~22.5°)
  const TILE_H = 5009377

  it('clipped polygon arc with tout!=0 at boundary start: NO cap (prev_tangent non-zero)', () => {
    // Three-vertex open arc: starts ON east boundary at (TILE_W, 100),
    // continues into tile interior, ends INSIDE.
    // augmentChainWithArc would emit:
    //   vertex 0: tin=(0,0), tout=(1,0) → "real endpoint marker"
    //   vertex 1: tin=tout=(1,0) (interior)
    //   vertex 2: tin=(1,0), tout=(0,0) → "real endpoint marker"
    // The pre-fix `!isRealEndpointA` guard prevents boundary-cap
    // suppression at vertex 0 even though it IS on the boundary.
    const verts = new Float32Array([
      ...v10(TILE_W, 100, 0, 0, 0, 0, 1, 0),      // boundary start (tout marker)
      ...v10(TILE_W - 100, 100, 0, 100, 1, 0, 1, 0),  // interior
      ...v10(TILE_W - 200, 100, 0, 200, 1, 0, 0, 0),  // chain end (tin marker)
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segs = buildLineSegments(verts, indices, 10, TILE_W, TILE_H)
    // Segment 0 (vertex 0 → 1): vertex 0 is the boundary endpoint.
    // prev_tangent should be NON-ZERO (in-line direction, suppressing cap).
    const seg0_prevTx = segs[0 * 20 + 8]
    const seg0_prevTy = segs[0 * 20 + 9]
    const prevLen = Math.hypot(seg0_prevTx, seg0_prevTy)
    expect(prevLen).toBeGreaterThan(0.5)  // shader: has_prev = length > 0.5

    // Sanity: vertex 1 (interior) is NOT on the boundary, segment 0's
    // next_tangent comes from adjacency to segment 1 → also non-zero.
    const seg0_nextTx = segs[0 * 20 + 10]
    const seg0_nextTy = segs[0 * 20 + 11]
    expect(Math.hypot(seg0_nextTx, seg0_nextTy)).toBeGreaterThan(0.5)
  })

  it('chain end on opposite boundary: NO cap there either', () => {
    // Single segment that starts INSIDE and ends on the WEST boundary.
    //   v0 (interior, tin=0, tout=(-1,0))
    //   v1 (west boundary, tin=(-1,0), tout=0)
    const verts = new Float32Array([
      ...v10(100, 1000, 0, 0, 0, 0, -1, 0),
      ...v10(0, 1000, 0, 100, -1, 0, 0, 0),
    ])
    const indices = new Uint32Array([0, 1])

    const segs = buildLineSegments(verts, indices, 10, TILE_W, TILE_H)
    // Segment 0's next_tangent (for vertex 1 = west boundary).
    const nextTx = segs[0 * 20 + 10]
    const nextTy = segs[0 * 20 + 11]
    expect(Math.hypot(nextTx, nextTy)).toBeGreaterThan(0.5)
  })

  it('chain end NOT on boundary: cap IS drawn (tangent stays zero)', () => {
    // Interior chain end (NOT on tile boundary) — must keep zero tangent
    // so the renderer draws the cap.
    const verts = new Float32Array([
      ...v10(100, 1000, 0, 0, 0, 0, 1, 0),
      ...v10(200, 1000, 0, 100, 1, 0, 0, 0),  // interior end
    ])
    const indices = new Uint32Array([0, 1])

    const segs = buildLineSegments(verts, indices, 10, TILE_W, TILE_H)
    // Segment 0's next_tangent — vertex 1 is INSIDE, not on boundary,
    // and tout=0 → no adjacency neighbor → stays zero → cap drawn.
    const nextTx = segs[0 * 20 + 10]
    const nextTy = segs[0 * 20 + 11]
    expect(Math.hypot(nextTx, nextTy)).toBeLessThan(0.1)  // ≈ 0 → cap
  })
})
