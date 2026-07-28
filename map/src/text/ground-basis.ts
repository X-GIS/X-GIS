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
// Compose the map with its own inverse instead:
//
//   Gx = unproject_pitch0(anchor + (δ, 0))    — the ground point whose PITCH-0
//   Gy = unproject_pitch0(anchor + (0, δ))      screen image is exactly that step
//   e  = [ project(Gx) − project(anchor_ground) ] / δ
//   n  = [ project(Gy) − project(anchor_ground) ] / δ
//
// At pitch 0 the projector IS the inverse of the unprojector, so each numerator
// is that map applied to its own inverse's output: e = (δ,0)/δ = (1,0) and
// n = (0,1), EXACTLY — at every bearing, every latitude, every projection that
// round-trips. Identity at pitch 0 therefore holds BY CONSTRUCTION rather than by
// a trigonometric argument, which is what makes "unpitched labels do not move" a
// property of the code and not of a test. No analytic Mercator step is ever
// taken, so the awkward cases (bearing rotating the basis, `d / cos(lat)`
// degenerating near the poles) never arise.
//
// WHAT IT CANNOT DO. `Camera.unprojectToLonLat` returns null for projType 3/4/5
// (azimuthal discs — limb singularity) and 7 (globe) — camera.ts:930-932. Under
// those projections there is no basis, and this returns null. That is deliberate
// and must NOT be patched with a per-projection analytic fallback: a null basis
// leaves `TextDraw.groundBasis` absent, the renderer skips the transform, and the
// label billboards exactly as it does today — a degradation #1442 already proved
// bit-identical. A second, projection-specific basis authority would be the
// two-authorities drift this construction exists to avoid.

/** Screen point, or null when the ray misses the ground / the projection has no
 *  inverse (azimuthal, globe). */
export type ScreenPoint = readonly [number, number]
export type LonLat = readonly [number, number]

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

/** Derive the ground basis at a label's screen anchor.
 *
 *  `unprojectPitch0` must be the inverse of the LIVE projection with pitch
 *  forced to 0 (`Camera.unprojectToLonLat` composed against a pitch-0 inverse
 *  matrix — `unprojectToLonLatPure` takes that matrix as an argument, so no
 *  camera state is mutated). `project` is the live, pitched projector the label
 *  anchor itself was placed with.
 *
 *  `probePx` is a linearization radius, not a look knob: the basis is exact only
 *  over the range it spans (#1424's arrow-basis limit), so pass the label's own
 *  extent — its quad half-diagonal — rather than a constant. Too small and the
 *  difference is f32 noise; too large and the quad is placed by extrapolation.
 *
 *  Returns null when any probe fails, which is the whole azimuthal / globe case.
 */
export function groundBasisAt(
  anchorScreenX: number,
  anchorScreenY: number,
  probePx: number,
  unprojectPitch0: (screenX: number, screenY: number) => LonLat | null,
  project: (lon: number, lat: number) => ScreenPoint | null,
): GroundBasis | null {
  // A non-finite or non-positive probe divides by zero below and would poison
  // every vertex with NaN — reject rather than propagate.
  if (!(probePx > 0) || !Number.isFinite(probePx)) return null

  const ground = unprojectPitch0(anchorScreenX, anchorScreenY)
  if (ground === null) return null
  const groundX = unprojectPitch0(anchorScreenX + probePx, anchorScreenY)
  if (groundX === null) return null
  const groundY = unprojectPitch0(anchorScreenX, anchorScreenY + probePx)
  if (groundY === null) return null

  const p0 = project(ground[0], ground[1])
  if (p0 === null) return null
  const pX = project(groundX[0], groundX[1])
  if (pX === null) return null
  const pY = project(groundY[0], groundY[1])
  if (pY === null) return null

  const basis: GroundBasis = [
    (pX[0] - p0[0]) / probePx,
    (pX[1] - p0[1]) / probePx,
    (pY[0] - p0[0]) / probePx,
    (pY[1] - p0[1]) / probePx,
  ]
  // A degenerate probe (the anchor sat on the horizon, or the two ground points
  // collapsed) yields a singular or non-finite basis; a label drawn through it
  // would collapse to a line or vanish into NaN. Fall back to no basis, which is
  // the billboard the user already sees.
  if (!basis.every(Number.isFinite)) return null
  const det = basis[0] * basis[3] - basis[1] * basis[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null
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
