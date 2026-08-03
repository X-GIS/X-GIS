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
//   • THE SPHERE IS CENTRED OFF THE WORLD ORIGIN BY A KNOWN RADIUS, so the quadratic's constant
//     term is built as `|eye|² + 2R·(eye·up)` — two PRODUCTS, never the difference `|O|² − R²`
//     that costs every f32 figure — and the near root is taken in the cancellation-free form
//     `2c / (−b + √disc)`. See `ray_hit_sphere_enu`.
//   • THE HIT BECOMES lon/lat AS AN OFFSET from the camera centre, never as `atan2` of two
//     absolute ECEF components — `sphere_to_lonlat` (exact at any angle) and `enu_to_lonlat` (its
//     linearization, for a Newton guess and a derivative). That step is where the surviving
//     ~0.4 m would be.
//
// ── THE RAY ORIGIN IS PASSED IN, BECAUSE THE EYE IS NOT AT THE WORLD ORIGIN ────────────────────
//
// #1520's plan asserted "the MVP's world space is ENU AT THE CAMERA, for BOTH paths", and both
// halves of that turn out to be wrong in a way that a still frame would never show:
//
//   • `view-matrix.ts:278` `buildECEFFrameView` composes `P × T(0,0,−alt) × Rx × Rz × Renu`, and
//     `Renu` is a pure ROTATION — so the world origin is the camera's GROUND ANCHOR on the
//     surface, and the eye sits `alt` away from it along the pitched/bearing-rotated axis.
//   • `geo/src/globe.ts:319` `rtcMatrix` is focus-relative with an ECEF-PARALLEL basis
//     (`s`, `u`, `−fwd` are ECEF vectors), so the globe path's world axes are not ENU at all.
//
// A hit solved from an eye assumed at the origin is therefore wrong by the whole camera altitude
// under pitch, and on the globe by a basis rotation as well. Both are removed the same way: the
// CPU (which owns the f64 inverse anyway) hands over the eye, and the local zenith/east/north as
// world-space unit vectors. The functions below then make no assumption about either convention —
// they are correct for the ENU frame and the ECEF-parallel one without branching on which.

import {
  fn,
  f32,
  abs,
  max,
  min,
  sqrt,
  sin,
  cos,
  asin,
  atan2,
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

/** FLOOR on the residual at or under which the recovered lon/lat is accepted, in metres.
 *
 *  A FLOOR, not the threshold: the threshold is RELATIVE to the target's own magnitude, and this
 *  is only what it cannot fall below near the projection origin. `UNPROJECT_RESIDUAL_REL` is the
 *  part that matters and carries the reasoning.
 *
 *  A node that does not reach the threshold is genuinely outside the projection (past the pole,
 *  off a pseudocylindrical oval, on the far side of an azimuthal disc) and must be reported as a
 *  MISS, never clamped: a clamped node stacks on the edge and paints an arrow over water it was
 *  not sampled from. */
export const UNPROJECT_RESIDUAL_M = 1

/** …and the RELATIVE part, which is the one that has to exist. 2⁻²² ≈ 2.4e-7.
 *
 *  A FIXED METRE THRESHOLD IS UNREACHABLE AT MERCATOR MAGNITUDES, and this was paid for: the field
 *  rendered with ~40 % of its lattice missing, in horizontal bands, and nothing in 10 058 unit
 *  tests could see it. Web Mercator x at the S-111 demo's longitude is −8 481 432 m, which sits in
 *  `[2²³, 2²⁴)` where the f32 ULP is exactly **1.0 m**; y is 4 593 562 m, ULP 0.5 m. So
 *  `|chk.x − target.x| + |chk.y − target.y|` is a multiple of 1.0 + 0.5 and the old `res < 1`
 *  admitted a node only when `chk.x` landed on the SAME f32 as `target.x` — a coin flip, and a
 *  spatially correlated one, because the rounding varies smoothly across the screen.
 *
 *  IT WAS INVISIBLE TO EVERY NO-GPU GATE. The DSL's CPU lowering evaluates in f64, where the same
 *  residual is ~1e-9, so the round-trip identity test passes at sub-pixel with the bug live. Only
 *  a real f32 shader reaches the floor — the render gate found it on its first run (§5).
 *
 *  WHY RELATIVE IS ALSO THE RIGHT ANSWER, not merely a workaround. This gate's job is to tell
 *  "Newton converged" from "Newton did not converge", and those differ by ORDERS of magnitude: a
 *  converged node sits at the f32 floor (a few ULP), a node past a pole or off an oval edge sits
 *  at 1e5–1e6 m. Scaling with the magnitude tracks the floor exactly, so the separation stays five
 *  orders wide at every zoom, where a fixed metre is simultaneously too tight near the antimeridian
 *  and too loose near the projection origin. Four ULP of headroom is what a few Newton steps'
 *  accumulated rounding needs. */
export const UNPROJECT_RESIDUAL_REL = 2 ** -22

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
 *  `eye` is the ray origin in that world space — NOT assumed to be `(0, 0, camH)`. The flat MVP's
 *  world origin is the camera's ground CENTRE, and a pitched camera pulls the eye back over it, so
 *  `eye.xy` is nonzero exactly when pitch is. Dropping it tilts the whole recovered lattice
 *  backwards by the camera's own set-back, which reads as a field that is offset from the map it
 *  sits on rather than as anything obviously broken.
 *
 *  Returns `(x, y, ok)`; `ok = 0` for a ray at or above the horizon, which is the same "no ground
 *  here" answer `unprojectToZ0` gives on the CPU (`camera/unproject.ts`). */
export const ray_hit_plane = fn('ray_hit_plane', { eye: vec3fT, d: vec3fT }, (a) => {
  const down = Let(a.d.z.neg())
  const t = Let(a.eye.z.div(max(down, f32(1e-6))))
  return vec3(
    a.eye.x.add(a.d.x.mul(t)),
    a.eye.y.add(a.d.y.mul(t)),
    select(down.gt(f32(1e-6)).and(t.gt(f32(0))), f32(1), f32(0)),
  )
})

/** Ray ∩ the earth, in whatever world space the 3D MVP hands over.
 *
 *  THE ONE FACT THIS NEEDS is that the world ORIGIN sits on the earth's surface, which both 3D
 *  paths guarantee (`buildECEFFrameView` anchors ENU at the camera's ground point;
 *  `buildGlobeMatrix`'s RTC variant is relative to `target`, the focus point on the ellipsoid).
 *  The centre is then `−R·up` for a local sphere of radius `R` through the origin — and `up` is
 *  passed in rather than assumed to be `(0, 0, 1)`, because the globe path's axes are ECEF-parallel
 *  and its zenith is not a coordinate axis at all.
 *
 *  NOTHING FORMS `|O|² − R²`, which is the f32 trap `geo/src/globe.ts:358` already measured
 *  ("~8 px at screen centre and tens of px under motion at z17+"). With `O = eye + R·up` and
 *  `|up| = 1`:
 *
 *      c = |O|² − R² = |eye|² + 2R·(eye·up)
 *
 *  — two PRODUCTS, no difference of two numbers near 4.1e13. `eye` is metres of camera altitude,
 *  so both terms are small and exactly representable. `b = 2(eye·d + R·(up·d))` is likewise a sum
 *  of products.
 *
 *  THE NEAR ROOT IS TAKEN IN THE CANCELLATION-FREE FORM. `(−b − √disc)/2a` subtracts two nearly
 *  equal numbers whenever the camera is close to the surface (which is every deep zoom — exactly
 *  where the shake was reported). The algebraically identical `2c/(−b + √disc)` adds them instead:
 *  the camera looks downward so `b < 0`, `−b + √disc` is the SUM of two positive quantities, and
 *  the root keeps every figure `c` has.
 *
 *  A LOCAL SPHERE, NOT THE ELLIPSOID, and the error is budgeted rather than assumed. The deviation
 *  from the local osculating sphere at angular distance θ from the camera is ≈ `R·(1 − cos θ)·f`:
 *
 *      view half-angle θ    5° (≈ z6)     60° (globe)
 *      ground error         83 m          10 km
 *      m/px at that zoom    ~2 400        ~40 000
 *      error in PIXELS      0.03          0.25
 *
 *  Sub-pixel everywhere, because the zooms where the approximation is worst are exactly the zooms
 *  where a pixel is largest.
 *
 *  Returns `(x, y, z, ok)` — the hit as a world-space offset from the origin; `ok = 0` when the ray
 *  misses the earth or the surface is behind the eye. */
export const ray_hit_sphere_enu = fn(
  'ray_hit_sphere_enu',
  { eye: vec3fT, d: vec3fT, up: vec3fT, r: f32T },
  (a) => {
    const qa = Let(max(dot(a.d, a.d), f32(1e-12)))
    const qb = Let(f32(2).mul(dot(a.eye, a.d).add(a.r.mul(dot(a.up, a.d)))))
    const qc = Let(dot(a.eye, a.eye).add(f32(2).mul(a.r).mul(dot(a.eye, a.up))))
    const disc = Let(qb.mul(qb).sub(f32(4).mul(qa).mul(qc)))
    const sq = Let(sqrt(max(disc, f32(0))))
    const denom = Let(qb.neg().add(sq))
    const t = Let(
      f32(2)
        .mul(qc)
        .div(select(denom.gt(f32(1e-9)), denom, f32(1e-9))),
    )
    return vec4(
      a.eye.x.add(a.d.x.mul(t)),
      a.eye.y.add(a.d.y.mul(t)),
      a.eye.z.add(a.d.z.mul(t)),
      select(
        disc
          .gt(f32(0))
          .and(t.gt(f32(0)))
          .and(denom.gt(f32(1e-9))),
        f32(1),
        f32(0),
      ),
    )
  },
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

/** ∂`project`/∂(lon, lat) at one point, as `(j00, j01, j10, j11)` — metres per DEGREE.
 *
 *  ONE statement of the finite difference, used twice: Newton's step below needs it to invert the
 *  forward, and the screen-lattice VS needs it to turn a flow expressed in grid-uv into a SCREEN
 *  direction (`arrow-view.ts`). Writing the difference twice would be two places for
 *  `JACOBIAN_DELTA_DEG` to drift apart, and the symptom of a drifted one is a glyph that points
 *  slightly off the current it is drawn from — a wrong chart that renders perfectly.
 *
 *  `f0` is passed in rather than recomputed because the Newton step already has it; recomputing
 *  would add a fourth forward evaluation per iteration for a value the caller is holding. */
export const flat_jacobian = fn(
  'flat_jacobian',
  { f0: vec2fT, lon: f32T, lat: f32T, proj_params: vec4fT },
  (a) => {
    const d = f32(JACOBIAN_DELTA_DEG)
    const fx = Let(project(a.lon.add(d), a.lat, a.proj_params))
    const fy = Let(project(a.lon, a.lat.add(d), a.proj_params))
    return vec4(
      fx.x.sub(a.f0.x).div(d),
      fy.x.sub(a.f0.x).div(d),
      fx.y.sub(a.f0.y).div(d),
      fy.y.sub(a.f0.y).div(d),
    )
  },
)

/** A world-space ground hit → lon/lat, EXACTLY on the local sphere, at any angular distance.
 *
 *  `enu_to_lonlat` above is the same map LINEARIZED about the centre, and that is the right answer
 *  where it is used — a Newton initial guess, and a derivative. It is the wrong answer for the hit
 *  itself: its error is second order in the view half-angle, which is invisible at a regional zoom
 *  and is NOT invisible when the same coverage is looked at from a globe view. Measured, on the
 *  round-trip gate at z5: **22 px**, a whole glyph and a half off its own lattice node.
 *
 *  This is the direct spherical problem instead, and it is exact for every θ. The hit's position
 *  relative to the sphere CENTRE decomposes in the local frame as `(e, n, R + u)`, which gives the
 *  angular distance `θ` and the azimuth `α` from the camera centre; the rest is the standard
 *  destination-point formula.
 *
 *  IT IS ALSO BETTER CONDITIONED, not a precision trade. Nothing here is a difference of two
 *  earth-radius numbers: `ρ` and `u` are the hit's own camera-relative components, `R + u` is a
 *  SUM, and every trig operand is O(1). The f32 floor is `θ`'s own ULP — ~1e-7 rad, 0.6 m on the
 *  ground, sub-pixel at every zoom this runs at.
 *
 *  `east`/`north`/`up` are the world-space local frame at the world ORIGIN, so this serves the ENU
 *  frame and the globe's ECEF-parallel one without knowing which it was given. */
export const sphere_to_lonlat = fn(
  'sphere_to_lonlat',
  {
    hit: vec3fT,
    east: vec3fT,
    north: vec3fT,
    up: vec3fT,
    r: f32T,
    clon: f32T,
    clat: f32T,
  },
  (a) => {
    const e = Let(dot(a.hit, a.east))
    const n = Let(dot(a.hit, a.north))
    const u = Let(dot(a.hit, a.up))
    const rho = Let(sqrt(e.mul(e).add(n.mul(n))))
    const theta = Let(atan2(rho, a.r.add(u)))
    const inv = Let(f32(1).div(max(rho, f32(1e-9))))
    const sinA = Let(e.mul(inv))
    const cosA = Let(n.mul(inv))
    const st = Let(sin(theta))
    const ct = Let(cos(theta))
    const p0 = Let(radians(a.clat))
    const sp = Let(sin(p0))
    const cp = Let(cos(p0))
    const sinLat = Let(min(max(sp.mul(ct).add(cp.mul(st).mul(cosA)), f32(-1)), f32(1)))
    return vec2(
      a.clon.add(degrees(atan2(sinA.mul(st).mul(cp), ct.sub(sp.mul(sinLat))))),
      degrees(asin(sinLat)),
    )
  },
)

/** Projected metres → lon/lat, by inverting the GENERATED forward ladder numerically.
 *
 *  `dest` — NOT `target`, which is a WGSL RESERVED WORD and a `CreateShaderModule` error on
 *  WebGPU while being perfectly legal GLSL. See `wgsl-sanitize.ts` for the pass that now catches
 *  the class; this name is spelled defensively as well because a reader renaming it back would
 *  otherwise only find out on a WebGPU device.
 *
 *  It is in `project`'s OWN output space, not the MVP's world space — the two differ per
 *  projection family (mercator's forward is absolute, the pseudocylindrical ones are already
 *  recentred on `clon`), and a function that guessed which it was given would be wrong for half
 *  the table. The caller adds the centre once: `target = rayHit + project(clon, clat, pp)`.
 *
 *  Returns `(lon_deg, lat_deg, ok)`. `ok = 0` when the residual has not contracted — the caller
 *  must treat that as "no arrow here". See the header for why this is not seven hand inverses.
 */
export const unproject_flat = fn('unproject_flat', { dest: vec2fT, proj_params: vec4fT }, (a) => {
  const clon = Let(a.proj_params.y)
  const clat = Let(a.proj_params.z)
  // The centre in the forward's own space, so the initial guess can be taken from a CENTRE-
  // RELATIVE offset whatever that space is.
  const c = Let(project(clon, clat, a.proj_params))
  const g = Let(enu_to_lonlat({ east: a.dest.x.sub(c.x), north: a.dest.y.sub(c.y), clon, clat }))
  const lon = Var(g.x)
  const lat = Var(g.y)
  for (let i = 0; i < UNPROJECT_NEWTON_STEPS; i++) {
    const f0 = Let(project(lon, lat, a.proj_params))
    const j = Let(flat_jacobian({ f0, lon, lat, proj_params: a.proj_params }))
    const j00 = Let(j.x)
    const j01 = Let(j.y)
    const j10 = Let(j.z)
    const j11 = Let(j.w)
    const det = Let(j00.mul(j11).sub(j01.mul(j10)))
    const rx = Let(a.dest.x.sub(f0.x))
    const ry = Let(a.dest.y.sub(f0.y))
    // A singular Jacobian IS a non-invertible point (a pole, an oval edge). Freezing the iterate
    // there leaves the residual test below to reject it; an unguarded divide launches it to
    // infinity and then paints an arrow somewhere real.
    const safe = Let(select(abs(det).gt(f32(1e-3)), det, f32(1)))
    lon.assign(lon.add(j11.mul(rx).sub(j01.mul(ry)).div(safe)))
    lat.assign(min(max(lat.add(j00.mul(ry).sub(j10.mul(rx)).div(safe)), f32(-89.9)), f32(89.9)))
  }
  const chk = Let(project(lon, lat, a.proj_params))
  const res = Let(abs(chk.x.sub(a.dest.x)).add(abs(chk.y.sub(a.dest.y))))
  // The threshold TRACKS THE MAGNITUDE, because the residual cannot go below the f32 ULP of the
  // coordinate it is measured in — see `UNPROJECT_RESIDUAL_REL` for what a fixed metre cost.
  const tol = Let(
    max(
      f32(UNPROJECT_RESIDUAL_M),
      abs(a.dest.x).add(abs(a.dest.y)).mul(f32(UNPROJECT_RESIDUAL_REL)),
    ),
  )
  return vec3(lon, lat, select(res.lt(tol), f32(1), f32(0)))
})

/** Every function this module contributes, in dependency order. A consumer splices these AFTER
 *  `getGpuProjectionFuncs()` — `unproject_flat` calls the forward `project`. */
export const UNPROJECT_FUNCS = [
  ray_from_corners.decl,
  ray_hit_plane.decl,
  ray_hit_sphere_enu.decl,
  enu_to_lonlat.decl,
  sphere_to_lonlat.decl,
  flat_jacobian.decl,
  unproject_flat.decl,
]
