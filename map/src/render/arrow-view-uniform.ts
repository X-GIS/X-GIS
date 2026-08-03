// ═══ The per-frame write behind the advected arrow field (#1520 step 2, #1534) ═══
//
// `arrow-view.ts` declares what the advected arrow VS needs to place a ground node on screen and
// read the geography there; this is the half that fills it in. Everything precision-critical happens HERE, in
// f64, because that is the whole reason the shader gets four corner rays instead of a matrix:
// `geo/src/globe.ts:358` measured an f32 MVP inverse at ~1 m, "~8 px at screen centre and tens of
// px under motion at z17+". f64 on the CPU costs nothing and the trap never reaches the GPU.
//
// ── WHAT IS DERIVED FROM THE MATRIX RATHER THAN FROM A CONVENTION ─────────────────────────────
//
// The corner rays AND the eye both come out of the same inverse, so neither can disagree with the
// matrix the forward path renders through. The eye in particular is NOT assumed: #1520's plan said
// "the MVP's world space is ENU at the camera" and both halves are wrong —
// `buildECEFFrameView` anchors the world at the camera's GROUND point (the eye is `alt` away along
// the pitched axis) and `buildGlobeMatrix`'s RTC variant is focus-relative with ECEF-PARALLEL axes.
// A perspective matrix sends its eye to `w_clip = 0`, so the eye is recovered by walking each
// corner ray to that plane — one line, exact, and true for every convention.
//
// The one thing that IS read from the render path's own branch is the local FRAME (zenith / east /
// north as world-space vectors), because the two 3D matrices genuinely differ there and no
// arithmetic on the composed MVP recovers it. It mirrors `getViewForProjection`'s selector, which
// `camera.ts:788` already names as the place the matrix and the shader branch stay in lockstep.

import { invert4x4, mulVec4 } from '@xgis/shared'
import { localFrame, globeForward, getProjection, SELECTOR_PROJ_NAMES } from '@xgis/geo'
import { EARTH } from '@xgis/shared'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import {
  arrowViewU,
  ARROW_TRAIN_GLYPHS,
  ARROW_LATTICE_FACTOR,
  ARROW_MAX_GROUND_NODES,
} from '../shaders/dsl/arrow-view'

/** The coverage's grid box, as the affine map `uv = (lonlat − origin) · invSpan`.
 *
 *  GEOGRAPHIC COVERAGES ONLY, and that is a stated scope rather than an oversight: a projected
 *  coverage CRS (#1366 INC-3) would need that CRS's own forward IN THE SHADER to turn a recovered
 *  lon/lat into grid-uv, which is a second projection ladder. Those fall back to the static
 *  `| arrow` catalogue portrayal, and `coverage-arrow-show.ts` asserts the fallback so it cannot
 *  rot into a silent blank. */
export interface ArrowViewGrid {
  /** lon/lat of grid-uv (0, 0) — the grid's NORTH-WEST node, matching the origin convention the
   *  velocity textures are packed in (`u = col/(n−1)`, `v = row/(n−1)`, row 0 northernmost). */
  originLon: number
  originLat: number
  /** Reciprocal spans. `invSpanLat` is NEGATIVE: grid-v runs southward, and folding that sign into
   *  the reciprocal is what keeps it from becoming a branch somebody has to remember to keep in
   *  step with the packer. */
  invSpanLon: number
  invSpanLat: number
}

/** The camera half — everything that does not depend on which coverage is being drawn. */
export interface ArrowViewCamera {
  /** The MVP the frame is actually rendering through (`getViewForProjection().matrix`). */
  matrix: Float32Array
  /** Resolved projType (the promoted one — 7 for a tilted azimuthal). */
  projType: number
  /** True when the 3D orbit camera is active, i.e. `buildGlobeMatrix` produced the matrix. */
  globeMode: boolean
  /** Camera centre, in degrees — the world origin's own geographic position. */
  centerLon: number
  centerLat: number
  /** DEVICE pixels, matching `pointU.viewport`. */
  canvasWidth: number
  canvasHeight: number
  /** Device-pixel ratio — the glyph size and the lattice spacing are both in DEVICE px, so a
   *  hidpi display gets a finer lattice and the field's apparent density is unchanged. */
  dpr: number
}

/** How big a glyph is drawn and how far apart, in DEVICE pixels. */
export interface ArrowViewGlyph {
  /** Base glyph LENGTH (the catalogue's `S111_ARROW_BASE_PX`, pre-multiplied by DPR). */
  basePx: number
  /** Outline stroke, in `loc` units — a fraction of the glyph's own size. */
  strokeUnits: number
}

/** Assemble the camera half from a frame's own inputs.
 *
 *  A function rather than an object literal at the call site because `renderRetained` is at its
 *  LOC ceiling and this is not manager logic — it is the ArrowView block's own contract, including
 *  the one judgement in it: `globeMode` mirrors `getViewForProjection`'s selector, which
 *  `camera.ts:788` names as the place the render matrix and the shader branch stay in lockstep. */
export function arrowViewCamera(
  f: {
    frame: { matrix: Float32Array }
    camera: { globeMode: boolean }
    projType: number
    projCenterLon: number
    projCenterLat: number
    canvasWidth: number
    canvasHeight: number
  },
  dpr: number,
): ArrowViewCamera {
  return {
    matrix: f.frame.matrix,
    projType: f.projType,
    globeMode: f.camera.globeMode,
    centerLon: f.projCenterLon,
    centerLat: f.projCenterLat,
    canvasWidth: f.canvasWidth,
    canvasHeight: f.canvasHeight,
    dpr,
  }
}

let _block: UniformBlockOf<typeof arrowViewU> | null = null
/** Memoized typed pack target for the std140 `ArrowView` struct. */
export function arrowViewBlock(): UniformBlockOf<typeof arrowViewU> {
  return (_block ??= uniformBlock(arrowViewU))
}

/** Canonical `ArrowView` byte size, derived from the reflected layout — so the buffer the store
 *  allocates and the struct the shader reads are sized from ONE declaration. */
export function arrowViewUniformBytes(): number {
  return arrowViewBlock().byteLength
}

/** The largest power of two that does not exceed `v`.
 *
 *  POWERS OF TWO are what make the lattice stable, and both halves are needed. The anchor is a
 *  multiple of the step, so panning at a fixed zoom changes WHICH nodes are enumerated and never
 *  where one of them is; and a zoom that crosses an octave halves the step, so every surviving node
 *  stays exactly where it was and keeps its phase. A continuous step would drift with every frame of
 *  a pan (the step is read at the view centre, which moves) and re-roll every phase with it — the
 *  boil the jitter exists to prevent.
 *
 *  AT MOST, not nearest. Rounding to nearest lets the step land up to √2 above the wanted spacing on
 *  each axis, which is half the nodes over an area: MEASURED at 90×58 px against the 68 the
 *  portrayal asks for, 120 nodes where the screen lattice drew 154, and it broke four render gates
 *  at once (#1534). Taking the octave below instead makes the field never SPARSER than the spacing
 *  asked for — at worst denser, up to one octave per axis, which reads as arrows drawn end to end
 *  rather than as water with no current in it. */
const pow2AtMost = (v: number): number => 2 ** Math.floor(Math.log2(Math.max(v, 1e-30)))

/** Unproject one NDC point at a given clip depth through the f64 inverse. */
function unprojectNdc(
  inv: Float64Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const p = mulVec4(inv, [x, y, z, 1])
  const w = p[3]! || 1e-30
  return [p[0]! / w, p[1]! / w, p[2]! / w]
}

/** `w_clip` of a world point under the forward matrix — zero exactly at the eye. */
function clipW(m: ArrayLike<number>, p: readonly [number, number, number]): number {
  return m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!
}

/** The four corner rays and the eye they share, all in the MVP's own world space.
 *
 *  A perspective projection sends the eye to `w_clip = 0`, and `w_clip` is affine along a ray, so
 *  the eye is `near + t·d` for the `t` that zeroes it. Solved on the bottom-left ray and reused for
 *  all four — they are the same point by construction, which `arrow-view-uniform.test.ts` asserts
 *  rather than assumes. */
function cornerRays(matrix: Float32Array): {
  dirs: [number, number, number][]
  eye: [number, number, number]
} | null {
  const inv = new Float64Array(16)
  if (!invert4x4(matrix, inv)) return null
  const NDC: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]
  const dirs: [number, number, number][] = []
  let eye: [number, number, number] | null = null
  for (const [x, y] of NDC) {
    const near = unprojectNdc(inv, x, y, -1)
    const far = unprojectNdc(inv, x, y, 1)
    const d: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]]
    dirs.push(d)
    if (eye === null) {
      const wn = clipW(matrix, near)
      const wf = clipW(matrix, far)
      const dw = wf - wn
      // |dw| ≈ 0 is an ORTHOGRAPHIC matrix — every ray is parallel and there is no finite eye. The
      // globe's `ortho` arm is a 96× telephoto, not a true parallel projection (`globe.ts:254`
      // explains why), so it still has one; a genuine parallel matrix would need a different
      // formulation and is reported as "no view" rather than silently divided by zero.
      if (Math.abs(dw) < 1e-12) return null
      const t = -wn / dw
      eye = [near[0] + t * d[0], near[1] + t * d[1], near[2] + t * d[2]]
    }
  }
  return eye === null ? null : { dirs, eye }
}

/** The world-space local frame at the world ORIGIN — zenith, east, north.
 *
 *  Two conventions, and the selector is `getViewForProjection`'s own:
 *
 *   • `buildGlobeMatrix`'s RTC variant subtracts the focus point but keeps the ECEF BASIS
 *     (`geo/src/globe.ts:319` — `s`, `u`, `−fwd` are ECEF vectors), so the local frame is the
 *     genuine ECEF tangent frame at the camera centre.
 *   • `buildECEFFrameView` ends its chain with `Renu`, an ECEF→ENU rotation at the camera anchor,
 *     so the world axes ARE east/north/up and the frame is the identity.
 *
 *  Getting this backwards does not produce a broken-looking picture — it produces a field rotated
 *  into a different tangent plane, which reads as arrows pointing at plausible but wrong bearings. */
function worldFrame(cam: ArrowViewCamera): {
  up: [number, number, number]
  east: [number, number, number]
  north: [number, number, number]
} {
  if (!cam.globeMode) return { up: [0, 0, 1], east: [1, 0, 0], north: [0, 1, 0] }
  const f = localFrame(cam.centerLon, cam.centerLat)
  return { up: [...f.up], east: [...f.east], north: [...f.north] }
}

/** The radius of the local sphere the backward map solves against — the ONE number that makes the
 *  approximation osculating rather than merely nearby, and it is NOT `EARTH_R`.
 *
 *  MEASURED, on the round-trip gate: a globe view at z5 recovered its lattice 1.14 px off using the
 *  equatorial radius, and 0.02 px off using this. The cause is a pure SCALE error — the ellipsoid's
 *  radius at lat 38 is ~8 km under the equatorial one, 0.13 %, which over a 3.4e6 m view is 4.4 km
 *  ≈ 1 px. First order, so it does not shrink the way the sphere-vs-ellipsoid SHAPE error does.
 *
 *  Two conventions again, because `up` means different things in the two frames:
 *
 *   • the globe path's `up` is the GEOCENTRIC radial, so the sphere centred `r` below the origin
 *     is centred at the earth's actual centre when `r = |ECEF(centre)|` — the best sphere there is;
 *   • the ENU path's `up` is the ellipsoid NORMAL, which does not pass through the centre, so the
 *     matching sphere is the local osculating one: the Gaussian radius `a√(1−e²)/(1−e²sin²φ)`.
 *
 *  Nothing downstream carries a second radius — `ray_hit_sphere_enu` and `sphere_to_lonlat` both
 *  take it as a parameter, so the hit and the lon/lat it becomes cannot disagree about the sphere
 *  they are on. */
function localRadius(cam: ArrowViewCamera): number {
  if (cam.globeMode) {
    const p = globeForward(cam.centerLon, cam.centerLat)
    return Math.hypot(p[0], p[1], p[2])
  }
  const s = Math.sin((cam.centerLat * Math.PI) / 180)
  return (EARTH.a * Math.sqrt(1 - EARTH.e2)) / (1 - EARTH.e2 * s * s)
}

// ── The GROUND lattice (#1534) ────────────────────────────────────────────────────────────────
//
// The field used to be seeded on a lattice fixed to the SCREEN, so panning slid it over the water.
// #1534 records the measurement and the two approaches that did not work; the one that does is to
// ENUMERATE the ground lattice — one instance per ground node, so nothing collapses two nodes into
// one and nothing is displaced by half a cell.
//
// That needs a way to put a ground node ON SCREEN, and the forward path cannot do it: it needs a
// DSFUN-split geographic anchor to survive at depth (`arrow_uv_basis` records what an f32 forward
// loses), and a lattice node has none. So the node is placed in TWO parts, and neither is an
// approximation the eye can see:
//
//   1. a LINEARIZED ground model, uploaded as a 3×3 homography `uv → clip`. `world → clip` is
//      exactly linear, so the only thing linearized is `uv → world`: the projection's own curvature
//      over the visible span, first order. PITCH IS EXACT — which matters, because pitch is the
//      case an affine screen approximation gets catastrophically wrong.
//   2. ONE NEWTON STEP against the exact backward map, taken in the shader. The residual of (1) is
//      measured by unprojecting the guess and comparing the uv it lands on with the node's own; the
//      correction is that uv error mapped through the basis the glyph is drawn with anyway. It is
//      the same arithmetic, and the same cost, the rejected snap used — but it corrects TOWARD an
//      enumerated node instead of quantising toward the nearest one.
//
// The CPU half is here because it is f64: the model, the step, and the AABB of nodes worth drawing.

/** The visible ground, as a box in grid-uv, plus the lattice enumerated over it. */
export interface ArrowGroundLattice {
  /** Lattice anchor in grid-uv — a multiple of the step, so it does not move when the camera does. */
  anchorU: number
  anchorV: number
  /** Node pitch in grid-uv, a power of two on each axis. */
  stepU: number
  stepV: number
  /** Signed index of the first enumerated node on each axis, relative to the anchor. */
  jx0: number
  jy0: number
  /** Node counts. */
  nx: number
  ny: number
}

/** The 3×3 `(û, v̂, 1) → (clip.x, clip.y, clip.w)` map, row-major, anchored at some uv point. */
type Homography = [number, number, number, number, number, number, number, number, number]

const rad = (d: number): number => (d * Math.PI) / 180

/** One row of the MVP applied to a world point. Column-major, matching `clipW`. */
const clipRow = (m: ArrayLike<number>, r: number, p: readonly number[], pw: number): number =>
  m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]! * pw

/** grid-uv → lon/lat — the exact inverse of the shader's `arrow_grid_uv`. */
function uvToLonLat(grid: ArrowViewGrid, u: number, v: number): [number, number] {
  return [grid.originLon + u / grid.invSpanLon, grid.originLat + v / grid.invSpanLat]
}

/** A grid-uv point's position in the MVP's own world space, EXACTLY — both arms, in f64.
 *
 *  This is the one place the two ground surfaces are stated, and both are stated as the forward the
 *  matrix itself was built from rather than as an inverse of the shader's backward map:
 *
 *   • flat — the world is the projection's own metres with the camera centre subtracted, which is
 *     what `arrow_screen_lonlat` adds back before inverting (`project(pp.yz)`), so the same
 *     `getProjection` record is on both sides of the round trip;
 *   • globe — the world origin sits on the local sphere at the camera centre and the sphere's own
 *     centre is `r` below it along `up`, which is the geometry `ray_hit_sphere_enu` solves. The
 *     direct spherical problem places any other lon/lat on that sphere exactly, at any angular
 *     distance — the same formula `sphere_to_lonlat` inverts, and for the same reason the linearized
 *     form was rejected there (22 px off at a globe view). */
function groundWorldFn(
  cam: ArrowViewCamera,
  grid: ArrowViewGrid,
): (u: number, v: number) => [number, number, number] {
  if (cam.globeMode) {
    const f = localFrame(cam.centerLon, cam.centerLat)
    const r = localRadius(cam)
    const pc = rad(cam.centerLat)
    const sc = Math.sin(pc)
    const cc = Math.cos(pc)
    return (u, v) => {
      const [lon, lat] = uvToLonLat(grid, u, v)
      const dl = rad(lon - cam.centerLon)
      const p = rad(lat)
      const xe = Math.cos(p) * Math.sin(dl)
      const yn = Math.sin(p) * cc - Math.cos(p) * sc * Math.cos(dl)
      const zu = Math.sin(p) * sc + Math.cos(p) * cc * Math.cos(dl)
      return [0, 1, 2].map(
        (k) => r * (xe * f.east[k]! + yn * f.north[k]! + (zu - 1) * f.up[k]!),
      ) as [number, number, number]
    }
  }
  const proj = getProjection(SELECTOR_PROJ_NAMES[cam.projType]!, cam.centerLon, cam.centerLat)
  const c = proj.forward(cam.centerLon, cam.centerLat)
  return (u, v) => {
    const [lon, lat] = uvToLonLat(grid, u, v)
    const p = proj.forward(lon, lat)
    return [p[0] - c[0], p[1] - c[1], 0]
  }
}

/** A central difference of the ground position, WIDENED until it is not degenerate.
 *
 *  Two of the flat projections have a genuine flat spot at their own centre — `azimuthal_equidistant`
 *  and `stereographic` short-circuit `forward` to `[0, 0]` inside ~0.0001 rad (637 m) to avoid a
 *  `0/0`. A secant taken entirely inside it is exactly zero, which collapses the whole model and
 *  paints nothing: measured on projType 4 at z11, where the coverage centre and the projection
 *  centre coincide. Widening is the honest response — the derivative there is not defined, so the
 *  model uses the nearest span over which the surface actually moves. */
function secant(
  ground: (u: number, v: number) => [number, number, number],
  u0: number,
  v0: number,
  du: number,
  dv: number,
  h0: number,
): [number, number, number] {
  let h = h0
  for (let i = 0; i < 8; i++) {
    const p = ground(u0 + du * h, v0 + dv * h)
    const m = ground(u0 - du * h, v0 - dv * h)
    const d = [0, 1, 2].map((k) => (p[k]! - m[k]!) / (2 * h)) as [number, number, number]
    if (Math.hypot(d[0], d[1], d[2]) > 1e-9) return d
    h *= 8
  }
  return [0, 0, 0]
}

/** The linearized `uv → clip` map at `(u0, v0)`.
 *
 *  The tangent directions are central differences of the exact ground position, one lattice step
 *  wide rather than infinitesimally: over the span the model is actually asked about, a secant is a
 *  better fit than a tangent, and it costs the same two evaluations. */
function homographyAt(
  cam: ArrowViewCamera,
  ground: (u: number, v: number) => [number, number, number],
  u0: number,
  v0: number,
  hu: number,
  hv: number,
): Homography {
  const m = cam.matrix
  const o = ground(u0, v0)
  const E = secant(ground, u0, v0, 1, 0, hu)
  const N = secant(ground, u0, v0, 0, 1, hv)
  const rows = [0, 1, 3]
  return rows.flatMap((r) => [
    clipRow(m, r, E, 0),
    clipRow(m, r, N, 0),
    clipRow(m, r, o, 1),
  ]) as Homography
}

/** `(û, v̂) → NDC`, or `null` behind the camera — the CPU twin of the shader's `arrow_node_ndc`. */
function ndcOf(H: Homography, du: number, dv: number): [number, number] | null {
  const w = H[6] * du + H[7] * dv + H[8]
  if (!(w > 1e-9)) return null
  return [(H[0] * du + H[1] * dv + H[2]) / w, (H[3] * du + H[4] * dv + H[5]) / w]
}

/** NDC → `(û, v̂)`, by solving the two linear equations `(H_r − ndc_r·H_w)·(û, v̂, 1) = 0`. Null when
 *  the model is degenerate there or the solution is behind the camera — a screen sample past the
 *  horizon, which contributes no bound rather than an infinite one. */
function uvOf(H: Homography, X: number, Y: number): [number, number] | null {
  const a = H[0] - X * H[6]
  const b = H[1] - X * H[7]
  const c = X * H[8] - H[2]
  const d = H[3] - Y * H[6]
  const e = H[4] - Y * H[7]
  const f = Y * H[8] - H[5]
  const det = a * e - b * d
  if (Math.abs(det) < 1e-30) return null
  const du = (c * e - b * f) / det
  const dv = (a * f - c * d) / det
  return H[6] * du + H[7] * dv + H[8] > 1e-9 ? [du, dv] : null
}

/** How many device pixels one unit of grid-uv spans at the model's anchor, per axis. */
function pxPerUv(H: Homography, w: number, h: number, hu: number, hv: number): [number, number] {
  const o = ndcOf(H, 0, 0)
  const eu = ndcOf(H, hu, 0)
  const ev = ndcOf(H, 0, hv)
  if (!o || !eu || !ev) return [0, 0]
  const px = (a: [number, number], b: [number, number]): number =>
    Math.hypot(((a[0] - b[0]) * w) / 2, ((a[1] - b[1]) * h) / 2)
  return [px(eu, o) / hu, px(ev, o) / hv]
}

/** The AABB, in `(û, v̂)` about the model's anchor, of the ground a `5×5` NDC sample grid reaches.
 *
 *  SAMPLED rather than solved at the four corners, because a pitched view's top corners are past the
 *  horizon and contribute nothing: the interior samples still bound the reachable ground, and the
 *  result is finite where a corner solve would be unbounded. Returns null when no sample reaches the
 *  ground at all — the surface is not visible and there is nothing to seed. */
function visibleUvBox(H: Homography): { u0: number; u1: number; v0: number; v1: number } | null {
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const p = uvOf(H, (i / 4) * 2 - 1, (j / 4) * 2 - 1)
      if (!p) continue
      u0 = Math.min(u0, p[0])
      u1 = Math.max(u1, p[0])
      v0 = Math.min(v0, p[1])
      v1 = Math.max(v1, p[1])
    }
  }
  return u0 <= u1 ? { u0, u1, v0, v1 } : null
}

/** The ground lattice this frame: the node pitch, the anchor it is aligned to, and the index window
 *  over the visible box. Returns null when the coverage is not on screen at all.
 *
 *  THE COUNT IS BOUNDED BY COARSENING, NOT BY TRUNCATING. A near-horizon view sees ground all the
 *  way to the skyline, so the box can hold far more nodes than are worth drawing; halving the
 *  resolution keeps the field UNIFORM (and keeps every surviving node exactly where it was, since
 *  the step stays a power of two), where dropping the tail would end the field on a straight line
 *  across open water. */
function groundLatticeFor(
  cam: ArrowViewCamera,
  grid: ArrowViewGrid,
  ground: (u: number, v: number) => [number, number, number],
  basePx: number,
): ArrowGroundLattice | null {
  const uc = (cam.centerLon - grid.originLon) * grid.invSpanLon
  const vc = (cam.centerLat - grid.originLat) * grid.invSpanLat
  // A probe one thousandth of the domain wide — small enough to be local, wide enough that the
  // difference is not noise on a coordinate the projection has already scaled to metres.
  const probe = 1e-3
  const H0 = homographyAt(cam, ground, uc, vc, probe, probe)
  const box = visibleUvBox(H0)
  if (!box) return null
  const [pu, pv] = pxPerUv(H0, cam.canvasWidth, cam.canvasHeight, probe, probe)
  if (!(pu > 0) || !(pv > 0)) return null

  const want = Math.max(basePx * ARROW_LATTICE_FACTOR, 1)
  let stepU = pow2AtMost(want / pu)
  let stepV = pow2AtMost(want / pv)
  // Clamp the box to the coverage domain BEFORE counting: a view holding the whole world would
  // otherwise size the lattice from ground the batch has no data for.
  const u0 = Math.max(0, Math.min(1, uc + box.u0))
  const u1 = Math.max(0, Math.min(1, uc + box.u1))
  const v0 = Math.max(0, Math.min(1, vc + box.v0))
  const v1 = Math.max(0, Math.min(1, vc + box.v1))
  if (u1 < u0 || v1 < v0) return null

  for (let guard = 0; guard < 32; guard++) {
    const aU = Math.round(uc / stepU) * stepU
    const aV = Math.round(vc / stepV) * stepV
    const jx0 = Math.ceil((u0 - aU) / stepU)
    const jy0 = Math.ceil((v0 - aV) / stepV)
    const nx = Math.floor((u1 - aU) / stepU) - jx0 + 1
    const ny = Math.floor((v1 - aV) / stepV) - jy0 + 1
    if (nx < 1 || ny < 1) return null
    if (nx * ny <= ARROW_MAX_GROUND_NODES) {
      return { anchorU: aU, anchorV: aV, stepU, stepV, jx0, jy0, nx, ny }
    }
    stepU *= 2
    stepV *= 2
  }
  return null
}

/** Write one advected batch's view block. Returns the instance count the draw must use, or `null`
 *  when the camera has no usable inverse this frame (an orthographic or degenerate matrix) or the
 *  coverage's ground is not on screen — the caller draws nothing rather than a lattice built from a
 *  divide by zero. */
export function writeArrowViewUniform(
  block: UniformBlockOf<typeof arrowViewU>,
  cam: ArrowViewCamera,
  grid: ArrowViewGrid,
  glyph: ArrowViewGlyph,
): number | null {
  const rays = cornerRays(cam.matrix)
  if (!rays) return null
  const { dirs, eye } = rays
  const ground = groundWorldFn(cam, grid)
  const lat = groundLatticeFor(cam, grid, ground, glyph.basePx)
  if (!lat) return null
  // Re-anchored on the lattice's OWN anchor, so the node the shader corrects from is the node the
  // model is exact at, and the secant is taken over exactly one step.
  const H = homographyAt(cam, ground, lat.anchorU, lat.anchorV, lat.stepU, lat.stepV)
  const fr = worldFrame(cam)
  block.write({
    ray_bl: [dirs[0]![0], dirs[0]![1], dirs[0]![2], lat.nx],
    ray_br: [dirs[1]![0], dirs[1]![1], dirs[1]![2], lat.ny],
    ray_tl: [dirs[2]![0], dirs[2]![1], dirs[2]![2], glyph.basePx],
    ray_tr: [dirs[3]![0], dirs[3]![1], dirs[3]![2], glyph.basePx],
    eye: [eye[0], eye[1], eye[2], glyph.strokeUnits],
    up: [fr.up[0], fr.up[1], fr.up[2], localRadius(cam)],
    east: [fr.east[0], fr.east[1], fr.east[2], cam.centerLon],
    north: [fr.north[0], fr.north[1], fr.north[2], cam.centerLat],
    crs: [grid.originLon, grid.originLat, grid.invSpanLon, grid.invSpanLat],
    lattice: [lat.stepU, lat.stepV, lat.jx0, lat.jy0],
    hx: [H[0], H[1], H[2], lat.anchorU],
    hy: [H[3], H[4], H[5], lat.anchorV],
    hw: [H[6], H[7], H[8], 0],
  })
  return lat.nx * lat.ny * ARROW_TRAIN_GLYPHS
}

export { groundLatticeFor as arrowGroundLatticeFor, groundWorldFn as arrowGroundWorldFn }
