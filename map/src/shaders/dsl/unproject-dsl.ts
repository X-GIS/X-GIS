// ═══ Shader DSL — screen → geographic, on the GPU (#1520 step 2) ═══
//
// THE BACKWARD HALF OF THE PROJECTION LADDER, and the reason it exists: the S-111 arrow field is
// generated from the OUTPUT (a screen lattice) rather than the input (the data grid), so every
// node has to answer "what geography is under me?". That is the semi-Lagrangian back-trace, and
// it is the only new coordinate math the change needs.
//
// #1333's `flow-advect.ts` records screen space being REJECTED for the IBFV pass, for two reasons.
// One does not transfer: "screen-space history is invalidated by camera motion" is about an
// accumulation buffer, and there is none here — this runs per VERTEX over a few hundred nodes and
// holds nothing between frames. The other did transfer, and is answered below rather than paid: a
// per-projection inverse would be a second authority beside the generated forward ladder.
//
// ── NO PER-PROJECTION INVERSE IS WRITTEN ──────────────────────────────────────────────────────
//
// The forward `project` ladder is already on the GPU and is already GENERATED from the
// `PROJECTIONS` table, so adding a projection extends it automatically. Inverting it NUMERICALLY —
// Newton on `project(lon, lat) − rel` with a finite-difference Jacobian — inherits that property
// exactly: a projection added to the table is invertible here the day it lands, with no second
// implementation to keep in step and nothing to drift. Two extra forward evaluations per iteration
// buy what seven hand-written inverses (× two backends) would have cost to write and to keep.
//
// The initial guess is the equirectangular inverse about the camera centre. Every projection in
// the table is locally near-conformal and agrees with it to first order there, so the residual
// starts small and Newton contracts quadratically from it.
//
// ── THE GLOBE IS SOLVED EXACTLY, AND THE f32 TRAP IS REMOVED RATHER THAN OUT-PRECISIONED ──────
//
// `proj_globe` maps to 3D ECEF, so there is no 2D forward to invert; the ray meets the ellipsoid
// in closed form. That closed form has one trap, already paid for once:
//
//   geo/src/globe.ts:358 — "An f32 inverse quantises that back-projection by ~1 m, so the ray hit
//   … shook ~8 px at screen centre and tens of px under motion at z17+."
//
// A shader has no f64, so every earth-radius-scale CANCELLATION has to be written out of the
// arithmetic instead:
//
//   • No matrix is inverted. The ray comes from three orthonormal basis vectors and the tangent of
//     the half FOV — exact in f32 at any altitude, because no term reaches 6.4e6.
//   • The quadratic's constant term is `|O|² − a²`, a difference of two numbers near 4.1e13. It is
//     written `h·(2a + h)` with `h` the camera ALTITUDE, which carries no cancellation at all.
//   • The hit is turned into lon/lat as a small OFFSET from the camera centre, never by taking
//     `atan2` of two absolute ECEF components — that step is where the surviving ~0.4 m would be.
//
// `h` and the unit eye both come out of `globe_eye` (xyz = normalize(eye_ecef), w = EARTH_R/|eye|),
// which the frame uniform already carries for the horizon cull. No new uniform for either.

import {
  fn,
  f32,
  abs,
  max,
  min,
  sqrt,
  cos,
  select,
  vec2,
  vec3,
  vec4,
  dot,
  normalize,
  degrees,
  radians,
  inverseSqrt,
  Let,
  Var,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
} from '@xgis/shader-dsl'
import { project } from './projections'
import { EARTH_R, EARTH_E2 } from './consts'

/** Newton steps taken to invert the forward projection.
 *
 *  Three, and the count is the residual's own answer rather than a guess: the initial guess is
 *  EXACT for equirectangular, first-order at the centre for mercator and oblique mercator, and
 *  worst for natural_earth at a screen corner in a world view. `unproject-newton.test.ts` walks
 *  the residual per projection per step, so a fourth step can be justified by a measurement if a
 *  projection is ever added that needs one — it is not a number to nudge. */
export const UNPROJECT_NEWTON_STEPS = 3

/** Finite-difference step for the Jacobian, in DEGREES.
 *
 *  1e-2° ≈ 1.1 km. Far above the f32 noise floor of a 6.4e6 m projected coordinate (~0.4 m) and
 *  far below the scale over which anything in the table curves. Smaller is NOT more accurate here
 *  — it differences two nearly equal f32 metre values, and the cancellation shows up as a Jacobian
 *  that is pure noise near the poles. */
export const JACOBIAN_DELTA_DEG = 1e-2

/** Residual, in metres, at or under which the recovered lon/lat is accepted.
 *
 *  One metre is under one pixel at every zoom this runs at — the density rule never draws a glyph
 *  at coarser than ~1 m/px in the band where the arrow field is legible. A node that does not
 *  reach it is genuinely outside the projection (past the pole, off a pseudocylindrical oval, on
 *  the far side of an azimuthal disc) and must be reported as a MISS, never clamped: a clamped
 *  node stacks on the edge and paints an arrow over water it was not sampled from. */
export const UNPROJECT_RESIDUAL_M = 1

/** Screen NDC → a ray direction in the MVP's own world space, from the camera basis.
 *
 *  DELIBERATELY NOT AN INVERSE MATRIX — see the header. `right.w` carries `tan(fovY/2)·aspect` and
 *  `up.w` carries `tan(fovY/2)`, so the caller packs five numbers into two vec4s it already needs
 *  to send. */
export const camera_ray = fn(
  'camera_ray',
  { ndc: vec2fT, right: vec4fT, up: vec4fT, fwd: vec4fT },
  (a) =>
    normalize(
      a.right
        .swizzle('xyz')
        .mul(a.ndc.x.mul(a.right.w))
        .add(a.up.swizzle('xyz').mul(a.ndc.y.mul(a.up.w)))
        .sub(a.fwd.swizzle('xyz')),
    ),
)

/** Ray ∩ the ground plane, for the FLAT projections' world space (metres, camera-relative).
 *
 *  The camera sits `camH` above z = 0 and the ray leaves it downward, so the hit is at
 *  `t = camH / −d.z`. Returns `(x, y, ok)`; `ok = 0` for a ray at or above the horizon, which is
 *  the same "no ground here" answer `unprojectToZ0` gives on the CPU (`camera/unproject.ts`). */
export const ray_hit_plane = fn('ray_hit_plane', { d: vec3fT, camH: f32T }, (a) => {
  const down = Let(a.d.z.neg())
  const t = Let(a.camH.div(max(down, f32(1e-6))))
  return vec3(a.d.x.mul(t), a.d.y.mul(t), select(down.gt(f32(1e-6)), f32(1), f32(0)))
})

/** Ray ∩ the WGS84 ellipsoid, in the globe MVP's world space with the camera at the origin.
 *
 *  `eye` is the frame uniform's `globe_eye` (xyz = normalize(eye_ecef), w = EARTH_R/|eye_ecef|), so
 *  `|O| = EARTH_R/w` and the camera altitude `h = EARTH_R·(1/w − 1)` — both recovered from a unit
 *  vector and a ratio, never as a difference of two earth-radius numbers.
 *
 *  The scale-to-sphere trick (z × a/b maps the ellipsoid onto the sphere of radius a) is applied
 *  exactly as `unprojectGlobe` does: the ray PARAMETER is invariant under a linear scale, so the
 *  quadratic is solved in the scaled frame and the hit is evaluated on the ORIGINAL ray, which
 *  means the direction never needs re-normalising.
 *
 *  The constant term is the whole point. `|Oₛ|² − a²` expands to `h·(2a + h) + Oz²·(k² − 1)` — a
 *  sum of two PRODUCTS rather than a difference of two ~4.1e13 numbers, so f32 keeps every figure
 *  that matters. Returns `(hx, hy, hz, ok)`, camera-relative. */
export const ray_hit_ellipsoid = fn('ray_hit_ellipsoid', { d: vec3fT, eye: vec4fT }, (a) => {
  const k = Let(inverseSqrt(f32(1).sub(EARTH_E2))) // a/b
  const w = Let(max(a.eye.w, f32(1e-9)))
  const h = Let(EARTH_R.mul(f32(1).div(w).sub(f32(1))))
  const oz = Let(a.eye.z.mul(EARTH_R.add(h)))
  const os = Let(vec3(a.eye.x.mul(EARTH_R.add(h)), a.eye.y.mul(EARTH_R.add(h)), oz.mul(k)))
  const ds = Let(vec3(a.d.x, a.d.y, a.d.z.mul(k)))
  const qa = Let(max(dot(ds, ds), f32(1e-12)))
  const qb = Let(f32(2).mul(dot(os, ds)))
  const qc = Let(h.mul(f32(2).mul(EARTH_R).add(h)).add(oz.mul(oz).mul(k.mul(k).sub(f32(1)))))
  const disc = Let(qb.mul(qb).sub(f32(4).mul(qa).mul(qc)))
  const sq = Let(sqrt(max(disc, f32(0))))
  const t0 = Let(qb.neg().sub(sq).div(f32(2).mul(qa)))
  const t1 = Let(qb.neg().add(sq).div(f32(2).mul(qa)))
  const t = Let(select(t0.gt(f32(0)), t0, t1))
  return vec4(
    a.d.x.mul(t),
    a.d.y.mul(t),
    a.d.z.mul(t),
    select(disc.gt(f32(0)).and(t.gt(f32(0))), f32(1), f32(0)),
  )
})

/** A camera-relative ENU ground offset → lon/lat, as a DELTA on the camera centre.
 *
 *  Not `atan2` of the absolute ECEF: that path forms `sqrt(x² + y²)` at 6.4e6 m, whose f32 ULP is
 *  ~0.4 m — four pixels at z19, which is the shake `globe.ts` measured. Here both inputs are the
 *  metres between the camera's ground point and the node, so the small numbers stay small and the
 *  centre (`proj_params.yz`, exact) carries the magnitude.
 *
 *  `M` and `N` are folded to one radius: over a viewport the meridional/normal difference is below
 *  0.4 % and it moves a glyph by less than the width of its own outline. */
export const enu_to_lonlat = fn(
  'enu_to_lonlat',
  { east: f32T, north: f32T, clon: f32T, clat: f32T },
  (a) => {
    const lat = Let(a.clat.add(degrees(a.north.div(EARTH_R))))
    const scale = Let(max(cos(radians(a.clat)), f32(1e-3)))
    const lon = Let(a.clon.add(degrees(a.east.div(EARTH_R.mul(scale)))))
    return vec2(lon, lat)
  },
)

/** Projected metres → lon/lat, by inverting the GENERATED forward ladder numerically.
 *
 *  `target` is in `project`'s OWN output space, not the MVP's world space — the two differ per
 *  projection family (mercator's forward is absolute, the pseudocylindrical ones are already
 *  recentred on `clon`), and a function that guessed which it was given would be wrong for half
 *  the table. The caller adds the centre once: `target = rayHit + project(clon, clat, pp)`.
 *
 *  Returns `(lon_deg, lat_deg, ok)`. `ok = 0` when the residual has not contracted — the caller
 *  must treat that as "no arrow here". See the header for why this is not seven hand inverses.
 */
export const unproject_flat = fn('unproject_flat', { target: vec2fT, proj_params: vec4fT }, (a) => {
  const clon = Let(a.proj_params.y)
  const clat = Let(a.proj_params.z)
  // The centre in the forward's own space, so the initial guess can be taken from a CENTRE-
  // RELATIVE offset whatever that space is.
  const c = Let(project(clon, clat, a.proj_params))
  const g = Let(
    enu_to_lonlat({ east: a.target.x.sub(c.x), north: a.target.y.sub(c.y), clon, clat }),
  )
  const lon = Var(g.x)
  const lat = Var(g.y)
  const d = f32(JACOBIAN_DELTA_DEG)
  for (let i = 0; i < UNPROJECT_NEWTON_STEPS; i++) {
    const f0 = Let(project(lon, lat, a.proj_params))
    const fx = Let(project(lon.add(d), lat, a.proj_params))
    const fy = Let(project(lon, lat.add(d), a.proj_params))
    const j00 = Let(fx.x.sub(f0.x).div(d))
    const j01 = Let(fy.x.sub(f0.x).div(d))
    const j10 = Let(fx.y.sub(f0.y).div(d))
    const j11 = Let(fy.y.sub(f0.y).div(d))
    const det = Let(j00.mul(j11).sub(j01.mul(j10)))
    const rx = Let(a.target.x.sub(f0.x))
    const ry = Let(a.target.y.sub(f0.y))
    // A singular Jacobian IS a non-invertible point (a pole, an oval edge). Freezing the iterate
    // there leaves the residual test below to reject it; an unguarded divide launches it to
    // infinity and then paints an arrow somewhere real.
    const safe = Let(select(abs(det).gt(f32(1e-3)), det, f32(1)))
    lon.assign(lon.add(j11.mul(rx).sub(j01.mul(ry)).div(safe)))
    lat.assign(min(max(lat.add(j00.mul(ry).sub(j10.mul(rx)).div(safe)), f32(-89.9)), f32(89.9)))
  }
  const chk = Let(project(lon, lat, a.proj_params))
  const res = Let(abs(chk.x.sub(a.target.x)).add(abs(chk.y.sub(a.target.y))))
  return vec3(lon, lat, select(res.lt(f32(UNPROJECT_RESIDUAL_M)), f32(1), f32(0)))
})

/** Every function this module contributes, in dependency order. A consumer splices these AFTER
 *  `getGpuProjectionFuncs()` — `unproject_flat` calls the forward `project`. */
export const UNPROJECT_FUNCS = [
  camera_ray.decl,
  ray_hit_plane.decl,
  ray_hit_ellipsoid.decl,
  enu_to_lonlat.decl,
  unproject_flat.decl,
]
