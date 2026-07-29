// ═══ The per-frame write behind the screen-lattice arrow field (#1520 step 2) ═══
//
// `arrow-view.ts` declares what the advected arrow VS needs to answer "what geography is under this
// screen node?"; this is the half that fills it in. Everything precision-critical happens HERE, in
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
import { EARTH_R, localFrame } from '@xgis/geo'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { arrowViewU, ARROW_TRAIN_GLYPHS, ARROW_LATTICE_FACTOR } from '../shaders/dsl/arrow-view'

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

/** The screen lattice this frame: how many seed columns/rows, and how many instances that is.
 *
 *  `nx·ny·G` instances, decided per FRAME. That is the property the whole rewrite exists for —
 *  the count used to be baked into a per-cell buffer, which is why the field expired at z17. */
export function arrowLatticeFor(
  canvasWidth: number,
  canvasHeight: number,
  basePx: number,
): { nx: number; ny: number; instanceCount: number } {
  const spacing = Math.max(basePx * ARROW_LATTICE_FACTOR, 1)
  const nx = Math.max(1, Math.ceil(canvasWidth / spacing))
  const ny = Math.max(1, Math.ceil(canvasHeight / spacing))
  return { nx, ny, instanceCount: nx * ny * ARROW_TRAIN_GLYPHS }
}

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

/** Write one advected batch's view block. Returns the instance count the draw must use, or `null`
 *  when the camera has no usable inverse this frame (an orthographic or degenerate matrix) — the
 *  caller draws nothing rather than a lattice built from a divide by zero. */
export function writeArrowViewUniform(
  block: UniformBlockOf<typeof arrowViewU>,
  cam: ArrowViewCamera,
  grid: ArrowViewGrid,
  glyph: ArrowViewGlyph,
): number | null {
  const rays = cornerRays(cam.matrix)
  if (!rays) return null
  const { dirs, eye } = rays
  const { nx, ny, instanceCount } = arrowLatticeFor(cam.canvasWidth, cam.canvasHeight, glyph.basePx)
  const fr = worldFrame(cam)
  block.write({
    ray_bl: [dirs[0]![0], dirs[0]![1], dirs[0]![2], nx],
    ray_br: [dirs[1]![0], dirs[1]![1], dirs[1]![2], ny],
    ray_tl: [dirs[2]![0], dirs[2]![1], dirs[2]![2], glyph.basePx],
    ray_tr: [dirs[3]![0], dirs[3]![1], dirs[3]![2], glyph.basePx],
    eye: [eye[0], eye[1], eye[2], glyph.strokeUnits],
    // EARTH_R, and NOT `|globeForward(centre)|`, deliberately. The sphere is placed tangent at the
    // world origin (centre = −R·up), so ANY radius keeps it passing through the camera's own
    // ground point — but the hit is turned into lon/lat by `enu_to_lonlat`, which divides by
    // EARTH_R. A different radius here makes the two disagree by the ratio, which is a ~0.3 %
    // SCALE error on the recovered lattice: sub-pixel at every regional zoom, and still a first-
    // order error where the ellipsoid deviation this approximation already accepts is second-
    // order. One constant, both halves.
    up: [fr.up[0], fr.up[1], fr.up[2], EARTH_R],
    east: [fr.east[0], fr.east[1], fr.east[2], cam.centerLon],
    north: [fr.north[0], fr.north[1], fr.north[2], cam.centerLat],
    crs: [grid.originLon, grid.originLat, grid.invSpanLon, grid.invSpanLat],
  })
  return instanceCount
}
