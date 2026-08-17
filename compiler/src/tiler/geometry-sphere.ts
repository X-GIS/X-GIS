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
  const out: number[][] = [coords[0]]
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i],
      b = coords[i + 1]

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
    //     lon lerp introduces. Unwrapping it to +20 crosses the seam the short
    //     way, which is what the great-circle interpolant did implicitly.
    const rawDLon = b[0] - a[0]
    const dLon = rawDLon - 360 * Math.round(rawDLon / 360)
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
