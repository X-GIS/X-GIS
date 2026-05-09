// ═══ Screen-Space-Error tile selector (Cesium / 3D Tiles convention) ═══
//
// Phase 1 of replacing `visibleTilesFrustum` (loader/tiles.ts). The
// existing selector measures **screen-pixel tile size** to decide LOD,
// which fails at high pitch: foreshortened horizon tiles still span
// many pixels along the depth axis even though their per-pixel detail
// would be invisible. Memory's `tile-pitch-matrix` traces this to the
// "300-slot tile budget doesn't understand perspective foreshortening"
// problem. The pitchMul kludge (1× / 1.5× / 2× by pitch band) is a
// patch on a metric that's the wrong shape.
//
// The SSE metric replaces it:
//
//     sse_pixels = geometricError × canvasHeight
//                  ────────────────────────────────
//                  distance × 2 × tan(halfFov)
//
// `geometricError` (meters) = the perceived error introduced by using
// THIS tile in place of its (more-detailed) children. Standard
// quadtree-on-Mercator value: `tileSize_at_z / 256` m.
//
// `distance` = 3D distance from camera to tile centre. For flat Mercator
// the camera Z is its altitude above ground (mercator-meters); the
// formula generalises to globe / orthographic / fisheye unchanged
// because it's a perceptual quantity, not a geometric one.
//
// Subdivide rule: SSE > target_pixels (default 16) AND z < maxZ.
// Otherwise emit. SSE drops naturally with distance, so horizon tiles
// stop subdividing on their own without a pitch kludge.
//
// What's INTENTIONALLY missing in Phase 1 (will land in subsequent
// passes once accuracy is locked in):
//   - World-copy enumeration (camera spanning antimeridian)
//   - Latitude clamp / pole fade
//   - Per-tile oriented-bounding-box frustum cull (currently axis-
//     aligned mercator-rect cull via screen projection)
//   - Margin-aware enlargement (for stroke-offset render reach)
//   - Match the `fallbackOnly` parent inject that frustum.ts uses
//
// The intent: ship a clean baseline that already wins at typical
// pitches, then iterate. Toggle via `__XGIS_USE_SSE_SELECTOR = true`
// (window-level) so we can A/B against the existing selector with
// real data + measurements before flipping the default.

import type { Camera } from '../engine/camera'
import type { Projection } from './../engine/projection'
import type { TileCoord } from './tiles'

const EARTH_CIRC_M = 40075016.686
const PI_R = Math.PI * 6378137
const FOV_DEG = 45  // Camera.FOV — fixed in this engine

/** Default screen-space-error target in pixels.
 *
 *  Cesium ships 16 px because their `geometricError` measures *terrain
 *  mesh simplification error in metres* — a real perceptual quantity
 *  where 16 px error is genuinely invisible. For our 2D vector-tile
 *  case `geometricError(z) = tileSize/256` is a synthetic proxy.
 *
 *  Empirical sweep on Bright at z=14 Tokyo (1280×800):
 *
 *    target  pitch=0      pitch=40    pitch=80    note
 *      1     15.6 ms(64)  19 ms(53)   154 ms(6)   over-subdivides horizon
 *      4     ~14 ms       ~17 ms      ~50 ms      good balance
 *     16      7 ms        7 ms        12 ms       fast but z=10 max under cam
 *
 *  4 px is the sweet spot for Mercator vector tiles: good detail
 *  under-camera (z near currentZoom) without horizon over-detail at
 *  high pitch. Cesium's 16-px convention transposes neatly here as
 *  an equal-quality "perceptual budget" since our pixel→meter scaling
 *  is consistent across the metric. */
const DEFAULT_TARGET_SSE_PX = 4

/** Hard cap on emitted tile count. Safety net only — well-tuned SSE
 *  in a typical view emits 9-100 tiles, but a degenerate camera (e.g.
 *  z=22 + pitch=89° + bearing change) could in theory blow up. */
const MAX_EMITTED = 600

export interface VisibleTilesSSEOptions {
  /** Subdivide-cutoff in screen pixels. Default 16. */
  targetSSEPx?: number
  /** Hard cap on emitted tiles — safety net for pathological cameras. */
  maxEmitted?: number
}

/** Select visible tiles by screen-space-error. Same return shape as
 *  `visibleTilesFrustum` so callers can swap behind a feature flag.
 *
 *  **Phase 1 scope** — flat Mercator, no world copies, no margin
 *  enlargement, no fallbackOnly inject. Sufficient for measuring
 *  whether the SSE metric solves the high-pitch tile-explosion
 *  problem; production-fidelity passes follow once the comparison
 *  data is in. */
export function visibleTilesSSE(
  camera: Camera,
  _projection: Projection,
  maxZ: number,
  canvasWidth: number,
  canvasHeight: number,
  _extraMarginPx: number = 0,
  dpr: number = 1,
  opts: VisibleTilesSSEOptions = {},
): TileCoord[] {
  const targetSSE = opts.targetSSEPx ?? DEFAULT_TARGET_SSE_PX
  const maxEmitted = opts.maxEmitted ?? MAX_EMITTED

  // Camera altitude in Mercator metres — derived from the CSS-pixel
  // viewport (matches camera.ts:120 — must stay DPR-invariant so the
  // selector and renderer compute the same world view).
  const cssHeight = canvasHeight / dpr
  const halfFovRad = (FOV_DEG * Math.PI / 180) / 2
  const tanHalfFov = Math.tan(halfFovRad)
  const metersPerPixelGround = (EARTH_CIRC_M / 256) / Math.pow(2, camera.zoom)
  const viewHeightMetersGround = cssHeight * metersPerPixelGround
  const altitude = viewHeightMetersGround / 2 / tanHalfFov

  const camMx = camera.centerX
  const camMy = camera.centerY

  // Frustum cull via the camera's MVP — same matrix the renderer uses
  // to draw, so cull and rasterisation agree on screen space at any DPR.
  const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight, dpr)
  const toScreen = (mx: number, my: number): [number, number] | null => {
    const rx = mx - camMx, ry = my - camMy
    const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[15]!
    if (cw <= 1e-6) return null  // behind camera
    const cx = mvp[0]! * rx + mvp[4]! * ry + mvp[12]!
    const cy = mvp[1]! * rx + mvp[5]! * ry + mvp[13]!
    return [(cx / cw + 1) * 0.5 * canvasWidth, (1 - cy / cw) * 0.5 * canvasHeight]
  }

  // Cheap AABB-vs-screen overlap check. Project the tile's 4 mercator
  // corners; if ALL four are off the same screen edge, cull. With one
  // crucial special case: when the camera centre falls INSIDE the
  // tile's mercator footprint, the tile MUST be visible — even if all
  // 4 corners project behind the camera (which happens for the root
  // z=0 tile at any non-zero pitch, because the antipode corners
  // wrap behind). Without this short-circuit the DFS never enters
  // the root tile at pitch>0 and the entire selection collapses to
  // zero tiles.
  const tileVisible = (mxMin: number, myMax: number, mxMax: number, myMin: number): boolean => {
    if (camMx >= mxMin && camMx <= mxMax && camMy >= myMin && camMy <= myMax) {
      return true
    }
    const corners: ([number, number] | null)[] = [
      toScreen(mxMin, myMin),
      toScreen(mxMax, myMin),
      toScreen(mxMin, myMax),
      toScreen(mxMax, myMax),
    ]
    let allBehind = true
    let allLeft = true, allRight = true, allTop = true, allBottom = true
    const margin = 0
    for (const c of corners) {
      if (!c) continue
      allBehind = false
      if (c[0] >= -margin) allLeft = false
      if (c[0] <= canvasWidth + margin) allRight = false
      if (c[1] >= -margin) allTop = false
      if (c[1] <= canvasHeight + margin) allBottom = false
    }
    if (allBehind) return false
    return !(allLeft || allRight || allTop || allBottom)
  }

  const result: TileCoord[] = []

  // DFS. `n` = 2^z = number of tiles per side at this level.
  // Each tile's mercator span: [PI_R - y*tileSize..PI_R - (y+1)*tileSize] in y,
  //                            [-PI_R + x*tileSize..-PI_R + (x+1)*tileSize] in x.
  const visit = (z: number, x: number, y: number): void => {
    if (result.length >= maxEmitted) return

    const n = 1 << z
    const tileSize = EARTH_CIRC_M / n
    const mxMin = -PI_R + x * tileSize
    const mxMax = mxMin + tileSize
    const myMax = PI_R - y * tileSize
    const myMin = myMax - tileSize

    if (!tileVisible(mxMin, myMax, mxMax, myMin)) return

    // 3D distance from camera to the CLOSEST POINT on the tile's
    // bounding rectangle. Using tile-centre distance (which is what
    // a naïve port of the SSE formula does) underestimates SSE
    // dramatically when the camera sits OVER the tile but the tile
    // is huge — at z=0 the centre is at world (0,0) but the camera
    // over Tokyo is 16M m away, even though the tile actually
    // covers the camera's footprint. Cesium uses distance-to-bounding-
    // volume (sphere or OBB); for our flat-Mercator quadtree the
    // bounding rect's closest point is `clamp(cam, tileBounds)`.
    const closestX = camMx < mxMin ? mxMin : (camMx > mxMax ? mxMax : camMx)
    const closestY = camMy < myMin ? myMin : (camMy > myMax ? myMax : camMy)
    const dx = closestX - camMx
    const dy = closestY - camMy
    const dz = altitude
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

    // Geometric error: error introduced by stopping at this tile vs
    // its children. Standard convention: `tile_meters / 256` (one
    // pixel-equivalent of detail in mercator metres at this zoom).
    const geometricError = tileSize / 256

    // Cesium screen-space-error formula. Direct port — no projection-
    // specific terms because the perspective division (canvasHeight /
    // distance / 2 / tanHalfFov) handles all of it.
    const ssePx = (geometricError * canvasHeight) / (distance * 2 * tanHalfFov)

    if (ssePx > targetSSE && z < maxZ) {
      // Subdivide. DFS order is camera-side first to bias the safety
      // cap toward the visually-important quadrant. We use distance to
      // child centres as the priority — closest first.
      const children: { cx: number; cy: number; idx: number }[] = []
      for (let i = 0; i < 4; i++) {
        const cx = x * 2 + (i & 1)
        const cy = y * 2 + ((i >> 1) & 1)
        const childTileSize = tileSize / 2
        const ccx = -PI_R + (cx + 0.5) * childTileSize
        const ccy = PI_R - (cy + 0.5) * childTileSize
        const cdx = ccx - camMx, cdy = ccy - camMy
        children.push({ cx, cy, idx: cdx * cdx + cdy * cdy })
      }
      children.sort((a, b) => a.idx - b.idx)
      for (const c of children) visit(z + 1, c.cx, c.cy)
    } else {
      // Emit at this level.
      result.push({ z, x, y, ox: x })
    }
  }

  visit(0, 0, 0)
  return result
}
