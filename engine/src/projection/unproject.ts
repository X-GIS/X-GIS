// ═══ Pure screen→world inverse math — extracted from camera.ts (roadmap S9) ═══
//
// INERT refactor: every function here is the byte-identical inverse algebra
// previously inlined in `Camera.unprojectToZ0`, `Camera.unprojectToLonLat`,
// `Camera.unprojectToMercatorAnchor`, and `Camera._relToLonLat`. They are PURE
// — no `this`, no cache shadow state, no preallocated instance buffers. The
// Camera keeps `getRTCMatrixInverse` + the `rtcMatrixInv` buffer + the
// `_invDirty` cache; its wrappers compute/fetch the inverse matrix then pass it
// (a Float32Array) plus an `UnprojectView` scalar snapshot to the functions
// below. This module never recomputes the inverse.
//
// CRITICAL — float-order preservation: the arithmetic here was moved
// character-for-character from camera.ts. The ndc derivation, the matrix-vector
// order, the per-projType branch structure, the null-return conditions, and the
// `rel + cv` / `rel + centerX` compositions are load-bearing for the inverse/
// anchor parity gate (interaction-contract-gates.test.ts). Do NOT reorder,
// re-associate, or "simplify".
//
// This module must NOT import camera.ts (no cycle); camera.ts imports it.
// Mirrors the view-matrix.ts extraction (commit 60e26402).

import { mercatorYToLat, mercator, getProjection } from './projection'
import { EARTH_R } from './globe'
import { SELECTOR_PROJ_NAMES, poleLimit } from './projections-table'
import { mulVec4 } from './camera-helpers'

/** Resolved camera state read by the pure inverse functions. The Camera fills
 *  this from its `this.*` fields (the wrappers pass `this` directly — the class
 *  carries these properties, so structural typing makes the snapshot free). Only
 *  the fields a given function reads are required; callers may pass a superset.
 */
export interface UnprojectView {
  /** Camera centre X in Web Mercator metres. */
  centerX: number
  /** Camera centre Y in Web Mercator metres. */
  centerY: number
  /** Resolved projType (0 mercator / 1 equirect / 2 NE / 3-5 azimuthal /
   *  6 oblique_mercator / 7 globe). */
  projType: number
  /** True 3D globe orbit camera active. */
  globeMode: boolean
}

/** Unproject screen pixel to z=0 world plane (RTC-relative). Pure mirror of the
 *  body of `Camera.unprojectToZ0` (minus its `getRTCMatrixInverse` call, which
 *  the wrapper does and passes in as `inv`). Returns [x, y] in projection meters
 *  relative to camera center, or null if behind horizon. */
export function unprojectToZ0(
  inv: Float32Array,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): [number, number] | null {
  const ndcX = (screenX / canvasWidth) * 2 - 1
  const ndcY = 1 - (screenY / canvasHeight) * 2

  // Ray from near to far plane
  const n = mulVec4(inv, [ndcX, ndcY, -1, 1])
  const f = mulVec4(inv, [ndcX, ndcY, 1, 1])
  // Perspective divide
  const nx = n[0] / n[3],
    ny = n[1] / n[3],
    nz = n[2] / n[3]
  const fx = f[0] / f[3],
    fy = f[1] / f[3],
    fz = f[2] / f[3]

  // Intersect with z=0 plane
  const dz = fz - nz
  if (Math.abs(dz) < 1e-10) return null
  const t = -nz / dz
  if (t < 0) return null // behind camera

  return [nx + t * (fx - nx), ny + t * (fy - ny)]
}

/** Compose an already-unprojected z=0-plane rel coordinate (the projType's
 *  own-plane metres returned by `unprojectToZ0`) into geographic lon/lat. Pure
 *  mirror of `Camera._relToLonLat`. See `unprojectToLonLat` for the per-projType
 *  math + scope. Returns null for projType 3/4/5 (azimuthal discs) and globe
 *  (7); returns the geographic point for mercator (0) and the flat non-merc set
 *  (1/2/6). */
export function relToLonLat(view: UnprojectView, rel: [number, number]): [number, number] | null {
  const pt = view.projType
  if (pt === 0) {
    // Mercator: the camera's z=0 plane IS the Mercator plane (centerX/Y are
    // canonical Mercator metres) — exact, byte-identical to the legacy path.
    return mercator.inverse(rel[0] + view.centerX, rel[1] + view.centerY)
  }
  // Flat non-merc set only (equirectangular 1 / natural_earth 2 /
  // oblique_mercator 6). Disc (3/4/5) + globe (7) are out of scope.
  if (pt !== 1 && pt !== 2 && pt !== 6) return null
  if (view.globeMode) return null
  const clon = (view.centerX / EARTH_R) * (180 / Math.PI)
  // Match render-loop.ts: clamp clat via poleLimit(pt) (projections-table SoT,
  // replacing the Mercator literal) so the CPU inverse centre equals the GPU
  // proj_params.z. pt∈{1,2,6} here + bounded mercatorYToLat input → byte-
  // identical (roadmap S5 inert).
  const clat = Math.max(-poleLimit(pt), Math.min(poleLimit(pt), mercatorYToLat(view.centerY)))
  const proj = getProjection(SELECTOR_PROJ_NAMES[pt], clon, clat)
  // `cv` = the own-plane centre the shader subtracted (project(cam), with NO
  // world offset). For equirect/NE cv.x = 0 (wrap_lon_delta(camLon−clon)=0);
  // for oblique it is the rotated-frame Mercator of the camera.
  const cv = proj.forward(clon, clat)
  return proj.inverse(rel[0] + cv[0], rel[1] + cv[1])
}

/** Unproject a screen pixel to TRUE lon/lat for the flat projType set. Pure
 *  mirror of `Camera.unprojectToLonLat` — composes `unprojectToZ0` (against the
 *  caller-supplied inverse matrix) with `relToLonLat`. Returns null for
 *  projType 3/4/5/globe and when the ray misses the ground plane. */
export function unprojectToLonLat(
  view: UnprojectView,
  inv: Float32Array,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): [number, number] | null {
  const rel = unprojectToZ0(inv, screenX, screenY, canvasWidth, canvasHeight)
  if (!rel) return null
  return relToLonLat(view, rel)
}

/** Unproject a screen pixel to an ABSOLUTE Mercator-metre anchor. Pure mirror of
 *  `Camera.unprojectToMercatorAnchor`. For mercator (0) returns the legacy
 *  `rel + centre`; for the flat non-merc set (1/2/6) composes through the
 *  projType inverse → lon/lat → Mercator. Returns null when the ray misses the
 *  ground or the projType is out of the flat-merc-composer scope (3/4/5/7). */
export function unprojectToMercatorAnchor(
  view: UnprojectView,
  inv: Float32Array,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): [number, number] | null {
  const rel = unprojectToZ0(inv, screenX, screenY, canvasWidth, canvasHeight)
  if (!rel) return null
  if (view.projType === 0) return [rel[0] + view.centerX, rel[1] + view.centerY]
  if (view.projType !== 1 && view.projType !== 2 && view.projType !== 6) return null
  const ll = relToLonLat(view, rel)
  if (!ll) return null
  return mercator.forward(ll[0], ll[1])
}
