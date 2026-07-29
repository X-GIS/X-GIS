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
// ── THE f32 TRAP IS AVOIDED BY CHOICE OF FRAME, NOT OUT-PRECISIONED ───────────────────────────
//
// `proj_globe` maps to 3D ECEF, so there is no 2D forward to invert there; the ray meets the earth
// in closed form. That closed form has one trap, already paid for once:
//
//   geo/src/globe.ts:358 — "An f32 inverse quantises that back-projection by ~1 m, so the ray hit
//   … shook ~8 px at screen centre and tens of px under motion at z17+."
//
// A shader has no f64, so every earth-radius-scale CANCELLATION has to be kept out of the
// arithmetic in the first place. Three choices do that, and each is stated at its own function:
//
//   • NOTHING IS INVERTED HERE. The CPU unprojects the four NDC corners through the f64 MVP
//     inverse and the VS blends them, which is exact for a perspective projection —
//     `ray_from_corners`.
//   • THE WORLD SPACE IS ENU, so the earth centre is `(0, 0, −(R + h))` and the quadratic's
//     constant term IS `h·(2R + h)` — it never has to be recovered from `|O|² − R²` —
//     `ray_hit_sphere_enu`. That is also why the intersection is not solved in ECEF: the answer
//     would then need a rotation into the frame the MVP actually uses.
//   • THE HIT BECOMES lon/lat AS AN OFFSET from the camera centre, never as `atan2` of two
//     absolute ECEF components — `enu_to_lonlat`. That step is where the surviving ~0.4 m would be.
//
// `h` comes out of `globe_eye.w` (= EARTH_R/|eye_ecef|), which the frame uniform already carries
// for the horizon cull — see `eye_altitude`. No new uniform for it.

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
  mix,
  degrees,
  radians,
  Let,
  Var,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
} from '@xgis/shader-dsl'
import { project } from './projections'
import { EARTH_R } from './consts'

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

/** Screen NDC → a ray direction in the MVP's own world space, by blending the four CORNER rays.
 *
 *  DELIBERATELY NOT AN INVERSE MATRIX, and deliberately not a basis convention either.
 *
 *  Inverting the MVP in the shader is the f32 trap quoted in the header. Re-deriving the camera
 *  basis from bearing/pitch/ENU would avoid that but introduces a SECOND statement of the
 *  composition `buildECEFFrameView` already owns (`P × T × Rx × Rz × Renu`) — and a basis that
 *  disagrees with the matrix the forward path uses is a lattice that slides against the map, which
 *  is not a failure any still frame shows.
 *
 *  So the CPU unprojects the four NDC corners through the f64 MVP inverse — f64 there is free and
 *  is exactly what `unprojectGlobe` already does — and hands over four world-space directions. For
 *  a perspective projection the direction is BILINEAR in NDC between them, so this blend is exact,
 *  not an approximation. It also cannot disagree with the forward matrix: it was derived from it.
 *
 *  The result is not normalised. Callers that need a length (the sphere quadratic) carry `|d|²`
 *  themselves; the plane hit does not care. */
export const ray_from_corners = fn(
  'ray_from_corners',
  { ndc: vec2fT, bl: vec4fT, br: vec4fT, tl: vec4fT, tr: vec4fT },
  (a) => {
    const s = Let(a.ndc.x.mul(f32(0.5)).add(f32(0.5)))
    const t = Let(a.ndc.y.mul(f32(0.5)).add(f32(0.5)))
    const bot = Let(mix(a.bl.swizzle('xyz'), a.br.swizzle('xyz'), s))
    const top = Let(mix(a.tl.swizzle('xyz'), a.tr.swizzle('xyz'), s))
    return mix(bot, top, t)
  },
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

/** Ray ∩ the earth, in the ENU world space the globe MVP actually uses.
 *
 *  `getECEFFrameView` (camera.ts:716) builds `P × T × Rx × Rz × Renu`, so the world axes are ENU
 *  AT THE CAMERA: x east, y north, z up. The earth centre is therefore just `(0, 0, −(R + h))`,
 *  and the quadratic's constant term falls out already conditioned:
 *
 *      |C|² − R² = (R + h)² − R² = h·(2R + h)
 *
 *  — no rearrangement, no difference of two ~4.1e13 numbers, nothing for f32 to lose. That is the
 *  whole reason this is solved in ENU rather than in ECEF: `geo/src/globe.ts:358` measured what the
 *  ECEF form costs when it is done in f32 ("~8 px at screen centre and tens of px under motion at
 *  z17+"), and the ENU form never forms the term that causes it.
 *
 *  A LOCAL SPHERE, NOT THE ELLIPSOID, and the error is budgeted rather than assumed. The ellipsoid
 *  is not axis-aligned in ENU, so the scale-to-sphere trick `unprojectGlobe` uses does not apply
 *  here. The deviation from the local osculating sphere at angular distance θ from the camera is
 *  ≈ `R·(1 − cos θ)·f`:
 *
 *      view half-angle θ    5° (≈ z6)     60° (globe)
 *      ground error         83 m          10 km
 *      m/px at that zoom    ~2 400        ~40 000
 *      error in PIXELS      0.03          0.25
 *
 *  Sub-pixel everywhere, because the zooms where the approximation is worst are exactly the zooms
 *  where a pixel is largest. `h` comes from the frame uniform's existing `globe_eye.w`
 *  (= EARTH_R/|eye|), so this needs no new uniform.
 *
 *  Returns `(east, north, up, ok)` camera-relative; `ok = 0` when the ray misses the earth. */
export const ray_hit_sphere_enu = fn('ray_hit_sphere_enu', { d: vec3fT, h: f32T }, (a) => {
  const rh = Let(EARTH_R.add(a.h))
  const qa = Let(max(dot(a.d, a.d), f32(1e-12)))
  const qb = Let(f32(2).mul(a.d.z).mul(rh))
  const qc = Let(a.h.mul(f32(2).mul(EARTH_R).add(a.h)))
  const disc = Let(qb.mul(qb).sub(f32(4).mul(qa).mul(qc)))
  const sq = Let(sqrt(max(disc, f32(0))))
  // The NEAR hit: the ray leaves the camera outward, so the smaller positive root is the visible
  // surface and the larger one is the far side of the earth.
  const t = Let(qb.neg().sub(sq).div(f32(2).mul(qa)))
  return vec4(
    a.d.x.mul(t),
    a.d.y.mul(t),
    a.d.z.mul(t),
    select(disc.gt(f32(0)).and(t.gt(f32(0))), f32(1), f32(0)),
  )
})

/** Camera altitude, recovered from the frame uniform's `globe_eye.w` (= EARTH_R / |eye_ecef|).
 *
 *  `h = R·(1/w − 1)`: a unit vector and a ratio, so the small number stays small instead of being
 *  formed as the difference of two earth-radius magnitudes. */
export const eye_altitude = fn('eye_altitude', { eye: vec4fT }, (a) =>
  EARTH_R.mul(
    f32(1)
      .div(max(a.eye.w, f32(1e-9)))
      .sub(f32(1)),
  ),
)

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
  ray_from_corners.decl,
  ray_hit_plane.decl,
  ray_hit_sphere_enu.decl,
  eye_altitude.decl,
  enu_to_lonlat.decl,
  unproject_flat.decl,
]
