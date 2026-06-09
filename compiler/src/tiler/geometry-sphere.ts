// ═══ geometry-sphere — great-circle geometry on the unit sphere ═══
//
// Extracted VERBATIM from vector-tiler.ts (Unit 2 per
// .omc/plans/vector-tiler-decomposition-2026-06-09.md): interpolate
// (slerp), measure (arc-degrees), and densify (insert ≤1° sub-vertices)
// so line/ring edges hug the sphere under globe/orthographic
// projections. Pure math — zero external dependencies, no byte layout.
// Sole external consumer: `makeLinePart` (vector-tiler.ts).
//
// The 0.5° skip threshold, the 64 sub-segment cap, and the 1e-9
// collinear guard are behavior-pinned by geodesic-refine.test.ts +
// geodesic-midpoint-pole-hop-fix.test.ts (the `[[-30,0],[30,0]]`
// chord-through-globe fixtures).

/** Spherical linear interpolation between two (lon, lat) points. `t=0`
 *  returns the first endpoint, `t=1` the second; intermediate values
 *  follow the great-circle (geodesic) arc on a unit sphere.
 *
 *  Used by `subdivideGreatCircle` to insert intermediate vertices
 *  along a line/ring edge so that downstream tile clipping +
 *  projection produce a curve that hugs the sphere surface under
 *  globe projections (orthographic / azimuthal / stereographic). On
 *  flat projections the sub-segment chords are visually
 *  indistinguishable from the original edge as long as each
 *  sub-segment spans ≤1° of arc, so this is safe to apply globally —
 *  no projection-specific gating needed at compile time. */
function slerpLonLat(lon0: number, lat0: number, lon1: number, lat1: number, t: number): [number, number] {
  const DEG2RAD = Math.PI / 180
  const RAD2DEG = 180 / Math.PI
  const phi0 = lat0 * DEG2RAD, lam0 = lon0 * DEG2RAD
  const phi1 = lat1 * DEG2RAD, lam1 = lon1 * DEG2RAD
  const x0 = Math.cos(phi0) * Math.cos(lam0)
  const y0 = Math.cos(phi0) * Math.sin(lam0)
  const z0 = Math.sin(phi0)
  const x1 = Math.cos(phi1) * Math.cos(lam1)
  const y1 = Math.cos(phi1) * Math.sin(lam1)
  const z1 = Math.sin(phi1)
  const cosOmega = Math.max(-1, Math.min(1, x0 * x1 + y0 * y1 + z0 * z1))
  const omega = Math.acos(cosOmega)
  if (omega < 1e-9) return [lon0, lat0] // collinear / coincident
  const s = Math.sin(omega)
  const a = Math.sin((1 - t) * omega) / s
  const b = Math.sin(t * omega) / s
  const x = a * x0 + b * x1
  const y = a * y0 + b * y1
  const z = a * z0 + b * z1
  return [Math.atan2(y, x) * RAD2DEG, Math.asin(Math.max(-1, Math.min(1, z))) * RAD2DEG]
}

/** Great-circle distance in degrees between two (lon, lat) points. */
function greatCircleDistanceDeg(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const DEG2RAD = Math.PI / 180
  const phi0 = lat0 * DEG2RAD, lam0 = lon0 * DEG2RAD
  const phi1 = lat1 * DEG2RAD, lam1 = lon1 * DEG2RAD
  const cosOmega = Math.max(-1, Math.min(1,
    Math.sin(phi0) * Math.sin(phi1) + Math.cos(phi0) * Math.cos(phi1) * Math.cos(lam1 - lam0)
  ))
  return Math.acos(cosOmega) * 180 / Math.PI
}

/** Insert great-circle intermediate vertices into a line / ring so each
 *  sub-segment spans at most ~1° of arc. Edges shorter than 0.5° are
 *  left as-is (their chord is already indistinguishable from the arc
 *  at any reasonable rendering scale). Edges up to 90° are subdivided
 *  proportionally; truly long edges are capped at 64 sub-segments to
 *  bound vertex bloat.
 *
 *  Closed rings (last vertex == first) stay closed: the loop processes
 *  each consecutive pair, so the trailing closure edge gets the same
 *  treatment.
 *
 *  Without this step a fixture like `[[-30, 0], [30, 0]]` rendered
 *  under orthographic projects to a CHORD that punches through the
 *  globe. Subdivided into ~60 1° sub-edges, the chord-of-each-piece
 *  approximation hugs the sphere surface visually. */
export function subdivideGreatCircle(coords: number[][]): number[][] {
  if (coords.length < 2) return coords
  const out: number[][] = [coords[0]]
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1]
    const arcDeg = greatCircleDistanceDeg(a[0], a[1], b[0], b[1])
    if (arcDeg < 0.5) {
      out.push(b)
      continue
    }
    const K = Math.min(64, Math.ceil(arcDeg))
    for (let k = 1; k < K; k++) {
      out.push(slerpLonLat(a[0], a[1], b[0], b[1], k / K))
    }
    out.push(b)
  }
  return out
}
