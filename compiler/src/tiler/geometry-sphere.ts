// ═══ geometry-sphere — line densification on the sphere ═══
//
// Extracted from vector-tiler.ts (Unit 2 per
// .omc/plans/vector-tiler-decomposition-2026-06-09.md): measure an edge in
// arc-degrees and densify it (insert ≤1° sub-vertices) so a coarsely-authored
// line carries enough vertices to follow a curve under globe/orthographic
// projections. Pure math — zero external dependencies, no byte layout.
// Sole external consumer: `makeLinePart` (vector-tiler.ts).
//
// ── #1522: the interpolant is LINEAR in lon/lat, reversing a prior choice ──
//
// This module shipped with spherical-linear (great-circle) interpolation,
// whose stated rationale was that the geodesic sub-vertices exist "so
// line/ring edges hug the sphere under globe/orthographic projections".
// That rationale is rejected for the case it gets wrong: a great-circle arc
// between two points at the SAME latitude bulges POLEWARD off the parallel.
// A Tropic of Cancer authored at 30° spacing (the shape the MapLibre
// demotiles `geolines` layer has) was densified onto ~24.2°N mid-span and
// snapped back to 23.44°N at every authored vertex — a corner, on a line
// that must be a smooth arc.
//
// The authored lon/lat coordinates are the source of truth (GeoJSON / MVT
// convention, MapLibre parity): densification may ADD vertices ON the
// authored line, it may not RELOCATE the line. Hugging the sphere is what
// the ≤1° sub-segment bound already buys — at sub-degree spacing each
// piece's chord is visually on the surface without moving any vertex off
// the parallel.
//
// The 0.5° skip threshold and the 64 sub-segment cap are behaviour-pinned by
// line-densification-contract.test.ts; the on-the-parallel and antimeridian
// contracts by parallel-arc-fidelity.test.ts.

/** Great-circle distance in degrees between two (lon, lat) points. */
function greatCircleDistanceDeg(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const DEG2RAD = Math.PI / 180
  const phi0 = lat0 * DEG2RAD,
    lam0 = lon0 * DEG2RAD
  const phi1 = lat1 * DEG2RAD,
    lam1 = lon1 * DEG2RAD
  const cosOmega = Math.max(
    -1,
    Math.min(
      1,
      Math.sin(phi0) * Math.sin(phi1) + Math.cos(phi0) * Math.cos(phi1) * Math.cos(lam1 - lam0),
    ),
  )
  return (Math.acos(cosOmega) * 180) / Math.PI
}

/** Carry a coordinate list onto ONE 360° longitude branch — the branch its
 *  FIRST coordinate defines. Each successive vertex is shifted by the running
 *  multiple of 360° that makes its delta from the previous one the short way
 *  round, so a path authored folded into (−180, 180] (170 → −170) comes out as
 *  the past-seam form (170 → 190) and a path already authored past the seam is
 *  returned verbatim (offset 0 throughout).
 *
 *  LINES ONLY, and that asymmetry is deliberate. `subdivideLine` is the sole
 *  production caller (#2547): a line is a PATH, so it takes the short way and a
 *  340° step is a fold to undo — the part bbox and every per-tile clip would
 *  otherwise read it as a segment sweeping the whole equator. A polygon RING is
 *  an AREA boundary and is read at face value, so `makePolygonPart` does NOT
 *  run this (#2550 briefly did, and it collapsed the z=0 world parent
 *  [−170 … 170] that data/src/sub-tile-generator.test.ts pins; reverted in
 *  3c7f27f1). RFC 7946 §3.1.9 puts the split burden on the producer, which is
 *  why a folded ring cannot be inferred.
 *  Latitude and any 3rd/4th ordinate are untouched. */
export function unwrapLonBranch(coords: number[][]): number[][] {
  if (coords.length < 2) return coords
  const out: number[][] = new Array(coords.length)
  out[0] = coords[0]
  let lonOffset = 0
  for (let i = 1; i < coords.length; i++) {
    const rawDLon = coords[i][0] - coords[i - 1][0]
    // Nearest whole-world branch, EXCEPT at the two exact boundaries. A fold of
    // two values normalized into (−180, 180] always lands STRICTLY between a
    // half and a whole world, so ±180 and ±360 are not folds and rounding them
    // the other way destroys real geometry: −180 → 180 is the z=0 world
    // rectangle (a full sweep, which would collapse to a zero-width ring) and
    // 0 → 180 is a hemisphere edge (which would flip onto the other half).
    // Both SIGNS are pinned, in wrap-line-antimeridian.test.ts — the ±360 arms
    // are what stop `mag === 360` decaying to `rawDLon === 360`, and the −270
    // arm is what stops `mag <= 180` decaying to `rawDLon <= 180`.
    //
    // NOT `wrapLonDelta` (geo/src/projection.ts), and they disagree at exactly
    // 360 on purpose: that one picks a world-copy REPRESENTATIVE for a point
    // against a central meridian, so `wrapLonDelta(360) === 0` is right there;
    // this one asks whether the delta between two consecutive PATH vertices is
    // a fold artifact, and a 360 step is a real full sweep. Do not unify them.
    //
    // The equality is exact because the inputs are AUTHORED GeoJSON degrees,
    // before any transform, and the canonical spellings (±180, 0/180) are
    // exactly representable. A producer that emits 179.999… → −180 instead is
    // outside the exemption and reads as a fold; no epsilon is added for it
    // because a near-whole-world delta is genuinely ambiguous — nothing local
    // separates "almost a full sweep" from "almost a full fold".
    const mag = Math.abs(rawDLon)
    lonOffset -= 360 * (mag <= 180 || mag === 360 ? 0 : Math.round(rawDLon / 360))
    // Reuse the input array while the branch is the authored one; rebuild onto
    // the running branch once it is not. BOTH arms keep any 3rd/4th ordinate
    // (the rebuild spreads `slice(1)`), so the only difference is that the
    // first avoids an allocation for the common no-fold case.
    out[i] = lonOffset === 0 ? coords[i] : [coords[i][0] + lonOffset, ...coords[i].slice(1)]
  }
  return out
}

/** Insert intermediate vertices into a line / ring so each sub-segment spans
 *  at most ~1° of arc. Edges shorter than 0.5° are left as-is (their chord is
 *  already indistinguishable from the arc at any reasonable rendering scale).
 *  Edges up to 90° are subdivided proportionally; truly long edges are capped
 *  at 64 sub-segments to bound vertex bloat — past ~64° of span that cap, not
 *  the 1° target, is what sets the sub-segment length.
 *
 *  Vertices are placed by LINEAR interpolation in the authored lon/lat space,
 *  so a densified parallel stays exactly on its latitude — see this file's
 *  header for why that reverses the original great-circle interpolant.
 *
 *  Closed rings (last vertex == first) stay closed: the loop processes each
 *  consecutive pair, so the trailing closure edge gets the same treatment.
 *
 *  Without this step a fixture like `[[-30, 0], [30, 0]]` rendered under
 *  orthographic projects to a CHORD that punches through the globe.
 *  Subdivided into ~60 1° sub-edges, the chord-of-each-piece approximation
 *  hugs the sphere surface visually. */
export function subdivideLine(coords: number[][]): number[][] {
  if (coords.length < 2) return coords
  const DEG2RAD = Math.PI / 180
  // One 360° branch first (#2547), so every delta below is already the short
  // way round and every emitted vertex sits on the branch the FIRST coordinate
  // defines. Polygon rings deliberately do NOT get this step — see
  // `unwrapLonBranch`'s docblock for why a ring is read literally.
  const branch = unwrapLonBranch(coords)
  const out: number[][] = [branch[0]]
  for (let i = 0; i < branch.length - 1; i++) {
    const a = branch[i],
      b = branch[i + 1]

    // Unwrap the longitude delta onto the SHORT direction before interpolating.
    // Two authoring conventions meet at ±180 and both have to come out right:
    //
    //   • Continued past the seam (165 → 195), MapLibre's world-copy convention
    //     — |Δlon| is already ≤ 180, so it is interpolated verbatim and every
    //     intermediate longitude stays on the input's own 360° branch, monotone.
    //     The great-circle interpolant needed an explicit repair here, because
    //     `atan2` folded its output back to (−180, 180] and shredded the
    //     polyline into ±360° jumps (#1221); linear interpolation between the
    //     authored endpoints cannot leave the branch they define, so the
    //     monotonicity that gate watches now holds by construction.
    //
    //   • Authored as the folded pair (170 → −170), the same 20° span written
    //     the other way. Interpolating that raw −340° delta would walk the LONG
    //     way round and draw a world-spanning line — the failure mode a naive
    //     lon lerp introduces. `unwrapLonBranch` has already rewritten it as
    //     170 → 190 (#2547), so the delta read here is the short +20 and the
    //     endpoint is on the same branch as the intermediates.
    const dLon = b[0] - a[0]
    const dLat = b[1] - a[1]

    // How long is the edge, measured along the path actually drawn? The
    // great-circle distance answered that exactly while the interpolant WAS
    // the great circle. A lon/lat lerp is a different and generally LONGER
    // path — up to π/2× for a parallel, which is how a near-polar edge would
    // otherwise come out under-densified (the great circle between two 84°N
    // points 160° apart runs over the pole and is only 11.8° long, while the
    // parallel they are authored on is 16.7°). The sphere metric
    // ds² = dLat² + cos²(lat)·dLon² is largest where the path comes closest
    // to the equator, so holding cos at that one latitude bounds the whole
    // path. Take whichever measure is larger and the ~1° target holds for
    // both readings of "how long is this edge".
    const straddlesEquator = a[1] * b[1] <= 0
    const cosMax = straddlesEquator
      ? 1
      : Math.cos(Math.min(Math.abs(a[1]), Math.abs(b[1])) * DEG2RAD)
    const arcDeg = greatCircleDistanceDeg(a[0], a[1], b[0], b[1])
    const spanDeg = Math.max(arcDeg, Math.hypot(dLat, dLon * cosMax))
    if (spanDeg < 0.5) {
      out.push(b)
      continue
    }

    const K = Math.min(64, Math.ceil(spanDeg))
    for (let k = 1; k < K; k++) {
      const t = k / K
      out.push([a[0] + dLon * t, a[1] + dLat * t])
    }
    out.push(b)
  }
  return out
}
