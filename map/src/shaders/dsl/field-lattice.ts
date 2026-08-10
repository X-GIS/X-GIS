// ═══ The arrow field's own view description, and the screen→grid map built on it (#1520) ═══
//
// WHY THIS EXISTS. A field over a georeferenced grid used to be generated from the DATA — one
// instance per
// grid cell (later per sub-cell), each carrying its geographic anchor and two projected basis
// anchors. #1520 measured what that costs at depth: the instance set scales with the GRID, and at
// z17 and beyond not one seeded node falls inside the viewport, so the field paints NOTHING. No
// amount of subdivision fixes it — holding ~34 px spacing at z19 would need 355 M instances, of
// which fewer than one is on screen.
//
// So the field is generated from the VIEW instead: a lattice sized by what the screen can show, not
// by what the grid contains. #1520 anchored that lattice to the SCREEN and #1534 moved it to the
// GROUND — one instance per ground node, enumerated over the visible uv box — so the field is
// carried by the map instead of sliding over it. Either way a node has to answer "what geography is
// here, and how big is it on screen?", and this module is what answers it:
//
//   • WHERE a screen position sits in the coverage's grid-uv (`field_screen_lonlat` →
//     `field_grid_uv`) — the backward map (`unproject-dsl.ts`);
//   • WHERE a ground node sits on screen (`field_node_uv` → `field_node_ndc`) — a linearized
//     forward model the VS then corrects with one Newton step against that same backward map;
//   • HOW BIG one unit of grid-uv is ON SCREEN at that node (`field_uv_basis`), which is what turns
//     a velocity sampled in uv into a direction and a distance in pixels — and is also the
//     Jacobian the Newton step uses, so the two cannot disagree.
//
// ── THE UNIFORM IS THIS LAYER'S OWN, NOT THE SHARED FRAME UNIFORM ────────────────────────────
//
// `pointU` is bound by every retained shader — icon, circle, text, particle — so a field
// added there is bytes every one of them uploads and none but this one reads. This block is bound
// only by the module that draws the field, in ITS group 1, beside the source data
// that are already per-batch. It is also genuinely per-BATCH and not just per-frame: `crs` maps
// lon/lat into one coverage domain's grid, and a mosaic holds several at once.
//
// ── WHY THE CAMERA ARRIVES AS FOUR CORNER RAYS ────────────────────────────────────────────────
//
// Not as an inverse matrix (`globe.ts:358` measured the f32 inverse at ~1 m, "~8 px at screen
// centre and tens of px under motion at z17+"), and not as a bearing/pitch/ENU basis either — that
// would be a SECOND statement of the composition `buildECEFFrameView` / `buildGlobeMatrix` already
// own, and a basis that disagrees with the matrix the forward path uses is a lattice that slides
// against the map under motion. Four directions unprojected on the CPU through the f64 inverse
// cannot disagree with the forward matrix, because they were derived from it, and the blend
// between them is EXACT for a perspective projection rather than an approximation.

import {
  fn,
  f32,
  max,
  min,
  abs,
  step,
  cos,
  sin,
  radians,
  dot,
  cross,
  normalize,
  length,
  select,
  vec2,
  vec3,
  vec4,
  when,
  Let,
  uniformStruct,
  type ReadonlyNode,
  f32T,
  vec2fT,
  vec4fT,
} from '@xgis/shader-dsl'
import { project } from './projections'
import {
  ray_from_corners,
  ray_hit_plane,
  ray_hit_sphere_enu,
  sphere_to_lonlat,
  flat_jacobian,
  unproject_flat,
} from './unproject-dsl'
import { pointU } from './point'

// ── The lattice, and the two numbers that bound it ────────────────────────────────────────────
//
// The TRAIN constants that used to sit here moved to `arrow-drift.ts` with #1547: a streamline
// train, its glyph count and its tap rate are PORTRAYAL, and a consumer that draws one symbol per
// node (a wind barb, say) needs none of them. What is left is what the lattice itself owns.

/** Ceiling on ground nodes enumerated in one frame.
 *
 *  A near-horizon view sees ground all the way to the skyline, so the visible uv box can hold far
 *  more nodes than a screenful is worth. The CPU halves the resolution until the count fits rather
 *  than dropping the far ones (`groundLatticeFor` records why). Sized at roughly eight screenfuls
 *  of the flat-view lattice, which covers a 60° pitch at 1080p with room to spare. */
export const FIELD_MAX_GROUND_NODES = 4096

/** How far the Newton correction may move a node, in node spacings, before the node is
 *  rejected instead.
 *
 *  A BLOWUP GUARD, not a fit. The model's guess is sub-pixel over the visible span, so an ordinary
 *  correction is a fraction of one spacing; a correction of eight is the guess having landed on
 *  ground that has nothing to do with the node, which happens past the horizon where the projective
 *  divide is ill-conditioned. Rejecting is a size factor like every other rejection here — it can
 *  drop a node but it cannot turn one, which a per-component clamp could and once did
 *  (the first consumer's `arrow-drift-direction.test.ts` keeps that arithmetic). */
export const FIELD_NEWTON_SPACINGS = 8

/** The per-frame, per-batch view description. Seventeen `vec4f` = 272 B, rewritten once per frame
 *  per advected batch; the bind group itself is cached, since only the buffer contents change.
 *
 *  Every `w` lane carries a scalar rather than padding — std140 would round a bare `f32` up to 16 B
 *  anyway, so a scalar in a corner ray's `w` is genuinely free. (The four `own_*` lanes below are
 *  the one exception: they are a whole-vec4 payload, not a spare `w`.) */
const U = uniformStruct(
  'FieldView',
  { group: 1, binding: 4, as: 'field_view' },
  {
    /** xyz = world-space ray direction at NDC (−1, −1); w = ground-lattice columns `nx`. */
    ray_bl: vec4fT,
    /** …at NDC (+1, −1); w = ground-lattice rows `ny`. */
    ray_br: vec4fT,
    /** …at NDC (−1, +1); w = the first consumer-defined scalar (`carry[0]`). */
    ray_tl: vec4fT,
    /** …at NDC (+1, +1); w = the second consumer-defined scalar (`carry[1]`). */
    ray_tr: vec4fT,
    /** xyz = the ray ORIGIN in the MVP's world space. Not assumed to be the world origin: the flat
     *  and ENU frames anchor the world at the camera's GROUND point and a pitched camera sets the
     *  eye back over it. w = outline stroke width, in `loc` units. */
    eye: vec4fT,
    /** xyz = world-space zenith at the world origin (`(0,0,1)` for the flat/ENU frames, the ECEF
     *  radial for the globe's ECEF-parallel one); w = the local earth radius, in metres. */
    up: vec4fT,
    /** xyz = world-space east at the world origin; w = the origin's longitude, in degrees. */
    east: vec4fT,
    /** xyz = world-space north at the world origin; w = the origin's latitude, in degrees. */
    north: vec4fT,
    /** The coverage's grid box as an affine map from lon/lat to grid-uv:
     *  `uv = (lonlat − crs.xy) · crs.zw`. `crs.w` is NEGATIVE — grid-v runs southward (row 0 is the
     *  northernmost), so the sign rides the reciprocal rather than a branch nobody would remember
     *  to keep in step with the flow-texture packer. */
    crs: vec4fT,
    /** The ground lattice: `(stepU, stepV, jx0, jy0)`. The steps are powers of two in grid-uv and
     *  the anchor is a multiple of them, so a node's uv — and therefore its phase — does not move
     *  when the camera does. `jx0`/`jy0` are the SIGNED index of the first enumerated node on each
     *  axis, so the window slides with the view while the lattice underneath it stays put. */
    lattice: vec4fT,
    /** Row 0 of the `(û, v̂, 1) → clip` model, `xyz`; `w` = the anchor's grid-u.
     *
     *  `world → clip` is exactly linear and the ground surface is a plane (flat) or its tangent
     *  plane (globe), so the ONE thing linearized is the projection's curvature over the visible
     *  span. Pitch — the case an affine screen approximation gets catastrophically wrong — is
     *  exact. Whatever curvature is left is removed by one Newton step against the backward map. */
    hx: vec4fT,
    /** Row 1 of the model, `xyz`; `w` = the anchor's grid-v. */
    hy: vec4fT,
    /** Row 2 of the model — the `clip.w` row, `xyz`. `w` = 1 when the node set is INTERLEAVED: a
     *  second copy of the lattice offset by half a cell on both axes, so the consumer decodes twice
     *  as many nodes at an effective spacing of `step/√2` while every original node keeps its
     *  position and its phase. 0 for the plain lattice. */
    hw: vec4fT,
    /** Up to four boxes of ground ANOTHER lattice already owns, each `(west, east, south, north)`
     *  in absolute degrees. A node inside one of them must not be emitted by this lattice (#1585).
     *
     *  ABSOLUTE EDGES, not the affine form `crs` uses, and that difference is the point: `crs` has to
     *  produce a uv because the sampler needs one, while this only ever asks CONTAINMENT — so four
     *  `step`s answer it with no divide and no reciprocal to keep in sign-step with a packer.
     *
     *  AN UNUSED SLOT IS AN EMPTY INTERVAL (`west = +1e30`, `east = −1e30`), which no coordinate can
     *  satisfy. That is what removes the need for a separate count lane: the same four `step`s
     *  evaluate to 0 for an inactive slot with no branch and no index compare. Writing a slot as
     *  all-zeros instead would be a box containing the Gulf of Guinea, which is exactly the kind of
     *  quiet default this encoding exists to make unrepresentable. */
    own_0: vec4fT,
    own_1: vec4fT,
    own_2: vec4fT,
    own_3: vec4fT,
  },
)
export { U as fieldViewU }

/** How many "owned by another lattice" boxes the block carries. A CAP, and a loud one: the writer
 *  warns by name when a consumer hands over more than this, rather than silently dropping the tail
 *  and leaving a region double-drawn with nothing in the log to say so. Four is chosen against the
 *  real shape of the problem — the boxes are filtered to those that ACTUALLY overlap the requesting
 *  lattice, and a NOAA domain has a handful of neighbours, not a hundred. */
export const FIELD_OWNED_SLOTS = 4

/** True when the 3D (ECEF / globe) branch is active — the identical `< 6.5` cut the forward
 *  ladder takes, so the backward map cannot pick a different branch than the matrix it inverts. */
const isGlobe = () => pointU.field.proj_params.x.gt(f32(6.5))

/** Ground node `(jx, jy)` → its grid-uv offset from the lattice anchor, and its absolute grid-uv.
 *
 *  Returned as `(û, v̂, u, v)` because both are needed and both are one multiply apart: the OFFSET
 *  is what the model is evaluated at (small by construction, so f32 carries it at any zoom), and the
 *  ABSOLUTE uv is the node's identity — where its velocity is sampled and what its phase is hashed
 *  from. Splitting them is the whole precision argument: `u` at depth is an O(1) number whose f32
 *  ULP is coarser than the lattice, but `û = j·step` is exact for every index a frame enumerates. */
export const field_node_uv = fn('field_node_uv', { jx: f32T, jy: f32T }, (a) => {
  const du = Let(a.jx.mul(U.field.lattice.x))
  const dv = Let(a.jy.mul(U.field.lattice.y))
  return vec4(du, dv, U.field.hx.w.add(du), U.field.hy.w.add(dv))
})

/** A ground node's screen NDC under the linearized model, as `(ndc.x, ndc.y, ok)`.
 *
 *  `ok` is 0 when the node is at or behind the eye plane (`clip.w ≤ 0`), which is where a projective
 *  divide flips the point to the opposite side of the screen — a symbol drawn from the wrong half
 *  of the frame, which reads as a stray mark in empty space rather than as a missing one. */
export const field_node_ndc = fn('field_node_ndc', { duv: vec2fT }, (a) => {
  const hx = U.field.hx
  const hy = U.field.hy
  const hw = U.field.hw
  const w = Let(hw.x.mul(a.duv.x).add(hw.y.mul(a.duv.y)).add(hw.z))
  const ok = Let(step(f32(1e-9), w))
  const inv = Let(f32(1).div(select(w.gt(f32(1e-9)), w, f32(1))))
  return vec3(
    hx.x.mul(a.duv.x).add(hx.y.mul(a.duv.y)).add(hx.z).mul(inv),
    hy.x.mul(a.duv.x).add(hy.y.mul(a.duv.y)).add(hy.z).mul(inv),
    ok,
  )
})

/** Screen NDC → the world-space ground hit, as an offset from the world ORIGIN.
 *
 *  Shared by the lattice node itself and by the two finite-difference probes the basis needs, so
 *  the branch between the flat plane and the sphere is stated exactly once. Returns `(x, y, z, ok)`
 *  in the MVP's own world space; the flat arm leaves `z` at 0, which is where its plane is. */
export const field_ground_hit = fn('field_ground_hit', { ndc: vec2fT }, (a) => {
  const d = Let(
    ray_from_corners({
      ndc: a.ndc,
      bl: U.field.ray_bl,
      br: U.field.ray_br,
      tl: U.field.ray_tl,
      tr: U.field.ray_tr,
    }),
  )
  const eye = Let(U.field.eye.swizzle('xyz'))
  return when(
    [
      [
        isGlobe(),
        () => ray_hit_sphere_enu({ eye, d, up: U.field.up.swizzle('xyz'), r: U.field.up.w }),
      ],
    ],
    () => {
      const p = Let(ray_hit_plane({ eye, d }))
      return vec4(p.x, p.y, f32(0), p.z)
    },
  )
})

/** Screen NDC → geographic, as `(lon_deg, lat_deg, ok)`.
 *
 *  THE TWO ARMS DIFFER IN WHAT THE HIT ALREADY IS, and that is the whole reason they are separate:
 *
 *   • On the globe the hit is a world-space DISPLACEMENT from a surface point whose lon/lat the
 *     uniform carries, so lon/lat is the direct spherical problem from that point —
 *     `sphere_to_lonlat`, which is exact at any angular distance and never forms `atan2` of two
 *     absolute 6.4e6 m components (`unproject-dsl.ts` records why, and what the LINEARIZED form
 *     cost when it was tried: 22 px off at a globe view).
 *   • On a flat projection the hit is already in the MVP's PROJECTED metres, so recovering lon/lat
 *     means inverting the forward — numerically, on the generated ladder, so a projection added to
 *     the table is invertible here the day it lands.
 *
 *  `unproject_flat` takes its target in the FORWARD's own space, which is not the camera-relative
 *  world space: the flat VS feeds `project_geom(abs) − project(clon, clat)`, so the centre has to
 *  be added back. That is `project(proj_params.yz)` — the same term `flat_rel` subtracts, read
 *  from the same uniform, so the two cannot disagree about which centre it is. */
export const field_screen_lonlat = fn('field_screen_lonlat', { ndc: vec2fT }, (a) => {
  const hit = Let(field_ground_hit({ ndc: a.ndc }))
  const pp = pointU.field.proj_params
  return when(
    [
      [
        isGlobe(),
        () => {
          const ll = Let(
            sphere_to_lonlat({
              hit: hit.swizzle('xyz'),
              east: U.field.east.swizzle('xyz'),
              north: U.field.north.swizzle('xyz'),
              up: U.field.up.swizzle('xyz'),
              r: U.field.up.w,
              clon: U.field.east.w,
              clat: U.field.north.w,
            }),
          )
          return vec3(ll.x, ll.y, hit.w)
        },
      ],
    ],
    () => {
      const c = Let(project(pp.y, pp.z, pp))
      const g = Let(unproject_flat({ dest: vec2(hit.x.add(c.x), hit.y.add(c.y)), proj_params: pp }))
      return vec3(g.x, g.y, min(g.z, hit.w))
    },
  )
})

/** lon/lat → the coverage's grid-uv. One multiply-add, and the sign of the v axis rides `crs.w`. */
export const field_grid_uv = fn('field_grid_uv', { lonlat: vec2fT }, (a) =>
  vec2(
    a.lonlat.x.sub(U.field.crs.x).mul(U.field.crs.z),
    a.lonlat.y.sub(U.field.crs.y).mul(U.field.crs.w),
  ),
)

/** 1 when this lon/lat is ground ANOTHER lattice already owns, 0 otherwise (#1585).
 *
 *  WHY A LATTICE NEEDS THIS AT ALL. Two coverage regions whose domains overlap each enumerate a
 *  full lattice over the shared ground, so without a tie-break both emit a node there and whatever
 *  the consumer draws is drawn twice. The lattice does not decide the tie — it is handed the boxes
 *  that are already spoken for and told to keep off them; the consumer owns the rule, and for the
 *  mosaic that rule is the one `coverage-bounds.ts` already states for the same question.
 *
 *  CLOSED ON ALL FOUR SIDES, matching `inUnit`'s closed `step(0,v)·step(v,1)`. A node exactly on a
 *  shared edge is therefore emitted by the owner and suppressed for the later region — once, never
 *  zero times. Inclusive is only safe because the boxes handed in are NODE boxes (the set the owning
 *  lattice actually enumerates) rather than a coverage's outer cell edges, which reach half a cell
 *  further and would open a hairline gap right where adjacent domains are published to abut.
 *
 *  Unrolled over the four slots, branchless: an inactive slot is an empty interval and falls out of
 *  the same arithmetic. `max` rather than a sum, so two overlapping owners still read as 1. */
export const field_owned_elsewhere = fn('field_owned_elsewhere', { lonlat: vec2fT }, (a) => {
  const inBox = (b: typeof U.field.own_0) =>
    step(b.x, a.lonlat.x)
      .mul(step(a.lonlat.x, b.y))
      .mul(step(b.z, a.lonlat.y))
      .mul(step(a.lonlat.y, b.w))
  const f = U.field
  return max(max(inBox(f.own_0), inBox(f.own_1)), max(inBox(f.own_2), inBox(f.own_3)))
})

/** How many device PIXELS one unit of grid-uv spans at this node, as the 2×2
 *  `(∂px.x/∂u, ∂px.x/∂v, ∂px.y/∂u, ∂px.y/∂v)`.
 *
 *  THIS REPLACES THE TWO PACKED BASIS ANCHORS the per-cell generator used to ship. Those were a
 *  pair of geographic points one leash-length along each grid axis, projected per frame — correct,
 *  but they only exist for an instance that was seeded FROM a cell, which a screen node is not.
 *
 *  IT IS DIFFERENCED ON THE BACKWARD MAP, NOT ON THE FORWARD ONE, and the reason is precision. The
 *  forward needs a DSFUN-split geographic anchor to survive at depth, and a screen node has none —
 *  computing its ECEF in f32 loses 0.5 m before the difference is even taken. The backward map's
 *  intermediate is a CAMERA-RELATIVE metric quantity (ENU metres on the globe, projected metres on
 *  the flat arm), which is small by construction at every zoom, so differencing it over ONE PIXEL
 *  is well-conditioned everywhere: ~1e-5 m of noise on a 0.15 m step at z19, ~1 m on a 40 km step
 *  at globe zoom.
 *
 *  ONLY THE CHEAP HALF IS DIFFERENCED. Re-running the whole backward map at three NDC offsets would
 *  cost two extra Newton solves on the flat arm (≈20 forward evaluations). Instead the chain is
 *  split at the metric intermediate: the ray hit is differenced (cheap, exact), and metric→lon/lat
 *  is taken in closed form — the inverse of `flat_jacobian` on the flat arm, and the sphere's own
 *  metre→degree coefficients in the LOCAL frame at the node on the globe. Three forward evaluations total, and the Jacobian is the
 *  SAME function Newton's step uses, so the two cannot fall out of step.
 *
 *  Returns the zero matrix when the node's own hit missed; callers gate on that rather than
 *  dividing by a degenerate determinant. */
export const field_uv_basis = fn('field_uv_basis', { ndc: vec2fT, lon: f32T, lat: f32T }, (a) => {
  const vp = pointU.field.viewport
  // One DEVICE pixel, in NDC. Screen +y is down and NDC +y is up, hence the negated step: `hy`
  // probes the pixel BELOW the node, so the returned column is ∂/∂(screen y) with the sign the
  // rest of this layer already uses.
  const sx = Let(f32(2).div(max(vp.x, f32(1))))
  const sy = Let(f32(2).div(max(vp.y, f32(1))))
  const h0 = Let(field_ground_hit({ ndc: a.ndc }))
  const hx = Let(field_ground_hit({ ndc: vec2(a.ndc.x.add(sx), a.ndc.y) }))
  const hy = Let(field_ground_hit({ ndc: vec2(a.ndc.x, a.ndc.y.sub(sy)) }))
  const dx = Let(hx.swizzle('xyz').sub(h0.swizzle('xyz')))
  const dy = Let(hy.swizzle('xyz').sub(h0.swizzle('xyz')))
  // ∂(lon, lat)/∂(screen px), as the two columns `gx` and `gy`.
  const g = Let(
    when(
      [
        [
          isGlobe(),
          () => {
            // THE LOCAL FRAME AT THE NODE, not at the camera centre, and the distinction is not
            // academic: over a globe view the two are up to tens of degrees apart, so using the
            // centre's east/north rotates every heading by that angle — a field pointing
            // confidently in the wrong direction, which no still frame reveals.
            //
            // Built from the hit itself, in unit vectors only. The node's position relative to the
            // sphere CENTRE is `hit + R·up` (the centre is `−R·up` from the world origin), so its
            // zenith is that direction; the earth's rotation axis in world space is
            // `sin(clat)·up + cos(clat)·north`, and east is its cross with the zenith.
            const r = U.field.up.w
            const up0 = U.field.up.swizzle('xyz')
            const p0 = Let(radians(U.field.north.w))
            const axis = Let(up0.mul(sin(p0)).add(U.field.north.swizzle('xyz').mul(cos(p0))))
            const upN = Let(normalize(h0.swizzle('xyz').add(up0.mul(r))))
            const e = Let(normalize(cross(axis, upN)))
            const n = Let(cross(upN, e))
            // `sphere_to_lonlat` is a rotation of the sphere, so its derivative in the LOCAL frame
            // is the same metre→degree relation everywhere — one statement of it, evaluated at the
            // node's own latitude.
            const kLat = Let(f32(180 / Math.PI).div(r))
            const kLon = Let(kLat.div(max(cos(radians(a.lat)), f32(1e-3))))
            return vec4(
              dot(dx, e).mul(kLon),
              dot(dx, n).mul(kLat),
              dot(dy, e).mul(kLon),
              dot(dy, n).mul(kLat),
            )
          },
        ],
      ],
      () => {
        const pp = pointU.field.proj_params
        const f0 = Let(project(a.lon, a.lat, pp))
        const j = Let(flat_jacobian({ f0, lon: a.lon, lat: a.lat, proj_params: pp }))
        // ∂(lon, lat)/∂metres = J⁻¹. A singular J is a non-invertible point (a pole, an oval
        // edge); the zero basis it produces is rejected by the caller's `ok` gate, which is the
        // same answer `unproject_flat` gives there.
        const det = Let(j.x.mul(j.w).sub(j.y.mul(j.z)))
        const inv = Let(select(abs(det).gt(f32(1e-6)), f32(1).div(det), f32(0)))
        return vec4(
          j.w.mul(dx.x).sub(j.y.mul(dx.y)).mul(inv),
          j.x.mul(dx.y).sub(j.z.mul(dx.x)).mul(inv),
          j.w.mul(dy.x).sub(j.y.mul(dy.y)).mul(inv),
          j.x.mul(dy.y).sub(j.z.mul(dy.x)).mul(inv),
        )
      },
    ),
  )
  // …scaled into grid-uv, giving A = ∂uv/∂px …
  const cz = U.field.crs.z
  const cw = U.field.crs.w
  const a00 = Let(g.x.mul(cz))
  const a10 = Let(g.y.mul(cw))
  const a01 = Let(g.z.mul(cz))
  const a11 = Let(g.w.mul(cw))
  // …and inverted, because what every consumer wants is PIXELS PER UV: a velocity arrives in uv
  // and has to become a screen direction and a screen distance.
  const det = Let(a00.mul(a11).sub(a01.mul(a10)))
  const ok = Let(
    select(
      abs(det)
        .gt(f32(1e-30))
        .and(h0.w.gt(f32(0.5))),
      f32(1).div(det),
      f32(0),
    ),
  )
  return vec4(a11.mul(ok), a01.neg().mul(ok), a10.neg().mul(ok), a00.mul(ok))
})

/** Apply an `field_uv_basis` result to a grid-uv vector, giving device pixels.
 *
 *  An inline helper rather than a `fn`: it is four multiplies read from two places, and a call
 *  would cost the emitter a function it then has to inline anyway. */
export const field_uv_to_px = (
  m: ReadonlyNode<'vec4<f32>'>,
  d: ReadonlyNode<'vec2<f32>'>,
): ReadonlyNode<'vec2<f32>'> => vec2(m.x.mul(d.x).add(m.y.mul(d.y)), m.z.mul(d.x).add(m.w.mul(d.y)))

/** A grid-uv step whose SCREEN image points along `dirUv` and is exactly `px` pixels long.
 *
 *  A walk is taken in ARC LENGTH ON SCREEN, not in uv, and that is what makes its step a constant
 *  across the frame: a fixed uv step is a different number of pixels at every latitude, on every
 *  projection, and under any pitch, so a path stepped in uv would bunch toward the horizon and
 *  stretch toward the camera. Inverting the basis per step is not needed — the
 *  screen length of a known uv direction is one basis application, and the step is that direction
 *  scaled by the reciprocal. */
export const field_uv_step = fn('field_uv_step', { m: vec4fT, dir_uv: vec2fT, px: f32T }, (a) => {
  // A SAFE normalize, not the builtin: a land or nodata cell packs exactly (0, 0), and
  // `normalize` of a zero vector is a NaN that propagates into the position — a vertex at an
  // undefined screen coordinate, which some drivers rasterize as a full-screen triangle. The
  // guarded form returns a zero step there, so the walk simply does not advance.
  const n = Let(max(length(a.dir_uv), f32(1e-9)))
  const u = Let(vec2(a.dir_uv.x.div(n), a.dir_uv.y.div(n)))
  const s = Let(field_uv_to_px(a.m, u))
  return u.mul(a.px.div(max(length(s), f32(1e-6))))
})

/** Every function this module contributes, in dependency order. A consumer splices these AFTER
 *  `getGpuProjectionFuncs()` and `UNPROJECT_FUNCS`. */
export const FIELD_LATTICE_FUNCS = [
  field_node_uv.decl,
  field_node_ndc.decl,
  field_ground_hit.decl,
  field_screen_lonlat.decl,
  field_grid_uv.decl,
  field_owned_elsewhere.decl,
  field_uv_basis.decl,
  field_uv_step.decl,
]
