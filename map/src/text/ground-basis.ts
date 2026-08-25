// ═══ #777 IV3 — the ground basis for `text-pitch-alignment: map` ═══
//
// A label with map pitch-alignment lies IN the ground plane: it foreshortens
// and tilts with the camera instead of standing up as a billboard. The renderer
// takes that as `TextDraw.groundBasis = [ex, ey, nx, ny]` and re-places a quad
// corner at screen offset (dx, dy) from the anchor at
//   anchor + dx*(ex, ey) + dy*(nx, ny)
// (text-renderer.ts). This module is where the basis comes from.
//
// THE NORMALIZATION, and why it is not a division. The obvious construction —
// step east/north in lon/lat, project, divide by something — needs the UNPITCHED
// pixels-per-world-unit and the bearing-rotated ground axes, i.e. a re-derivation
// of the camera model. This engine's camera is not one model (Mercator, the flat
// non-merc set, azimuthal discs, globe, plus a scale freeze below z*), so any
// closed-form divisor is right for one projection and quietly wrong for the rest.
//
// Take a RATIO OF THE PROJECTION'S OWN FORWARD JACOBIANS instead (ADR-0012 D1,
// design §3.1). `P` is the live label projector; `P₀` is the SAME projector built
// against the pitch-0 matrix. At the label's own ground point (lon, lat):
//
//   ΔP  = [ P(lon+δ, lat) − P(lon, lat) ,  P(lon, lat+δ) − P(lon, lat) ]
//   ΔP₀ = [ P₀(lon+δ, lat) − P₀(lon, lat), P₀(lon, lat+δ) − P₀(lon, lat) ]
//   basis = ΔP · ΔP₀⁻¹                                        (a 2×2 solve)
//
// Read it as: ΔP₀⁻¹ turns a PITCH-0 screen step into the ground step that made
// it, and ΔP maps that ground step to its LIVE screen image — which is precisely
// "the screen-space images of the anchor's ground axes, normalized so an
// unpitched camera yields exactly [1,0,0,1]". Four properties, each load-bearing:
//
//  - NO INVERSE ANYWHERE, so the azimuthal discs (3/4/5) — which have no
//    unprojection — are in scope with NO per-projection branch. What was a
//    documented limitation dissolves instead of being patched.
//  - IDENTITY AT PITCH 0 BY CONSTRUCTION. At pitch 0 `P ≡ P₀` (same code, same
//    matrix), so ΔP and ΔP₀ are the same floats and the arithmetic below reduces
//    term-for-term to det/det = 1 and 0/det = 0 — EXACTLY, at every bearing,
//    latitude, zoom and projection. Not a tolerance, not a trigonometric
//    argument: that is what makes "unpitched labels do not move" a property of
//    the code rather than of a test.
//  - δ NEVER APPEARS IN THE ARITHMETIC. Both Jacobians carry the same 1/δ, and a
//    ratio cancels it, so the steps are used raw. δ is a linearization radius,
//    not a calibration — it does not have to be matched to a screen scale, which
//    is what retired the old `probePxFor` approximation. The same cancellation
//    makes the basis invariant to a per-COLUMN rescale of the step, so a
//    latitude probe truncated by the Mercator ±85.051129 clamp still yields the
//    correct basis (and yields none at all only when it is truncated to zero).
//  - EVALUATED WHERE THE LABEL IS. The predecessor linearized about the pitch-0
//    unprojection of the SCREEN anchor — a different ground point everywhere but
//    the screen centre — while the renderer pivots the quad on the LIVE anchor.
//    Measured at z14/pitch 60, 400 px above centre, that basis was 84 % wrong on
//    the east axis and 240 % on the north; this one is exact to float noise.
//
// WHAT IT STILL CANNOT DO. The globe (projType 7) renders through the ECEF
// projector and has no map plane at all — its ground plane is the tangent plane
// at the anchor, which is already foreshortened at pitch 0. It is DEFERRED with
// its reason in §3.2 of the design; its producer withholds the basis and the
// label billboards exactly as today, a degradation #1442 already proved
// bit-identical. Do NOT patch it with a per-projection analytic fallback: a
// second, projection-specific basis authority is the two-authorities drift this
// construction exists to avoid.

/** Screen point, or null where the projection has no image for the point. */
export type ScreenPoint = readonly [number, number]

/** `[ex, ey, nx, ny]` — the screen-space images of the anchor's ground axes,
 *  normalized so that an unpitched camera yields exactly `[1, 0, 0, 1]`. */
export type GroundBasis = readonly [number, number, number, number]

export const IDENTITY_BASIS: GroundBasis = [1, 0, 0, 1]

/** True when the basis is (numerically) the identity — i.e. an unpitched view,
 *  where supplying it would be a no-op. Callers omit the field instead, so the
 *  renderer takes its skip path and the vertices stay bit-identical. */
export function isIdentityBasis(b: GroundBasis, eps = 1e-9): boolean {
  return (
    Math.abs(b[0] - 1) <= eps &&
    Math.abs(b[1]) <= eps &&
    Math.abs(b[2]) <= eps &&
    Math.abs(b[3] - 1) <= eps
  )
}

/** The linearization radius, in DEGREES of lon/lat. Not a look knob and not a
 *  calibration — it cancels out of the ratio (see the header), so its only job is
 *  to sit between the two error floors of a finite difference.
 *
 *  1e-8° (≈ 1.1 mm on the ground) is where the sweep bottoms out. MEASURED
 *  against the closed-form basis (the two MVPs' analytic screen-Jacobian ratio at
 *  the same RTC point) over ten flat-Mercator cameras spanning z0-z22, latitude
 *  −33..78, pitch 45-70 and anchors 100-300 px off centre. Worst deviation across
 *  that set, per δ: 1e-11 → 1.7e-3, 1e-10 → 3.3e-4, 1e-9 → 4.7e-5, **1e-8 →
 *  1.6e-5**, 1e-7 → 1.6e-4, 1e-6 → 1.6e-3, 1e-5 → 1.6e-2. It is a V: below it the
 *  low-zoom cameras lose the difference to f64 cancellation (a step of 1e-11° is
 *  sub-picopixel at z0), above it the deep-zoom cameras pick up the projective
 *  second-order term (a step of 1e-5° is ~10 px at z20). Both neighbours are 3×
 *  and 10× worse, so the choice has a decade of margin either side. */
export const BASIS_PROBE_DEG = 1e-8

/** Derive the ground basis at a label's own ground point.
 *
 *  `projectLive` is the live, pitched projector; `projectPitch0` is the SAME
 *  projector built against the pitch-0 matrix (`makeGroundProjector` in
 *  camera/pitch0-unproject.ts builds both, from one composition, with the
 *  viewport culls off — a cull is a "should this draw" answer and would withhold
 *  the basis from exactly the far-field labels this feature exists for).
 *
 *  Returns null when either projector has no image for a probe, or when the
 *  pitch-0 step degenerates (the anchor sat on the horizon, or the latitude probe
 *  was truncated to zero by the Mercator clamp) — in which case the label
 *  billboards, which is what it already does. */
export function groundBasisAt(
  lon: number,
  lat: number,
  projectLive: (lon: number, lat: number) => ScreenPoint | null,
  projectPitch0: (lon: number, lat: number) => ScreenPoint | null,
): GroundBasis | null {
  const d = BASIS_PROBE_DEG
  // READ EACH PROJECTION IMMEDIATELY into scalars. Both projectors are allowed to
  // return a REUSED scratch tuple, and both real ones do (`makeGroundProjector`
  // and `makeLabelProjectors` each own one, and say so). Holding these as tuples
  // across the six calls aliases each projector's three to its last result, every
  // difference below is then 0, the determinant is 0, and this returns null for
  // every label.
  //
  // That is not hypothetical: it is what shipped. #1471 + #1492 were inert on
  // main for exactly this reason — `labels.groundAligned` read 0 at pitch 65
  // while the whole static chain was intact. The unit tests could not see it
  // because their projector helper copied out of the scratch, so they exercised
  // a projector no caller actually passes. Six projections instead of three
  // doubles the number of places to get this wrong.
  const l0 = projectLive(lon, lat)
  if (l0 === null) return null
  const l0x = l0[0]
  const l0y = l0[1]
  const lE = projectLive(lon + d, lat)
  if (lE === null) return null
  const lEx = lE[0]
  const lEy = lE[1]
  const lN = projectLive(lon, lat + d)
  if (lN === null) return null
  const lNx = lN[0]
  const lNy = lN[1]

  const z0 = projectPitch0(lon, lat)
  if (z0 === null) return null
  const z0x = z0[0]
  const z0y = z0[1]
  const zE = projectPitch0(lon + d, lat)
  if (zE === null) return null
  const zEx = zE[0]
  const zEy = zE[1]
  const zN = projectPitch0(lon, lat + d)
  if (zN === null) return null
  const zNx = zN[0]
  const zNy = zN[1]

  // The two Jacobians, column-major [∂x/∂lon, ∂y/∂lon, ∂x/∂lat, ∂y/∂lat], with
  // the shared 1/δ left off both because the ratio cancels it exactly.
  const la = lEx - l0x
  const lb = lEy - l0y
  const lc = lNx - l0x
  const ld = lNy - l0y
  const za = zEx - z0x
  const zb = zEy - z0y
  const zc = zNx - z0x
  const zd = zNy - z0y

  // basis = ΔP · ΔP₀⁻¹, with ΔP₀⁻¹ = [zd, −zb; −zc, za] / det. The term ORDER
  // below is load-bearing: when the camera is unpitched the two Jacobians are the
  // same floats, and written this way each entry reduces to a value IEEE-754
  // guarantees — `za*zd − zc*zb` over the identically-spelled `det` for the
  // diagonal, and a product minus its own commuted self for the off-diagonal. So
  // the identity comes out exact rather than within an epsilon, which is the rung
  // the whole no-regression story rests on. Do not "simplify" the operand order.
  const det = za * zd - zc * zb
  if (!Number.isFinite(det) || det === 0) return null
  const basis: GroundBasis = [
    (la * zd - lc * zb) / det,
    (lb * zd - ld * zb) / det,
    (lc * za - la * zc) / det,
    (ld * za - lb * zc) / det,
  ]
  // A degenerate live step (the anchor sat on the horizon, or the two live probes
  // collapsed) yields a singular or non-finite basis; a label drawn through it
  // would collapse to a line or vanish into NaN. Fall back to no basis, which is
  // the billboard the user already sees. The threshold is on the DIMENSIONLESS
  // basis determinant, so it means the same thing at every zoom.
  if (!basis.every(Number.isFinite)) return null
  const bdet = basis[0] * basis[3] - basis[1] * basis[2]
  if (!Number.isFinite(bdet) || Math.abs(bdet) < 1e-6) return null
  return basis
}

/** The screen AABB a basis-transformed box occupies.
 *
 *  The collision box and the drawn quad must agree, and they are computed in
 *  different places — text-stage derives the box while the renderer transforms
 *  the quad corners. Both pivot on the SAME point (the TextDraw anchor, which is
 *  the layout's drawX/drawY), so routing the box through this function makes the
 *  two share one basis and one pivot. A label that lies down while its collision
 *  box stays upright places wrong: it reserves the upright footprint, so it
 *  loses collisions it should win and blocks labels it should not.
 *
 *  Takes the UNTRANSFORMED box in absolute screen px and returns the AABB of its
 *  four transformed corners. A foreshortened basis therefore yields a SMALLER
 *  box — which is correct, and is why the box cannot simply be left alone.
 */
export function groundBasisAabb(
  basis: GroundBasis,
  pivotX: number,
  pivotY: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const [ex, ey, nx, ny] = basis
  let oMinX = Infinity
  let oMinY = Infinity
  let oMaxX = -Infinity
  let oMaxY = -Infinity
  // All four corners, not just the diagonal pair: a basis with off-diagonal
  // terms (pitch + bearing) rotates the box, so the extremes can come from the
  // other two.
  for (const [cx, cy] of [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ] as const) {
    const dx = cx - pivotX
    const dy = cy - pivotY
    const tx = pivotX + dx * ex + dy * nx
    const ty = pivotY + dx * ey + dy * ny
    if (tx < oMinX) oMinX = tx
    if (tx > oMaxX) oMaxX = tx
    if (ty < oMinY) oMinY = ty
    if (ty > oMaxY) oMaxY = ty
  }
  return { minX: oMinX, minY: oMinY, maxX: oMaxX, maxY: oMaxY }
}
