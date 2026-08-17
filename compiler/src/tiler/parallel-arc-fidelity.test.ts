// ═══ #1522 — a parallel must reach the GPU as a smooth arc ═══
//
// Symptom: under orthographic, the Tropic of Cancer in the `long_chords`
// fixture (four parallels carrying one vertex per 30° of longitude — the shape
// the MapLibre demotiles `geolines` layer has) drew with a sharp corner. A line
// of constant latitude projects to a smooth arc there, so any corner is wrong.
//
// It took TWO stages to produce, which is why every single-variable experiment
// on the issue came back "no effect", and why both are gated here:
//
//   1. DENSIFY (geometry-sphere.ts). Interpolating along the great circle put
//      the inserted vertices POLEWARD of the parallel, meeting the authored
//      vertices at a corner. Fixed by interpolating in the authored lon/lat
//      space — the coordinates are the source of truth.
//   2. SIMPLIFY (simplify.ts). Once the vertices are back ON the parallel they
//      are exactly collinear in Mercator, where Douglas-Peucker measured its
//      tolerance — so it deleted every one of them and left the chord. Fixed by
//      also measuring the deviation on the sphere.
//
// Stage 1 alone is WORSE than shipping neither, which is why it does not ship
// alone: on the fixture below, the old pipeline kept all 46 of its (misplaced)
// vertices — the poleward bulge is what made them non-collinear enough in
// Mercator to survive — while stage 1 without stage 2 collapses 49 vertices to
// 2. A faceted polyline becomes one 90°-wide chord. Neither test below is
// meaningful without the other.
//
// Pure math over the real functions in the real order — no GPU, no fixture
// files, no camera.

import { describe, expect, it } from 'vitest'
import { EARTH, mercatorToECEFSphere } from '@xgis/shared'
import { subdivideLine } from './geometry-sphere'
import { augmentLineWithArc } from './vector-tiler'
import { simplifyLine, simplifyLineSphere, mercatorToleranceForZoom } from './simplify'

/** Worst gap, in unit-sphere radii, between a polyline of Mercator-metre
 *  vertices and the parallel it is meant to trace.
 *
 *  Every vertex of a parallel shares one z, so the true mid-arc point of a
 *  segment is its horizontal midpoint pushed back out to the parallel's radius
 *  — and the gap is exactly the segment's sagitta, `r·(1 − cos(Δlon/2))`.
 *  Stronger than the turn-angle bound the issue asks for: it measures distance
 *  from the TRUE curve, not merely the drawn polyline's own smoothness. */
const maxSagitta = (mmCoords: number[][]): number => {
  const unit = mmCoords.map((c) => {
    const e = mercatorToECEFSphere(c[0], c[1], 0, EARTH)
    return [e[0] / EARTH.sphereR, e[1] / EARTH.sphereR, e[2] / EARTH.sphereR]
  })
  let worst = 0
  for (let i = 0; i < unit.length - 1; i++) {
    const a = unit[i],
      b = unit[i + 1]
    const r = Math.hypot(a[0], a[1])
    const mid = Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    worst = Math.max(worst, r - mid)
  }
  return worst
}

describe('#1522 parallel arc fidelity', () => {
  it('densifies a parallel without leaving it', () => {
    // Great-circle interpolation between (0, 60) and (90, 60) peaks at 67.79°N
    // mid-span — 7.79° off the parallel, closed-form, and the reason a coarsely
    // authored parallel used to meet its authored vertices at a corner.
    const out = subdivideLine([
      [0, 60],
      [90, 60],
    ])
    // Non-vacuity: the span must actually have been split. 46 sub-segments —
    // the parallel is 90·cos(60) = 45° long, which governs here over the 41.4°
    // great circle between the same two points.
    expect(out.length, 'densification did not fire').toBeGreaterThan(40)
    for (const [, lat] of out) expect(lat).toBeCloseTo(60, 12)
  })

  it('crosses the antimeridian the short way under both authoring conventions', () => {
    // (a) Continued past the seam — MapLibre's world-copy convention, which the
    //     #1221 gate depends on. Longitudes must stay on the input's own branch.
    const past = subdivideLine([
      [170, 0],
      [190, 0],
    ])
    expect(past.length, 'densification did not fire').toBeGreaterThan(10)
    for (const [lon] of past) {
      expect(lon, `lon ${lon} left the authored 170..190 branch`).toBeGreaterThanOrEqual(170)
      expect(lon, `lon ${lon} left the authored 170..190 branch`).toBeLessThanOrEqual(190)
    }

    // (b) The SAME 20° span authored as the folded pair. A naive lon lerp of the
    //     raw −340° delta would walk every MIDPOINT the long way round; the delta
    //     is unwrapped to +20 instead, so no vertex ever reaches the far side of
    //     the globe — which is exactly (and only) what the per-vertex check below
    //     proves. The raw endpoint keeps its authored −170 (same output as the old
    //     great-circle interpolant), so the last adjacent-pair lon delta is still
    //     ~359° in raw coords; the antimeridian SPLIT downstream owns that seam
    //     (wrap-line-antimeridian.test.ts), not this assertion.
    const folded = subdivideLine([
      [170, 0],
      [-170, 0],
    ])
    expect(folded.length, 'densification did not fire').toBeGreaterThan(10)
    for (const [lon] of folded) {
      expect(Math.abs(lon), `lon ${lon} walked the long way round`).toBeGreaterThan(90)
    }
  })

  it('keeps the curvature-carrying vertices through simplification', () => {
    // The whole path on the reported shape: a parallel authored at 30° spacing,
    // densified, projected to Mercator metres, then Douglas-Peucker'd at a z1
    // tolerance — exactly what `tileLinePart` does.
    const mm = augmentLineWithArc(
      subdivideLine([
        [0, 60],
        [30, 60],
        [60, 60],
        [90, 60],
      ]),
    )
    const tolerance = mercatorToleranceForZoom(1)

    // FAIL-BEFORE, asserted rather than described (§12: an assertion carries
    // information only if it distinguishes the states of the thing it tests).
    // A parallel IS a straight line in Mercator, so the planar-only simplifier
    // finds every densified vertex collinear and discards all of them. What
    // reaches the GPU is the bare 90°-wide chord — the reported sharp V.
    const planar = simplifyLine(mm, 1, undefined, tolerance)
    expect(planar).toHaveLength(2)
    expect(maxSagitta(planar)).toBeGreaterThan(0.1)

    // Measuring the same deviation on the sphere keeps them.
    const kept = simplifyLineSphere(mm, tolerance)
    expect(kept.length, 'sphere metric retained no interior vertex').toBeGreaterThan(10)
    // Still ON the parallel after simplification (the premise `maxSagitta`
    // measures against): every survivor holds sin(60°) as its ECEF z.
    for (const c of kept) {
      const e = mercatorToECEFSphere(c[0], c[1], 0, EARTH)
      expect(e[2] / EARTH.sphereR).toBeCloseTo(Math.sin((60 * Math.PI) / 180), 9)
    }
    // 49 densified vertices in, 33 kept, worst sagitta 2.7e-4 radii — against
    // 0.146 for the chord above. Nearly three orders of magnitude apart, so the
    // bound is not a tuned number that pins today's output.
    expect(maxSagitta(kept)).toBeLessThan(1e-3)
  })
})
