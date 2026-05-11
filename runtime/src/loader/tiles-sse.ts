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

import type { Camera } from '../engine/projection/camera'
import type { Projection } from './../engine/projection/projection'
import { worldCopiesFor, TILE_PX } from '../engine/gpu/gpu-shared'
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
  /** Skip the globe-equivalent horizon cull (for diagnostic rendering
   *  of the full Mercator plane). Default false — horizon cull is on
   *  for Mercator. Non-cylindrical projections always ignore this
   *  flag. */
  disableHorizonCull?: boolean
}

/** Levels of fallback-only ancestor inject. For each emitted tile we
 *  also push its (z-1, z-2) parents flagged `fallbackOnly` so they're
 *  protected from eviction — the renderer uses them when a child slice
 *  hasn't been uploaded yet. Mirrors the existing
 *  `visibleTilesFrustum` semantics so the parent-walk fallback in VTR
 *  works identically with either selector.
 *
 *  Cap at 2 so the inject set stays bounded on Bright-class scenes. */
const FALLBACK_PARENT_DEPTH = 2

/** Select visible tiles by screen-space-error. Same return shape as
 *  `visibleTilesFrustum` so callers can swap behind a feature flag.
 *
 *  **Phase 2 (this commit)** — adds world-copy enumeration (camera
 *  spanning antimeridian), margin-aware enlargement (stroke offsets
 *  rendering past tile bounds), and fallbackOnly parent inject for
 *  eviction protection. With these the selector is feature-equivalent
 *  to `visibleTilesFrustum` for Mercator. Phase 3 follow-ups (OBB
 *  cull, globe / non-Mercator projections, latitude clamp) ship later. */
export function visibleTilesSSE(
  camera: Camera,
  projection: Projection,
  maxZ: number,
  canvasWidth: number,
  canvasHeight: number,
  extraMarginPx: number = 0,
  dpr: number = 1,
  opts: VisibleTilesSSEOptions = {},
): TileCoord[] {
  // Pitch-aware target SSE. The DEFAULT_TARGET_SSE_PX of 4 is tuned
  // for low-to-medium pitch where horizon doesn't blow up the visible
  // set. At pitch ≥ 60° the foreshortened ground stretch produces
  // many far-distance tiles whose per-draw overhead dominates GPU
  // pass time on mobile (and is non-trivial on desktop). Easing
  // target SSE in that band coarsens horizon LOD without affecting
  // the foreground (foreground SSE stays high regardless of target,
  // so subdivision still proceeds). Empirical sweep at 2026-05-11
  // (osm_style Manhattan z=16.18 pitch=77.2° desktop): target=4 →
  // 170 tiles, target=12 → ~110 tiles. ~35 % drop with no visible
  // detail loss in the foreground.
  const baseTarget = opts.targetSSEPx ?? DEFAULT_TARGET_SSE_PX
  const pitchDeg = (camera.pitch ?? 0)
  // Smooth ramp from base→3× at pitch [60°..80°]; capped at 16 so
  // nearer tiles still subdivide. Below 60° unchanged.
  let targetSSE = baseTarget
  if (opts.targetSSEPx === undefined && pitchDeg > 60) {
    const t = Math.min(1, (pitchDeg - 60) / 20)
    targetSSE = Math.min(16, baseTarget * (1 + t * 2))
  }
  const maxEmitted = opts.maxEmitted ?? MAX_EMITTED

  // Camera altitude in Mercator metres — derived from the CSS-pixel
  // viewport (matches camera.ts:120 — must stay DPR-invariant so the
  // selector and renderer compute the same world view).
  const cssHeight = canvasHeight / dpr
  const halfFovRad = (FOV_DEG * Math.PI / 180) / 2
  const tanHalfFov = Math.tan(halfFovRad)
  const metersPerPixelGround = (EARTH_CIRC_M / TILE_PX) / Math.pow(2, camera.zoom)
  const viewHeightMetersGround = cssHeight * metersPerPixelGround
  const altitude = viewHeightMetersGround / 2 / tanHalfFov

  const camMx = camera.centerX
  const camMy = camera.centerY

  // ── Globe-equivalent horizon culling for flat Mercator ──
  // Cesium's pitch=80° performance comes mostly from the globe SHAPE:
  // the spherical surface curves below the camera horizon, naturally
  // bounding the tile count. For our flat Mercator the math says
  // "infinity past the far plane" → we'd recurse a 1300-tile strip
  // along the horizon. The remedy is to BORROW the globe's horizon
  // for cull purposes: any tile whose closest-point distance from
  // camera exceeds the equivalent-altitude horizon distance is
  // skipped, because on a real Earth that tile would be occluded.
  //
  //   horizon_distance ≈ √(2 × R × altitude)    (small h vs R)
  //
  // For altitude=9180 m (z=14 view), this is ~342 km — well past the
  // visually-relevant area. We add a small safety margin so legitimate
  // pitched horizons still render. Originally 2× (~684 km at z=14
  // view), but measurement on 2026-05-11 showed the user-visible
  // ground extent at extreme pitch+zoom (Manhattan z=16 pitch=77°) is
  // ~58 km vs the globe horizon ~163 km — the 2× margin was 2× more
  // than even the WIDEST realistic pitched view could fetch. Tightened
  // to 1.2× = 20 % buffer past the globe horizon, which still covers
  // pan-during-fetch overshoot at 60 fps with comfortable headroom
  // (worst-case per-frame pan ≪ 1 % of horizon distance). Non-
  // cylindrical projections (ortho, azimuthal_equidistant,
  // stereographic) handle horizon culling through their own backface
  // logic; we only apply this cap on Mercator + equirect, where the
  // math otherwise lets the strip grow unboundedly. Disable via
  // `opts.disableHorizonCull` for diagnostic rendering.
  const projType = projection.name === 'mercator' ? 0 : 1
  const horizonCullActive = projType === 0 && !opts.disableHorizonCull
  const earthR = 6378137
  const horizonDist = horizonCullActive
    ? 1.2 * Math.sqrt(2 * earthR * Math.max(altitude, 1))
    : Infinity

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
  //
  // `extraMarginPx` widens the off-screen test so tiles whose data
  // lies just outside the viewport but whose RENDERED geometry reaches
  // back into view (e.g. via stroke-offset, halo, dilated patterns)
  // are still selected.
  const margin = extraMarginPx
  // Sub-pixel cull threshold. At high pitch the SSE selector emits
  // horizon tiles at z=8-9 with screen-space AABBs as small as 1-2
  // pixels per side — they pay full draw-call + per-vertex cost on
  // the GPU but contribute essentially zero visible detail. Culling
  // tiles whose screen AABB is below `MIN_TILE_SCREEN_AREA_PX_SQ`
  // drops the tile count dramatically at extreme pitch with no
  // visual loss (the contribution was already invisible). Threshold
  // is a square: 4 = 2×2 px is the lowest reliable AA threshold;
  // anything smaller renders effectively as a single pixel after
  // MSAA / SDF anti-aliasing kicks in. The under-camera tile
  // (camMx/camMy inside the tile bbox) skips this check so the root
  // tile at z=0 always passes regardless of pitch.
  const MIN_TILE_SCREEN_AREA_PX_SQ = 4
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
    let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity
    let cornersOnScreen = 0
    for (const c of corners) {
      if (!c) continue
      allBehind = false
      cornersOnScreen++
      if (c[0] >= -margin) allLeft = false
      if (c[0] <= canvasWidth + margin) allRight = false
      if (c[1] >= -margin) allTop = false
      if (c[1] <= canvasHeight + margin) allBottom = false
      if (c[0] < minSx) minSx = c[0]
      if (c[0] > maxSx) maxSx = c[0]
      if (c[1] < minSy) minSy = c[1]
      if (c[1] > maxSy) maxSy = c[1]
    }
    if (allBehind) return false
    if (allLeft || allRight || allTop || allBottom) return false
    // Sub-pixel cull. Only apply when ALL FOUR corners projected
    // (cornersOnScreen === 4) — partial-projection (some corners
    // behind camera, returned null) means the AABB is unreliable
    // and we'd risk culling a legitimately-visible tile whose other
    // half is in front. Conservatively keep partial-projection
    // tiles so the existing edge-cull path handles them.
    if (cornersOnScreen === 4) {
      const screenAreaPx2 = (maxSx - minSx) * (maxSy - minSy)
      if (screenAreaPx2 < MIN_TILE_SCREEN_AREA_PX_SQ) return false
    }
    return true
  }

  const result: TileCoord[] = []
  // De-dup parent injects across world-copies and across primary tiles
  // — the parent of a NE quadrant child and its SW sibling can be the
  // same coord; without dedup the renderer ends up drawing the same
  // ancestor twice.
  const injectedParents = new Set<number>()
  const parentKey = (z: number, x: number, y: number, worldCopy: number): number =>
    // Pack (worldCopy, z, x, y) into a 53-bit number for Set lookup.
    // worldCopy fits ±10 (overhead bits), z ≤ 22 (5 bits), x/y ≤ 2^22.
    ((worldCopy + 16) * 32 + z) * (1 << 22) * (1 << 22) + x * (1 << 22) + y

  // DFS. `n` = 2^z = number of tiles per side at this level. The
  // mercator x range is shifted by `worldCopy * EARTH_CIRC_M` so a
  // single DFS pass can be driven from each world copy's root.
  const visit = (z: number, x: number, y: number, worldCopy: number): void => {
    if (result.length >= maxEmitted) return

    const n = 1 << z
    const tileSize = EARTH_CIRC_M / n
    const xOffset = worldCopy * EARTH_CIRC_M
    const mxMin = -PI_R + x * tileSize + xOffset
    const mxMax = mxMin + tileSize
    const myMax = PI_R - y * tileSize
    const myMin = myMax - tileSize

    // ALWAYS descend the root (z=0): a worldCopy != 0 root may have all
    // corners off-screen behind/beside the camera even when its
    // children straddle the viewport. The frustum-cull approximation
    // only converges at higher z when corners are closer to the
    // camera. Root has 4 children → 4 extra tile-visible tests, cheap.
    if (z > 0 && !tileVisible(mxMin, myMax, mxMax, myMin)) return

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
    const groundDist = Math.sqrt(dx * dx + dy * dy)
    // Horizon cull: tile whose closest-point ground distance exceeds
    // the equivalent-globe horizon is skipped (would be hidden by
    // Earth curvature on a real sphere). Massive savings at high
    // pitch — pitch=80° z=14 Tokyo dropped from 1331 → ~300 tiles.
    if (groundDist > horizonDist) return
    const distance = Math.sqrt(groundDist * groundDist + dz * dz)

    // Geometric error: error introduced by stopping at this tile vs
    // its children. Standard convention: `tile_meters / TILE_PX` (one
    // pixel-equivalent of detail in mercator metres at this zoom).
    // TILE_PX = 512 to match Mapbox / MapLibre tile-pyramid convention.
    const geometricError = tileSize / TILE_PX

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
        const ccx = -PI_R + (cx + 0.5) * childTileSize + xOffset
        const ccy = PI_R - (cy + 0.5) * childTileSize
        const cdx = ccx - camMx, cdy = ccy - camMy
        children.push({ cx, cy, idx: cdx * cdx + cdy * cdy })
      }
      children.sort((a, b) => a.idx - b.idx)
      for (const c of children) visit(z + 1, c.cx, c.cy, worldCopy)
    } else {
      // Emit at this level. `ox = x + worldCopy * 2^z` per the
      // TileCoord absolute-x contract (see loader/tiles.ts:39).
      result.push({ z, x, y, ox: x + worldCopy * n })

      // fallbackOnly parent inject — push (z-1, z-2) parents flagged
      // `fallbackOnly` so eviction protects them. Renderer routes
      // these through the fallback path (clipped to children's bounds)
      // when the primary slice hasn't uploaded yet. De-duped via
      // `injectedParents` so the SAME coord across siblings doesn't
      // emit twice.
      let pz = z, px = x, py = y
      for (let depth = 0; depth < FALLBACK_PARENT_DEPTH && pz > 0; depth++) {
        pz -= 1; px >>>= 1; py >>>= 1
        const k = parentKey(pz, px, py, worldCopy)
        if (injectedParents.has(k)) break
        injectedParents.add(k)
        result.push({
          z: pz, x: px, y: py,
          ox: px + worldCopy * (1 << pz),
          fallbackOnly: true,
        })
      }
    }
  }

  // Run the DFS from each world copy's root. `projType` was computed
  // earlier (alongside the horizon-cull setup); for non-Mercator the
  // worldCopiesFor array collapses to `[0]` so this is a single
  // iteration.
  const worldCopies = worldCopiesFor(projType)
  for (const wc of worldCopies) {
    visit(0, 0, 0, wc)
  }
  return result
}
