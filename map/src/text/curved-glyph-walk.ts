// ═══ #2012 INC-4 — the curved line label's glyph walk ═══
//
// Extracted from `TextStage.prepare`'s line loop, which sat 2 lines under its LOC
// ceiling while this is exactly the code D1 INC-4 had to change. The move is
// behaviour-free (`curved-line-shaping.test.ts` pins the geometry from first
// principles and did not change), and it buys the increment two things the inline
// loop could not have: the walk becomes a pure function of its inputs, so the
// LABEL-PLANE ↔ SCREEN correspondence this increment introduces gets a unit gate
// that can be severed on its own; and the ceiling is paid with an extraction that
// has its own reason rather than a bump.
//
// WHAT THE WALK DOES, and which space each part lives in.
//
// Historically there was one polyline — the live screen run — and everything
// happened on it. Under `text-pitch-alignment: map` there are two, sharing sample
// indices by construction (design §3.4): `px/py` is the LABEL PLANE (the pitch-0
// image of the same merc samples) and `qx/qy` is the live screen. Then:
//
//   • ARC LENGTH, the fit test, `centerOffsetPx`, `text-max-angle` and the
//     per-glyph advance cursor are LABEL-PLANE quantities — that is the space
//     MapLibre lays line symbols out in, and it is why glyph spacing along a road
//     running away from the camera comes out uniform on the ground instead of
//     uniform on a foreshortened screen.
//   • The GLYPH POSITION is the live screen point at the same (segment, fraction)
//     — the index correspondence. Exact at every sample, no inverse, no extra
//     projection.
//   • The GLYPH ROTATION is the LABEL-PLANE tangent, NOT the live one. This is a
//     deliberate departure from step 4 of design §3.4, and the reason is that the
//     renderer composes the basis ONTO this rotation: the drawn baseline direction
//     is `B · R(θ)`, and since `B` maps a label-plane step to its live screen image
//     (that is what the Jacobian ratio IS), `B · t_plane ∝ t_live` — the glyphs
//     follow the road as it appears on screen, which is what step 4 asks for.
//     Feeding the LIVE tangent instead would draw the baseline along `B · t_live`,
//     which is the road direction transformed a second time: exact only where the
//     road runs along a basis eigenvector (screen-axis-aligned roads) and off by
//     ~18° at pitch 60 on a 45° road. `curved-glyph-walk.test.ts` measures both.
//   • `keepUpright` is decided on the LIVE tangent (design NEEDS-PROBE 6). "Would
//     this read upside down" is a question about the SCREEN, and the screen
//     baseline is `B · t_plane`, whose x-sign is the live tangent's, not the
//     plane tangent's. Reversing the walk reverses both polylines together, so the
//     decision stays coherent with the plane-space cursor it flips.
//
// THE PRE-IMAGE. The renderer applies the basis about ONE pivot per draw
// (`TextDraw.groundBasisPivot`), so `pivot + B·(offset − pivot)` is what actually
// lands on screen. Writing the live position into `glyphOffsets` would therefore
// put the glyph at `pivot + B·(live − pivot)` — the ground transform applied a
// second time, which slides a 120 px road name to half its length and off the
// road. Writing the PRE-IMAGE `pivot + B⁻¹·(live − pivot)` makes the renderer
// reproduce the live position EXACTLY, while the ~20 px quad built around it still
// comes out through `B`. That is the whole trick, and it is why the pivot is a new
// field rather than a re-anchoring of `glyphOffsets` (design §3.4(5)).
//
// Without a basis every one of the above collapses: `qx/qy` IS `px/py`, `basisInv`
// is absent, and each line below reduces to the expression it always was — the
// vertices stay bit-identical, which is the rung the whole increment protects.

/** `[ex, ey, nx, ny]` in `GroundBasis` order, already inverted by the caller. */
export type BasisInv = readonly [number, number, number, number]

export interface CurvedGlyphWalkInput {
  /** The WALK polyline — the label plane when `qx/qy` differ, else the screen. */
  px: Float32Array
  py: Float32Array
  /** The LIVE screen twin, sharing sample indices with `px/py`. Pass `px/py`
   *  itself when there is no label plane. */
  qx: Float32Array
  qy: Float32Array
  /** Sample count. Both polylines are this long. */
  n: number
  /** Per-glyph advance widths in px, index-parallel to the glyph run. */
  advances: ArrayLike<number>
  glyphCount: number
  /** Sum of advances plus the letter spacing between them. */
  totalAdvancePx: number
  letterSpacingPx: number
  /** Where along the WALK polyline the label centres. */
  centerOffsetPx: number
  /** Perpendicular shift that puts the cap-height midpoint on the line. */
  verticalOffsetPx: number
  keepUpright: boolean
  /** `text-max-angle` in radians; a glyph-to-glyph deflection past it drops the
   *  label, exactly as Mapbox does. */
  maxAngleRad: number
  /** #2012 INC-4 — the inverse of the label's ground basis. Absent ⇒ no ground
   *  alignment and every line below reduces to its pre-INC-4 form. */
  basisInv?: BasisInv
  /** Allocator for the two per-glyph output arrays, called ONLY once the label has
   *  cleared the fit test — the stage's arena is per-frame and bump-allocated, so
   *  a run that cannot hold the label must not consume any of it. `tag` names the
   *  site for the alloc counter. */
  alloc: (len: number, tag: string) => Float32Array
  /** Scratch for the cumulative arc length; grown by the caller across the loop. */
  cumLen: Float32Array
}

/** The screen extent of the laid-out glyph run, in the SAME space `glyphOffsets`
 *  is written in — i.e. the pre-image space when a basis is present, so the caller
 *  can hand the padded box to `groundBasisAabb` about the same pivot and get a
 *  collision footprint that matches the drawn quads by construction. */
export interface CurvedGlyphWalkResult {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Per-glyph outputs, arena-allocated through `alloc`. */
  glyphOffsets: Float32Array
  glyphRotations: Float32Array
  /** The LIVE screen point at `centerOffsetPx` — where the caller derived the
   *  basis, and therefore the pivot the renderer must apply it about. Computed
   *  here rather than handed in so the pivot and the walk cannot disagree about
   *  which point of the run the label centres on. `(0, 0)` when no basis is in
   *  play, where the field is unread. */
  pivotX: number
  pivotY: number
}

/** Lay a glyph run along a polyline. Returns `null` when the label does not fit
 *  the run (Mapbox drops rather than truncates) or `text-max-angle` rejects it. */
export function walkCurvedGlyphs(inp: CurvedGlyphWalkInput): CurvedGlyphWalkResult | null {
  const { px, py, qx, qy, n, advances, glyphCount, totalAdvancePx, cumLen } = inp
  if (n < 2) return null
  // Cumulative arc length on the WALK polyline — the label plane's, when there is
  // one, which is what makes the cadence below a ground-uniform one.
  cumLen[0] = 0
  for (let i = 1; i < n; i++) {
    const dx = px[i]! - px[i - 1]!
    const dy = py[i]! - py[i - 1]!
    cumLen[i] = cumLen[i - 1]! + Math.sqrt(dx * dx + dy * dy)
  }
  const totalLineLen = cumLen[n - 1]!
  // Skip when label can't fit — Mapbox drops it rather than truncate.
  if (totalAdvancePx > totalLineLen) return null
  let startS = inp.centerOffsetPx - totalAdvancePx * 0.5

  // Mapbox `text-keep-upright` (default true): when the label's overall direction
  // would render text upside-down, flip the entire run by walking the polyline in
  // reverse. Per-glyph flipping at the threshold made adjacent glyphs across a
  // 90°-tangent boundary face opposite ways — visibly broken on mild curves. Decide
  // ONCE from the tangent at the label's centre, sampled on the LIVE polyline
  // because "upside down" is a property of the screen (see the header).
  let walkReversed = false
  if (inp.keepUpright) {
    let cIdx = 0
    const cs = inp.centerOffsetPx
    while (cIdx < n - 2 && cumLen[cIdx + 1]! < cs) cIdx++
    const dxMid = qx[cIdx + 1]! - qx[cIdx]!
    const dyMid = qy[cIdx + 1]! - qy[cIdx]!
    const midAngle = Math.atan2(dyMid, dxMid)
    if (midAngle > Math.PI / 2 || midAngle < -Math.PI / 2) {
      walkReversed = true
      // Mirror startS so glyph 0 still ends up at the same position the user
      // expects — but now travelling toward the polyline's start.
      startS = totalLineLen - inp.centerOffsetPx - totalAdvancePx * 0.5
    }
  }

  // #1793 — CLAMP (don't drop) when the label fits the line but the requested
  // centre would push it past one end. The along-line lattice picks
  // `centerOffsetPx` by fixed world-anchored spacing, blind to the label's shaped
  // width, so on a run truncated by the viewport/tile edge its one in-window stop
  // can land within a few px of an end even though the run has spare px elsewhere.
  // Sliding the anchor inward keeps the full, untruncated label on the line the
  // lattice already chose — a POSITION fix, not the truncation forbidden above.
  // Applied AFTER the keep-upright block (#2317) so it bounds whichever `startS`
  // survives — the reversed branch above recomputes it from scratch and, being a
  // cursor in the same arc-length parameterisation, is bounded by the identical
  // interval.
  if (startS < 0) startS = 0
  else if (startS + totalAdvancePx > totalLineLen) startS = totalLineLen - totalAdvancePx

  const basisInv = inp.basisInv
  // The pivot: the LIVE screen point at `centerOffsetPx`, which is the ground
  // point the caller derived the basis at. Located on the WALK polyline (the
  // offset is a plane quantity) and read off the live twin — the same index
  // correspondence every glyph below goes through.
  let pivotX = 0
  let pivotY = 0
  if (basisInv !== undefined) {
    let ci = 0
    const cs = Math.max(0, Math.min(inp.centerOffsetPx, totalLineLen))
    while (ci < n - 2 && cumLen[ci + 1]! < cs) ci++
    const cl = cumLen[ci + 1]! - cumLen[ci]!
    const ct = cl > 0 ? (cs - cumLen[ci]!) / cl : 0
    pivotX = qx[ci]! + (qx[ci + 1]! - qx[ci]!) * ct
    pivotY = qy[ci]! + (qy[ci + 1]! - qy[ci]!) * ct
  }
  const glyphOffsets = inp.alloc(glyphCount * 2, 'text-stage.curved.glyphOffsets.FrameArena')
  const glyphRotations = inp.alloc(glyphCount, 'text-stage.curved.glyphRotations.FrameArena')
  const verticalOffsetPx = inp.verticalOffsetPx
  const letterSpacingPx = inp.letterSpacingPx
  const maxAngleRad = inp.maxAngleRad
  let prevGlyphAngle = NaN
  let cursor = startS
  let segIdx = 0
  let gminX = Infinity,
    gmaxX = -Infinity,
    gminY = Infinity,
    gmaxY = -Infinity
  for (let gi = 0; gi < glyphCount; gi++) {
    const adv = advances[gi]!
    // Sample at the LEFT edge of the advance box, NOT its centre: the renderer's
    // bearing application places the visible glyph's LEFT edge at
    // `baseX + bearingX*scale`, so the polyline position at advance-box-left is the
    // correct per-glyph anchor. Sampling at the box centre was off by
    // `bearingX + glyphWidth/2` per glyph, and since glyph widths vary the gap
    // varied too — "Tr o pi c of Cancer" with wide / narrow alternations.
    const sFwd = walkReversed ? totalLineLen - cursor : cursor
    while (segIdx < n - 2 && cumLen[segIdx + 1]! < sFwd) segIdx++
    while (segIdx > 0 && cumLen[segIdx]! > sFwd) segIdx--
    const segLen = cumLen[segIdx + 1]! - cumLen[segIdx]!
    const t = segLen > 0 ? (sFwd - cumLen[segIdx]!) / segLen : 0
    // THE ROTATION is the WALK (label-plane) tangent — see the header for why the
    // live one would be wrong once the renderer composes the basis onto it.
    const pax = px[segIdx]!,
      pay = py[segIdx]!
    let sAngle = Math.atan2(py[segIdx + 1]! - pay, px[segIdx + 1]! - pax)
    if (walkReversed) sAngle += Math.PI
    // THE POSITION is the live screen point at the SAME (segment, fraction) — the
    // index correspondence. `qx/qy` is `px/py` when there is no label plane, so
    // this is the historical `px[segIdx] + dx*t` unchanged.
    const qax = qx[segIdx]!,
      qay = qy[segIdx]!
    let sx = qax + (qx[segIdx + 1]! - qax) * t
    let sy = qay + (qy[segIdx + 1]! - qay) * t
    if (basisInv !== undefined) {
      // The PRE-IMAGE of the live position under the basis, so that the renderer's
      // `pivot + B·(offset − pivot)` lands the glyph back on the live polyline
      // exactly while its quad still comes out foreshortened.
      const dx = sx - pivotX
      const dy = sy - pivotY
      sx = pivotX + dx * basisInv[0] + dy * basisInv[2]
      sy = pivotY + dx * basisInv[1] + dy * basisInv[3]
    }
    // Perpendicular shift: rotate (0, verticalOffsetPx) by the sample's tangent.
    // cos/sin of (angle + 90°) = (-sin angle, cos angle). Taken in the SAME space
    // the offsets are written in, so a ground-aligned label's shift is projected by
    // the basis with everything else — it is an offset in the map plane, not on the
    // glass.
    const perpX = -Math.sin(sAngle) * verticalOffsetPx
    const perpY = Math.cos(sAngle) * verticalOffsetPx
    const ox = sx + perpX
    const oy = sy + perpY
    glyphOffsets[gi * 2] = ox
    glyphOffsets[gi * 2 + 1] = oy
    glyphRotations[gi] = sAngle
    if (!Number.isNaN(prevGlyphAngle)) {
      // Wrap the tangent delta into [-π, π] before |·| so a seam crossing ±π
      // (179°→-179°) reads as a small 2° turn, not a spurious ~358° one.
      let d = sAngle - prevGlyphAngle
      d = Math.atan2(Math.sin(d), Math.cos(d))
      // text-max-angle: Mapbox drops the whole label rather than fold it.
      if (Math.abs(d) > maxAngleRad) return null
    }
    prevGlyphAngle = sAngle
    if (ox < gminX) gminX = ox
    if (ox > gmaxX) gmaxX = ox
    if (oy < gminY) gminY = oy
    if (oy > gmaxY) gmaxY = oy
    cursor += adv + (gi < glyphCount - 1 ? letterSpacingPx : 0)
  }
  return {
    minX: gminX,
    minY: gminY,
    maxX: gmaxX,
    maxY: gmaxY,
    glyphOffsets,
    glyphRotations,
    pivotX,
    pivotY,
  }
}

/** Invert a ground basis for the pre-image step above, or return `undefined` when
 *  it is too near-singular to invert.
 *
 *  The producer already rejects `|det| < 1e-6` (`groundBasisAt`), so this is the
 *  belt to that braces: a basis that reached here through some other path must not
 *  be able to turn a road name into a NaN quad. Same `[ex, ey, nx, ny]` layout in
 *  and out, so it composes with the renderer's transform without a second
 *  convention to keep straight. */
export function invertGroundBasis(b: ArrayLike<number>): BasisInv | undefined {
  const ex = b[0]!,
    ey = b[1]!,
    nx = b[2]!,
    ny = b[3]!
  const det = ex * ny - nx * ey
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return undefined
  return [ny / det, -ey / det, -nx / det, ex / det]
}
