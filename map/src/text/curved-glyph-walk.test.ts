// #2012 INC-4 — the curved label's LABEL-PLANE walk and its screen correspondence.
//
// Golden source is FIRST-PRINCIPLES geometry, not a snapshot: every polyline below
// is straight or piecewise straight with round vertices, so each expected glyph
// position is a hand-derived interpolation written out in the test that asserts it.
//
// The three things this file exists to catch, each severable on its own:
//
//   (1) THE INDEX CORRESPONDENCE (design §3.4(3)). The walk measures arc length on
//       the LABEL PLANE and must read each glyph's position off the LIVE twin at
//       the same (segment, fraction). Sever it — read `px/py` where `qx/qy` is
//       meant — and `walks the plane, places on the live screen` goes red naming
//       the correspondence; nothing about the basis is involved, and the
//       no-basis cases stay green.
//   (2) THE ROTATION SPACE. The renderer composes the basis onto the rotation, so
//       the drawn baseline is `B · R(θ)`; θ must therefore be the PLANE tangent,
//       whose basis image is the live tangent. Feeding the live tangent instead
//       (design §3.4(4) as literally written) draws the baseline along `B · t_live`
//       — measured below at 18.4° off the road on a 45° road at pitch 60.
//   (3) THE PRE-IMAGE. `glyphOffsets` must be the pre-image of the live position
//       under the basis, so the renderer's `pivot + B·(offset − pivot)` lands the
//       glyph back on the road exactly. Writing the live position there instead
//       applies the ground transform twice.
//
// Absent a basis every one of those collapses to the pre-INC-4 expression, which
// the last block pins against hand-derived values.

import { describe, it, expect } from 'vitest'
import { walkCurvedGlyphs, invertGroundBasis, type CurvedGlyphWalkInput } from './curved-glyph-walk'

const alloc = (len: number): Float32Array => new Float32Array(len)

/** Plane run: 5 samples, uniform 100 px apart, total 400. */
const PLANE_X = new Float32Array([0, 100, 200, 300, 400])
const FLAT_Y = new Float32Array([0, 0, 0, 0, 0])
/** Its live twin: the SAME five ground points, compressed toward the far end the
 *  way a road running away from a pitched camera is. Segment lengths 90 / 80 / 70
 *  / 60 — so uniform PLANE spacing must come out non-uniform on screen. */
const LIVE_X = new Float32Array([0, 90, 170, 240, 300])

/** 5 glyphs, 20 px advance each ⇒ totalAdvance 100; centred at 200 ⇒ startS 150,
 *  so the glyph cursors are 150, 170, 190, 210, 230 in PLANE arc length. */
function baseInput(over: Partial<CurvedGlyphWalkInput> = {}): CurvedGlyphWalkInput {
  return {
    px: PLANE_X,
    py: FLAT_Y,
    qx: PLANE_X,
    qy: FLAT_Y,
    n: 5,
    advances: new Float32Array([20, 20, 20, 20, 20]),
    glyphCount: 5,
    totalAdvancePx: 100,
    letterSpacingPx: 0,
    centerOffsetPx: 200,
    verticalOffsetPx: 0,
    keepUpright: false,
    maxAngleRad: Math.PI,
    alloc,
    cumLen: new Float32Array(16),
    ...over,
  }
}

function xs(offsets: Float32Array, count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(offsets[i * 2]!)
  return out
}
function ys(offsets: Float32Array, count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(offsets[i * 2 + 1]!)
  return out
}

/** The renderer's own transform (text-renderer.ts), so the round trip below is
 *  checked against what actually runs rather than against its restatement. */
function applyBasis(
  b: readonly [number, number, number, number],
  pvx: number,
  pvy: number,
  x: number,
  y: number,
): [number, number] {
  const dx = x - pvx
  const dy = y - pvy
  return [pvx + dx * b[0] + dy * b[2], pvy + dx * b[1] + dy * b[3]]
}

describe('curved glyph walk — the label-plane ↔ screen index correspondence', () => {
  it('walks the plane, places on the live screen', () => {
    const r = walkCurvedGlyphs(baseInput({ qx: LIVE_X, qy: FLAT_Y }))!
    expect(r).not.toBeNull()
    // Cursors 150/170/190/210/230 on the PLANE. 150 falls in segment 1
    // (plane 100→200, live 90→170) at t = 0.5 ⇒ 90 + 80·0.5 = 130. Likewise:
    //   170 → seg 1 t 0.7 ⇒ 90 + 80·0.7 = 146
    //   190 → seg 1 t 0.9 ⇒ 90 + 80·0.9 = 162
    //   210 → seg 2 t 0.1 ⇒ 170 + 70·0.1 = 177
    //   230 → seg 2 t 0.3 ⇒ 170 + 70·0.3 = 191
    expect(xs(r.glyphOffsets, 5)).toEqual([130, 146, 162, 177, 191])
  })

  it('spaces glyphs evenly on the GROUND, not on the screen — the point of the plane walk', () => {
    const r = walkCurvedGlyphs(baseInput({ qx: LIVE_X, qy: FLAT_Y }))!
    const gaps = xs(r.glyphOffsets, 5)
      .slice(1)
      .map((x, i) => x - xs(r.glyphOffsets, 5)[i]!)
    // Screen gaps shrink toward the far end (16, 16, 15, 14) while the plane
    // advance was a constant 20 — the foreshortening MapLibre renders and the
    // pre-INC-4 screen walk could not, because uniform screen spacing IS the bug.
    expect(gaps).toEqual([16, 16, 15, 14])
    expect(gaps[0]!).toBeGreaterThan(gaps[3]!)
    // The old behaviour, for contrast: walking the live run directly spaces them
    // evenly on the glass.
    const screenWalk = walkCurvedGlyphs(baseInput({ px: LIVE_X, qx: LIVE_X }))!
    const flatGaps = xs(screenWalk.glyphOffsets, 5)
      .slice(1)
      .map((x, i) => x - xs(screenWalk.glyphOffsets, 5)[i]!)
    expect(flatGaps).toEqual([20, 20, 20, 20])
  })

  it('reports the pivot as the LIVE point at centerOffsetPx', () => {
    // Only computed when a basis is in play (it is the renderer's pivot).
    const r = walkCurvedGlyphs(
      baseInput({ qx: LIVE_X, qy: FLAT_Y, basisInv: invertGroundBasis([1, 0, 0, 0.5]) }),
    )!
    // Plane 200 is exactly vertex 2 ⇒ live 170.
    expect(r.pivotX).toBe(170)
    expect(r.pivotY).toBe(0)
  })
})

describe('curved glyph walk — the pre-image, so the renderer lands the glyph on the road', () => {
  const BASIS = [1, 0, 0, 0.5] as const

  it('round-trips through the renderer transform to the EXACT correspondence position', () => {
    const inv = invertGroundBasis(BASIS)!
    const r = walkCurvedGlyphs(
      baseInput({ qx: LIVE_X, qy: FLAT_Y, verticalOffsetPx: 8, basisInv: inv }),
    )!
    const live = [130, 146, 162, 177, 191]
    for (let gi = 0; gi < 5; gi++) {
      const [rx, ry] = applyBasis(
        BASIS,
        r.pivotX,
        r.pivotY,
        r.glyphOffsets[gi * 2]!,
        r.glyphOffsets[gi * 2 + 1]!,
      )
      expect(rx).toBeCloseTo(live[gi]!, 9)
      // The perpendicular shift is taken in the PLANE and therefore comes out
      // ground-projected: 8 px in the map plane, 8·0.5 = 4 px on screen.
      expect(ry).toBeCloseTo(4, 9)
    }
  })

  it('writes the PRE-IMAGE, not the live position (the double-apply this prevents)', () => {
    // A basis that shrinks BOTH axes, so the pre-image is visible on x too.
    const shrink = [0.5, 0, 0, 0.5] as const
    const r = walkCurvedGlyphs(
      baseInput({
        qx: LIVE_X,
        qy: FLAT_Y,
        verticalOffsetPx: 8,
        basisInv: invertGroundBasis(shrink),
      }),
    )!
    // pivot 170; pre-image of live x is 170 + (x − 170)·2.
    expect(xs(r.glyphOffsets, 5)).toEqual([90, 122, 154, 184, 212])
    // Writing the LIVE positions there instead is what a naive wiring does, and
    // the renderer would then draw them at 170 + (x − 170)·0.5 — the ground
    // transform applied a second time, collapsing the label to half its length.
    const doubled = [130, 146, 162, 177, 191].map((x) => 170 + (x - 170) * 0.5)
    expect(doubled).toEqual([150, 158, 166, 173.5, 180.5])
    // The perpendicular stays a PLANE quantity (8), which is what makes it come
    // out ground-projected at 4 px once the renderer applies the basis.
    expect(ys(r.glyphOffsets, 5)).toEqual([8, 8, 8, 8, 8])
    for (let gi = 0; gi < 5; gi++) {
      const [rx, ry] = applyBasis(
        shrink,
        r.pivotX,
        r.pivotY,
        r.glyphOffsets[gi * 2]!,
        r.glyphOffsets[gi * 2 + 1]!,
      )
      expect(rx).toBeCloseTo([130, 146, 162, 177, 191][gi]!, 9)
      expect(ry).toBeCloseTo(4, 9)
    }
  })

  it('refuses to invert a singular basis, so a degenerate label billboards instead of NaN-ing', () => {
    expect(invertGroundBasis([1, 0, 0, 0])).toBeUndefined()
    expect(invertGroundBasis([1, 2, 2, 4])).toBeUndefined()
    expect(invertGroundBasis([Number.NaN, 0, 0, 1])).toBeUndefined()
    // Round-trip on a well-conditioned one, in the renderer's own layout.
    const inv = invertGroundBasis([2, 1, -1, 3])!
    const [x, y] = applyBasis([2, 1, -1, 3], 0, 0, ...applyBasis(inv, 0, 0, 7, -5))
    expect(x).toBeCloseTo(7, 9)
    expect(y).toBeCloseTo(-5, 9)
  })
})

describe('curved glyph walk — rotation is the PLANE tangent (design §3.4(4), amended)', () => {
  // A 45° road in the label plane, seen at pitch 60 with the north axis halved:
  // basis [1, 0, 0, 0.5] maps the plane direction (1,1)/√2 to (1, 0.5), i.e. 26.57°
  // on screen. Both polylines are supplied, so the test states the two spaces
  // rather than deriving one from the other.
  const planeX = new Float32Array([0, 100, 200])
  const planeY = new Float32Array([0, 100, 200])
  const liveX = new Float32Array([0, 100, 200])
  const liveY = new Float32Array([0, 50, 100])
  const BASIS = [1, 0, 0, 0.5] as const

  it('emits the plane tangent, whose BASIS IMAGE is the road as it appears on screen', () => {
    const r = walkCurvedGlyphs(
      baseInput({
        px: planeX,
        py: planeY,
        qx: liveX,
        qy: liveY,
        n: 3,
        centerOffsetPx: 141.4213562373095,
        basisInv: invertGroundBasis(BASIS),
      }),
    )!
    const theta = r.glyphRotations[0]!
    expect((theta * 180) / Math.PI).toBeCloseTo(45, 4)
    // The drawn baseline: B · (cos θ, sin θ).
    const [bx, by] = applyBasis(BASIS, 0, 0, Math.cos(theta), Math.sin(theta))
    const drawnDeg = (Math.atan2(by, bx) * 180) / Math.PI
    const liveRoadDeg = (Math.atan2(100 - 0, 200 - 0) * 180) / Math.PI
    expect(liveRoadDeg).toBeCloseTo(26.565, 3)
    expect(drawnDeg).toBeCloseTo(liveRoadDeg, 4)
  })

  it('the LIVE tangent would put the baseline 18.4° off the road once the basis lands', () => {
    // The measurement behind the deviation from §3.4(4) as literally written.
    const liveTheta = Math.atan2(100 - 0, 200 - 0) // 26.565°
    const [bx, by] = applyBasis(BASIS, 0, 0, Math.cos(liveTheta), Math.sin(liveTheta))
    const drawnDeg = (Math.atan2(by, bx) * 180) / Math.PI
    expect(drawnDeg).toBeCloseTo(14.036, 3)
    expect(Math.abs(drawnDeg - 26.565)).toBeGreaterThan(12)
  })
})

describe('curved glyph walk — keep-upright is a SCREEN question (design NEEDS-PROBE 6)', () => {
  // Plane run travels +x (never upside down in the plane); its live twin travels
  // −x (a basis that flips screen-x, e.g. a bearing past 90° combined with pitch).
  // "Would this read upside down" is about the glass, so the decision must follow
  // the live tangent and reverse the walk.
  const planeX = new Float32Array([0, 200, 400])
  const liveX = new Float32Array([400, 200, 0])

  it('reverses on the LIVE tangent even though the plane tangent points right', () => {
    const fwd = walkCurvedGlyphs(baseInput({ px: planeX, qx: planeX, n: 3, keepUpright: true }))!
    // Same-space control: nothing to flip.
    expect(fwd.glyphRotations[0]!).toBeCloseTo(0, 6)
    const r = walkCurvedGlyphs(baseInput({ px: planeX, qx: liveX, n: 3, keepUpright: true }))!
    // walkReversed ⇒ every glyph rotates by +π and the run is walked from the end.
    expect(Math.abs(r.glyphRotations[0]!)).toBeCloseTo(Math.PI, 6)
  })

  it('leaves a same-space run byte-identical to the historical decision', () => {
    // Live twin === walk polyline: the mid tangent is the same float either way,
    // so no decision changes on any pre-INC-4 label.
    const a = walkCurvedGlyphs(baseInput({ keepUpright: true }))!
    const b = walkCurvedGlyphs(baseInput({ keepUpright: true, qx: PLANE_X, qy: FLAT_Y }))!
    expect(Array.from(a.glyphOffsets)).toEqual(Array.from(b.glyphOffsets))
    expect(Array.from(a.glyphRotations)).toEqual(Array.from(b.glyphRotations))
  })
})

describe('curved glyph walk — the pre-INC-4 path is unchanged', () => {
  it('places glyphs at the hand-derived screen positions with no twin and no basis', () => {
    const r = walkCurvedGlyphs(baseInput({ verticalOffsetPx: 8 }))!
    // Straight horizontal run: cursor IS the x, tangent 0 ⇒ perp is (0, +8).
    expect(xs(r.glyphOffsets, 5)).toEqual([150, 170, 190, 210, 230])
    expect(ys(r.glyphOffsets, 5)).toEqual([8, 8, 8, 8, 8])
    expect(Array.from(r.glyphRotations)).toEqual([0, 0, 0, 0, 0])
    expect(r.minX).toBe(150)
    expect(r.maxX).toBe(230)
  })

  it('drops a label that does not fit the run, and one text-max-angle rejects', () => {
    expect(walkCurvedGlyphs(baseInput({ totalAdvancePx: 500 }))).toBeNull()
    // A 90° corner between two glyphs, with the gate at 45°.
    const cornerX = new Float32Array([0, 100, 100])
    const cornerY = new Float32Array([0, 0, 100])
    expect(
      walkCurvedGlyphs(
        baseInput({
          px: cornerX,
          py: cornerY,
          qx: cornerX,
          qy: cornerY,
          n: 3,
          maxAngleRad: Math.PI / 4,
        }),
      ),
    ).toBeNull()
  })

  it('allocates nothing for a run that cannot hold the label', () => {
    // The arena is per-frame and bump-allocated: a dropped label must not consume
    // any of it (the fit test runs BEFORE `alloc`).
    let calls = 0
    walkCurvedGlyphs(
      baseInput({
        totalAdvancePx: 500,
        alloc: (len) => {
          calls++
          return new Float32Array(len)
        },
      }),
    )
    expect(calls).toBe(0)
  })

  it('clamps rather than drops when the centre would push the label off an end (#1793)', () => {
    // centre 10 with a 100-px label on a 400-px run: startS clamps to 0.
    const r = walkCurvedGlyphs(baseInput({ centerOffsetPx: 10 }))!
    expect(xs(r.glyphOffsets, 5)).toEqual([0, 20, 40, 60, 80])
  })
})

describe('curved glyph walk — the #1793 end clamp also covers the keep-upright reversed walk (#2317)', () => {
  // Same 400-px run as above but walked start-to-end in the OTHER direction, so its
  // live tangent points left and keep-upright reverses the walk (§ header, "keepUpright
  // is decided on the LIVE tangent"). The reversed branch recomputes `startS` from
  // scratch (line ~162) — the #1793 clamp must still bound whichever value survives,
  // not just the forward one it was written against.
  const REV_X = new Float32Array([400, 300, 200, 100, 0])

  it("clamps near the run's live-tangent start instead of extrapolating past it", () => {
    const r = walkCurvedGlyphs(
      baseInput({ px: REV_X, qx: REV_X, n: 5, keepUpright: true, centerOffsetPx: 390 }),
    )!
    for (const x of xs(r.glyphOffsets, 5)) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(400)
    }
    expect(xs(r.glyphOffsets, 5)).toEqual([0, 20, 40, 60, 80])
  })

  it("clamps near the run's live-tangent end instead of extrapolating past it", () => {
    const r = walkCurvedGlyphs(
      baseInput({ px: REV_X, qx: REV_X, n: 5, keepUpright: true, centerOffsetPx: 10 }),
    )!
    for (const x of xs(r.glyphOffsets, 5)) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(400)
    }
    expect(xs(r.glyphOffsets, 5)).toEqual([300, 320, 340, 360, 380])
  })
})
