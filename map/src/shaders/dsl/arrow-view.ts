// ═══ The arrow field's own view description, and the screen→grid map built on it (#1520) ═══
//
// WHY THIS EXISTS. The S-111 arrow field used to be generated from the DATA — one instance per
// grid cell (later per sub-cell), each carrying its geographic anchor and two projected basis
// anchors. #1520 measured what that costs at depth: the instance set scales with the GRID, and at
// z17 and beyond not one seeded node falls inside the viewport, so the field paints NOTHING. No
// amount of subdivision fixes it — holding ~34 px spacing at z19 would need 355 M instances, of
// which fewer than one is on screen.
//
// So the field is generated from the OUTPUT instead: a lattice on the SCREEN, at a spacing the
// screen chooses, and every node asks "what geography is under me?". That question is the backward
// map (`unproject-dsl.ts`), and this module is what feeds it — the per-frame camera description
// the VS needs, plus the two derived quantities every glyph is built from:
//
//   • WHERE a screen node sits in the coverage's grid-uv (`arrow_screen_lonlat` → `arrow_grid_uv`);
//   • HOW BIG one unit of grid-uv is ON SCREEN at that node (`arrow_uv_basis`), which is what turns
//     a velocity sampled in uv into a direction and a distance in pixels.
//
// ── THE UNIFORM IS THE ARROW'S OWN, NOT THE SHARED FRAME UNIFORM ──────────────────────────────
//
// `pointU` is bound by every retained shader — icon, circle, text, particle, arrow — so a field
// added there is bytes every one of them uploads and none but this one reads. This block is bound
// only by the advected arrow module, in ITS group 1, beside the band table and the velocity pair
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
  floor,
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

// ── The lattice, and the three numbers that describe it ───────────────────────────────────────

/** Glyphs strung along ONE streamline from a seed — the "train".
 *
 *  A train, rather than one glyph per seed, is what makes the motion read as FLOW rather than as a
 *  field of independently twitching symbols: four glyphs at a fixed arc-length spacing trace the
 *  path the water actually takes, and the eye follows the line instead of each arrow.
 *
 *  It is also what makes the wrap free. Glyph `j` sits at arc-length `(j + φ)·δ`, so as `φ` runs
 *  0→1 the whole train advances by exactly ONE spacing and the set of occupied positions at φ = 1
 *  is the set at φ = 0 shifted by one — every glyph lands where its neighbour was. Only the two
 *  ENDS change, and they are faded (`arrow_phase_alpha` over `(j + φ)/G`), so the alpha at a given
 *  arc-length is the same on both sides of the wrap. The seam is not hidden; it does not exist. */
export const ARROW_TRAIN_GLYPHS = 4

/** Integration taps per inter-glyph spacing.
 *
 *  The streamline is walked in fixed steps of `δ / taps` so the position at arc-length `s` is a
 *  PURE, CONTINUOUS function of `s` — which is what the wrap argument above needs. A step count
 *  derived from `s` (say `ceil(s/h)` uniform steps) is also a pure function of `s`, but it JUMPS
 *  where the count changes, and a jump of any size at the wrap is the blink #1333 rejected moving
 *  glyphs over. Two taps per spacing resolves the curvature a glyph-length of a tidal gyre has;
 *  more buys nothing visible and costs two velocity fetches each. */
export const ARROW_TRAIN_TAPS_PER_SPACING = 2

/** Total integration steps a glyph may need — the last glyph of the train reaches
 *  `(G − 1 + 1)·δ`, so this is the fixed, unrolled bound. */
export const ARROW_TRAIN_STEPS = ARROW_TRAIN_GLYPHS * ARROW_TRAIN_TAPS_PER_SPACING

/** Seed spacing, as a multiple of the inter-glyph spacing δ.
 *
 *  DERIVED, not tuned. Each seed contributes `G` glyphs and owns `S²` pixels of screen, and the
 *  density the portrayal wants is one glyph per `δ²` — so `S² = G·δ²`, i.e. `S = δ·√G`. Seeding at
 *  δ (the obvious choice) would draw `G` times too many glyphs, which on a chart is not a cosmetic
 *  error: overlapping SCAROW symbols read as a faster current than the data says. */
export const ARROW_LATTICE_FACTOR = Math.sqrt(ARROW_TRAIN_GLYPHS)

/** The per-frame, per-batch view description. Nine `vec4f` = 144 B, rewritten once per frame per
 *  advected batch; the bind group itself is cached, since only the buffer contents change.
 *
 *  Every `w` lane carries a scalar rather than padding — std140 would round a bare `f32` up to 16 B
 *  anyway, so a scalar in a corner ray's `w` is genuinely free. */
const U = uniformStruct(
  'ArrowView',
  { group: 1, binding: 4, as: 'arrow_view' },
  {
    /** xyz = world-space ray direction at NDC (−1, −1); w = lattice columns `nx`. */
    ray_bl: vec4fT,
    /** …at NDC (+1, −1); w = lattice rows `ny`. */
    ray_br: vec4fT,
    /** …at NDC (−1, +1); w = inter-glyph spacing δ, in device px. */
    ray_tl: vec4fT,
    /** …at NDC (+1, +1); w = base glyph length, in device px. */
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
  },
)
export { U as arrowViewU }

/** True when the 3D (ECEF / globe) branch is active — the identical `< 6.5` cut the forward
 *  ladder takes, so the backward map cannot pick a different branch than the matrix it inverts. */
const isGlobe = () => pointU.field.proj_params.x.gt(f32(6.5))

/** The NDC of lattice node `seed`, in a row-major `nx × ny` grid of CELL CENTRES.
 *
 *  Centres, not corners: a lattice on the corners puts nodes exactly on the viewport edge, where
 *  half of every glyph is clipped and the field looks like it stops short of the frame. */
export const arrow_seed_ndc = fn('arrow_seed_ndc', { seed: f32T, nx: f32T, ny: f32T }, (a) => {
  const row = Let(floor(a.seed.div(max(a.nx, f32(1)))))
  const col = Let(a.seed.sub(row.mul(a.nx)))
  return vec2(
    col
      .add(f32(0.5))
      .div(max(a.nx, f32(1)))
      .mul(f32(2))
      .sub(f32(1)),
    row
      .add(f32(0.5))
      .div(max(a.ny, f32(1)))
      .mul(f32(2))
      .sub(f32(1)),
  )
})

/** Screen NDC → the world-space ground hit, as an offset from the world ORIGIN.
 *
 *  Shared by the lattice node itself and by the two finite-difference probes the basis needs, so
 *  the branch between the flat plane and the sphere is stated exactly once. Returns `(x, y, z, ok)`
 *  in the MVP's own world space; the flat arm leaves `z` at 0, which is where its plane is. */
export const arrow_ground_hit = fn('arrow_ground_hit', { ndc: vec2fT }, (a) => {
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
export const arrow_screen_lonlat = fn('arrow_screen_lonlat', { ndc: vec2fT }, (a) => {
  const hit = Let(arrow_ground_hit({ ndc: a.ndc }))
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
      const g = Let(
        unproject_flat({ target: vec2(hit.x.add(c.x), hit.y.add(c.y)), proj_params: pp }),
      )
      return vec3(g.x, g.y, min(g.z, hit.w))
    },
  )
})

/** lon/lat → the coverage's grid-uv. One multiply-add, and the sign of the v axis rides `crs.w`. */
export const arrow_grid_uv = fn('arrow_grid_uv', { lonlat: vec2fT }, (a) =>
  vec2(
    a.lonlat.x.sub(U.field.crs.x).mul(U.field.crs.z),
    a.lonlat.y.sub(U.field.crs.y).mul(U.field.crs.w),
  ),
)

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
 *  SAME function Newton's step uses, so the two cannot drift apart.
 *
 *  Returns the zero matrix when the node's own hit missed; callers gate on that rather than
 *  dividing by a degenerate determinant. */
export const arrow_uv_basis = fn('arrow_uv_basis', { ndc: vec2fT, lon: f32T, lat: f32T }, (a) => {
  const vp = pointU.field.viewport
  // One DEVICE pixel, in NDC. Screen +y is down and NDC +y is up, hence the negated step: `hy`
  // probes the pixel BELOW the node, so the returned column is ∂/∂(screen y) with the sign the
  // rest of the arrow path already uses.
  const sx = Let(f32(2).div(max(vp.x, f32(1))))
  const sy = Let(f32(2).div(max(vp.y, f32(1))))
  const h0 = Let(arrow_ground_hit({ ndc: a.ndc }))
  const hx = Let(arrow_ground_hit({ ndc: vec2(a.ndc.x.add(sx), a.ndc.y) }))
  const hy = Let(arrow_ground_hit({ ndc: vec2(a.ndc.x, a.ndc.y.sub(sy)) }))
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
            // centre's east/north rotates every glyph's heading by that angle — a field pointing
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

/** Apply an `arrow_uv_basis` result to a grid-uv vector, giving device pixels.
 *
 *  An inline helper rather than a `fn`: it is four multiplies read from two places, and a call
 *  would cost the emitter a function it then has to inline anyway. */
export const arrow_uv_to_px = (
  m: ReadonlyNode<'vec4<f32>'>,
  d: ReadonlyNode<'vec2<f32>'>,
): ReadonlyNode<'vec2<f32>'> => vec2(m.x.mul(d.x).add(m.y.mul(d.y)), m.z.mul(d.x).add(m.w.mul(d.y)))

/** A grid-uv step whose SCREEN image points along `dirUv` and is exactly `px` pixels long.
 *
 *  The streamline is walked in ARC LENGTH ON SCREEN, not in uv, and that is what makes the glyph
 *  spacing a constant across the frame: a fixed uv step is a different number of pixels at every
 *  latitude, on every projection, and under any pitch, so a train stepped in uv would bunch toward
 *  the horizon and stretch toward the camera. Inverting the basis per step is not needed — the
 *  screen length of a known uv direction is one basis application, and the step is that direction
 *  scaled by the reciprocal. */
export const arrow_uv_step = fn('arrow_uv_step', { m: vec4fT, dir_uv: vec2fT, px: f32T }, (a) => {
  // A SAFE normalize, not the builtin: a land or nodata cell packs exactly (0, 0), and
  // `normalize` of a zero vector is a NaN that propagates into the position — a glyph at an
  // undefined screen coordinate, which some drivers rasterize as a full-screen triangle. The
  // guarded form returns a zero step there, so the glyph simply does not advance.
  const n = Let(max(length(a.dir_uv), f32(1e-9)))
  const u = Let(vec2(a.dir_uv.x.div(n), a.dir_uv.y.div(n)))
  const s = Let(arrow_uv_to_px(a.m, u))
  return u.mul(a.px.div(max(length(s), f32(1e-6))))
})

/** Every function this module contributes, in dependency order. A consumer splices these AFTER
 *  `getGpuProjectionFuncs()` and `UNPROJECT_FUNCS`. */
export const ARROW_VIEW_FUNCS = [
  arrow_seed_ndc.decl,
  arrow_ground_hit.decl,
  arrow_screen_lonlat.decl,
  arrow_grid_uv.decl,
  arrow_uv_basis.decl,
  arrow_uv_step.decl,
]
