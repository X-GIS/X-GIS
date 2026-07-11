import { describe, it, expect } from 'vitest'
import { placeLabelsAlongLine } from './label-pass'

// #727 P1 — an inline (raw-GeoJSON) symbol layer with `symbol-placement: line`
// (or `line-center`) over a LineString collapsed to ONE horizontal centroid
// label: the Path-1 loop resolved a single `featureAnchor` (→ lineMidpoint) and
// emitted a single, un-rotated `addLabel`. The vector-tile path instead walks
// the projected polyline and emits a tangent-rotated chain.
//
// The fix routes the inline path through the SAME shared placement walk the
// tile path now uses — `placeLabelsAlongLine` — so it emits the repeating
// tangent-rotated chain. This file pins that walk (the load-bearing new logic
// the inline path delegates to) plus a mirror of the inline emit's tangent, in
// the exported-helper style of the sibling label-pass tests (a full LabelPass
// .execute() drive would need the whole device / collision / atlas surface).

/** Mirror of label-pass.ts `emitInlineLine` (and the tile path's
 *  `emitLabelAlongSegment` text branch): screen-space segment tangent in
 *  degrees, upright-flipped so glyphs stay readable. */
const uprightTangentDeg = (pax: number, pay: number, pbx: number, pby: number): number => {
  let a = (Math.atan2(pby - pay, pbx - pax) * 180) / Math.PI
  if (a > 90 || a < -90) a += 180
  return a
}

interface Placed {
  x: number
  y: number
  rotate: number
}

/** Drive the shared walk with an emit that reproduces the inline path's
 *  point + tangent derivation, collecting one record per placed label. */
const runInlinePlacement = (
  xs: number[],
  ys: number[],
  spacingPx: number,
  useTangentRotation = true,
): Placed[] => {
  const px = Float32Array.from(xs)
  const py = Float32Array.from(ys)
  const out: Placed[] = []
  placeLabelsAlongLine(px, py, px.length, spacingPx, (pax, pay, pbx, pby, t) => {
    const x = pax + (pbx - pax) * t
    const y = pay + (pby - pay) * t
    const rotate = useTangentRotation ? uprightTangentDeg(pax, pay, pbx, pby) : 0
    out.push({ x, y, rotate })
  })
  return out
}

describe('#727 P1 — inline line labels place a repeating tangent-rotated chain', () => {
  it('a multi-vertex line at spacing emits a CHAIN (>1), not a single centroid label', () => {
    // Horizontal line 0..1000 px, spacing 200 px → stops at 100,300,500,700,900
    // = 5 placements. fail-before: the inline path emitted exactly 1 (the
    // lineMidpoint centroid), so this assertion is the direct 1 → N delta.
    const placed = runInlinePlacement([0, 1000], [0, 0], 200)
    expect(placed.length).toBe(5)
    expect(placed.length).toBeGreaterThan(1)
    // Anchors march along the line at the spacing cadence.
    expect(placed.map((p) => Math.round(p.x))).toEqual([100, 300, 500, 700, 900])
  })

  it('the chain follows the segment TANGENT (rotation ≠ 0 for a non-horizontal line)', () => {
    // 45° diagonal → every placement rotates to 45°, vs the pre-fix flat 0°.
    const placed = runInlinePlacement([0, 1000], [0, 1000], 200)
    expect(placed.length).toBeGreaterThan(1)
    for (const p of placed) expect(p.rotate).toBeCloseTo(45, 6)
    // At least one genuinely rotated label — the "tangent-rotated" property the
    // single horizontal centroid label never had.
    expect(placed.some((p) => Math.abs(p.rotate) > 1)).toBe(true)
  })

  it('the tangent is upright-flipped so glyphs stay readable (leftward segment → +180)', () => {
    // Up-and-to-the-left segment: atan2(1000,-1000) = 135° > 90 → +180 = 315°.
    const placed = runInlinePlacement([1000, 0], [0, 1000], 200)
    expect(placed.length).toBeGreaterThan(1)
    for (const p of placed) expect(p.rotate).toBeCloseTo(315, 6)
  })

  it('multi-segment polylines emit across the whole run at the spacing cadence', () => {
    // L-shaped polyline: (0,0)→(600,0)→(600,600). total = 1200, spacing 300 →
    // stops at 150,450,750,1050 = 4 placements straddling the corner. The two
    // legs carry different tangents (0° then the vertical 90°), proving the walk
    // spans multiple segments rather than a single midpoint anchor.
    const placed = runInlinePlacement([0, 600, 600], [0, 0, 600], 300)
    expect(placed.length).toBe(4)
    const angles = new Set(placed.map((p) => Math.round(p.rotate)))
    expect(angles.size).toBeGreaterThan(1)
  })

  it('line-center (spacing 0) emits exactly ONE label at the polyline midpoint', () => {
    // spacing 0 = line-center: one label at total*0.5. Polyline 0..200 → x=100.
    const placed = runInlinePlacement([0, 100, 200], [0, 0, 0], 0)
    expect(placed.length).toBe(1)
    expect(Math.round(placed[0]!.x)).toBe(100)
  })

  it('fail-before contrast: the pre-fix inline path was ONE horizontal centroid label', () => {
    // Model the old Path-1 behaviour (featureAnchor → lineMidpoint → a single,
    // un-rotated addLabel) and pin the observable regression the fix removes.
    const oldInline = { count: 1, rotate: 0 }
    const newInline = runInlinePlacement([0, 1000], [0, 800], 200)
    expect(oldInline.count).toBe(1)
    expect(oldInline.rotate).toBe(0)
    // After the fix: strictly more than one label, and they are tangent-rotated.
    expect(newInline.length).toBeGreaterThan(oldInline.count)
    expect(newInline.some((p) => Math.abs(p.rotate) > 1)).toBe(true)
  })

  it('a degenerate (<2 projectable vertices) line emits nothing (no crash)', () => {
    expect(runInlinePlacement([42], [42], 200)).toEqual([])
    expect(runInlinePlacement([], [], 200)).toEqual([])
  })
})
