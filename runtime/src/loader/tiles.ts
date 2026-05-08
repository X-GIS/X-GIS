// ═══ Raster Tile Loader — 웹 맵 타일 로딩 ═══
import { worldCopiesFor } from '../engine/gpu-shared'
import { tileKeyParent } from '@xgis/compiler'

/** Walk from `leafKey` up the quad-tree until the first parent for
 *  which `hasEntry(pk)` returns true, returning that ancestor's key.
 *  Returns -1 when no ancestor up to z=0 is in the index.
 *
 *  Hoisted out of `VectorTileRenderer.renderTileKeys` so the extreme
 *  over-zoom bug (user pans to z=20 while the source maxLevel is 5)
 *  can be CPU-tested without a GPU device. The previous in-place loop
 *  capped at 2 levels, which silently dropped every descendant whose
 *  real parent lived more than 2 levels up — the entire visible set
 *  would miss its prefetch target and render black.
 *
 *  Cap (`MAX_WALK`) mirrors the DSFUN zoom ceiling (22); past that
 *  `tileKeyParent` loses precision.
 *
 *  Complexity: O(z_leaf - z_parent). Typical extreme case at z=20
 *  terminates in 15 iterations per distinct column; Set-based dedup
 *  at the call site avoids the N²ish cost when many descendants share
 *  one ancestor. */
export function firstIndexedAncestor(
  leafKey: number,
  hasEntry: (key: number) => boolean,
): number {
  const MAX_WALK = 22
  let pk = leafKey
  for (let i = 0; i < MAX_WALK && pk > 1; i++) {
    pk = tileKeyParent(pk)
    if (hasEntry(pk)) return pk
  }
  return -1
}

/** A tile coordinate triple — wrapped (x, y) for data lookup, plus
 *  absolute `ox` for world-copy positioning.
 *
 *  CONTRACT — all selectors and consumers MUST follow this:
 *
 *    - `x` is the wrapped tile-x in [0, 2^z). Used to look up data
 *      (catalog key derives from this).
 *    - `ox` is the ABSOLUTE tile-x including world-copy shift. May be
 *      negative or ≥ 2^z when the camera spans the antimeridian.
 *      Equals `x + worldCopy * 2^z` where worldCopy is the integer
 *      offset (… -2, -1, 0, 1, 2 …) of the world copy this tile
 *      belongs to.
 *
 *  The renderer derives the per-tile longitude shift via
 *  `(ox - x) * 360 / 2^z`. If a selector emits `ox` as a small copy
 *  index (e.g. -2..+2) instead of the absolute tile-x, every rendered
 *  tile gets a multi-thousand-degree wrong offset and the canvas
 *  blanks at non-zero zoom — root cause of the commit-71dd401
 *  Phase-2 regression. `ox` is REQUIRED, not optional, so the type
 *  system catches a missing assignment at the source.
 *
 *  See `worldCopyOf(coord)` for the inverse — extract the world-copy
 *  index from a TileCoord. */
export interface TileCoord {
  z: number
  x: number
  y: number
  ox: number
}

/** World-copy index (-2..+2 typically) of a tile coord. Returns 0 for
 *  the central copy, +1 for east, -1 for west, etc. Inverse of
 *  `ox = x + worldCopy * 2^z`. */
export function worldCopyOf(coord: TileCoord): number {
  return Math.floor(coord.ox / Math.pow(2, coord.z))
}

/** Build a TileCoord with the absolute-x contract pre-computed. Use
 *  this from any new selector to ensure the contract holds. */
export function makeTileCoord(z: number, wrappedX: number, y: number, worldCopy: number = 0): TileCoord {
  return { z, x: wrappedX, y, ox: wrappedX + worldCopy * Math.pow(2, z) }
}

export interface LoadedTile {
  coord: TileCoord
  texture: GPUTexture
  // Tile bounds in lon/lat degrees
  west: number
  south: number
  east: number
  north: number
}

/** Calculate tile coordinates from lon/lat bounds and zoom level */
export function visibleTiles(
  centerLon: number,
  centerLat: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  cameraZoom?: number,
  bearing?: number,
  pitch?: number,
): TileCoord[] {
  const z = Math.max(0, Math.min(18, Math.round(zoom)))
  const n = Math.pow(2, z)

  // Center tile
  const cx = Math.floor((centerLon + 180) / 360 * n)
  const cy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)

  // How many tiles fit in viewport — account for overzoom
  // At camera zoom >> tile zoom, each tile covers many screen pixels
  const effectiveZoom = cameraZoom ?? zoom
  const scale = Math.pow(2, effectiveZoom - z) // how many screen-tile-sizes per actual tile
  const tileSize = 256 * scale

  // When the map is rotated, the axis-aligned bounding box of the viewport
  // is larger than the viewport itself. Scale up by the AABB of a rotated rect.
  let effW = viewportWidth
  let effH = viewportHeight
  if (bearing) {
    const rad = Math.abs(bearing * Math.PI / 180)
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    effW = viewportWidth * cos + viewportHeight * sin
    effH = viewportWidth * sin + viewportHeight * cos
  }

  const tilesX = Math.ceil(effW / tileSize / 2) + 1
  let tilesY = Math.ceil(effH / tileSize / 2) + 1

  // Pitch: camera tilted → need more tiles in the "forward" direction
  // Quantize pitch to 5° steps to stabilize tile set (prevents oscillation)
  if (pitch && pitch > 0) {
    const quantizedPitch = Math.ceil(Math.min(pitch, 85) / 5) * 5
    const pitchFactor = 1 / Math.cos(quantizedPitch * Math.PI / 180)
    const extra = Math.ceil(tilesY * (pitchFactor - 1))
    tilesY += Math.min(extra, tilesY * 4)
  }

  const tiles: TileCoord[] = []

  // Wrap cx to [0, n) so world copies are symmetric around the primary world
  const wrappedCx = ((cx % n) + n) % n
  const wrapOffset = cx - wrappedCx  // how many tiles the camera is shifted

  for (let dx = -tilesX; dx <= tilesX; dx++) {
    for (let dy = -tilesY; dy <= tilesY; dy++) {
      const ox = wrapOffset + wrappedCx + dx
      const y = cy + dy
      if (y < 0 || y >= n) continue
      const x = ((ox % n) + n) % n

      // Limit world copies. visibleTiles is invoked from xgvt-source
      // sub-tile generation and the Canvas 2D fallback — both pure
      // Mercator paths — so the Mercator wrap range applies.
      const maxCopies = (worldCopiesFor(0).length - 1) / 2  // mercator → 2
      if (ox < -maxCopies * n || ox >= (maxCopies + 1) * n) continue

      tiles.push({ z, x, y, ox })
    }
  }
  return tiles
}

// ═══ Frustum-based tile selection ═══

import type { Camera } from '../engine/camera'
import type { Projection } from '../engine/projection'

// Mobile GPUs choke on 300 frustum tiles — each tile is a draw call plus
// SDF-shaded line segments. 120 keeps the foreground refined and the
// horizon at a coarse LOD.
// Mobile heuristic: viewport ≤ 900 px wide is the strong signal
// — covers actual phones (390 px) AND Playwright mobile-emulation
// viewports used by the e2e specs (which don't trigger
// matchMedia('pointer: coarse') in headless Chromium). Note we
// evaluate the canvas dimensions PER CALL rather than reading
// `window.innerWidth` once at module load; Playwright sets the
// viewport after import so a top-level constant captures the
// pre-viewport default and miscategorises the test as desktop.
//
// Inputs MUST be CSS-pixel dimensions, not device pixels. A DPR=3
// phone's device-pixel canvas is 1290×2235 — `max > 900` would
// flip it to "desktop" and apply the desktop tile budget. Tile
// count is a logical/perceptual concept (one tile per ~256 CSS
// px) and must stay DPR-invariant; only the rasterised pixel
// count scales with DPR.
function isMobileViewport(cssWidth: number, cssHeight: number): boolean {
  return Math.max(cssWidth, cssHeight) <= 900
}
// Viewport-aware tile budget — replaces the old static cap.
// Density of ~one tile per 12 K pixels keeps drawCalls bounded on
// any viewport: desktop 1280×720 → 76 tiles, mobile 390×844 → 27
// tiles. Floor on mobile is tighter (real iPhones throttle past
// ~60 unique tiles ≈ 240 drawCalls).
const MAX_FRUSTUM_TILES_CEILING = 300
function maxFrustumTilesFor(cssWidth: number, cssHeight: number, pitchDeg: number = 0): number {
  // Mobile cap calibrated against actual viewport coverage rather
  // than just thermal budget. The DFS prioritises camera-side tiles,
  // so a too-small cap leaves the viewport edges uncovered (real-
  // device test showed canvas's lower half going black on flat-
  // pitch with cap 5). Floor 12 + divisor 18 K covers a typical
  // 430×715 mobile canvas (cap 14) with margin headroom; cap
  // 12 minimum guarantees corner coverage.
  //
  // Inputs MUST be CSS pixels — not device pixels. Device pixels
  // would inflate the budget by DPR² (9× on a DPR=3 phone), but
  // the number of tiles needed to cover a viewport is the same
  // regardless of how densely each tile is rasterised.
  //
  // PITCH SCALE. At flat top-down, viewport AABB is compact and
  // ~9 tiles cover everything. Tilt to 70° and the same screen
  // shows foreground at z=N PLUS a long horizon strip whose
  // coverage demands many low-z tiles. Without scaling, DFS
  // burns the whole budget on camera-side subdivisions and the
  // horizon goes white — measured on iPhone z=15 pitch=71° before
  // the merge-pass landed (drawn z=12 only 1 unique tile across
  // 13 layers). 2× / 4× multipliers match the pitch bands the
  // DFS already uses for its margin formula at line ~395, so the
  // budget grows in lockstep with the visible horizon area. The
  // ~3× draw-call reduction from the auto-merge (61.5 % fold on
  // OSM-style) leaves enough headroom for the bigger budget at
  // high pitch without exceeding the 16.7 ms 60 fps target.
  const isMobile = isMobileViewport(cssWidth, cssHeight)
  const baseFloor = isMobile ? 12 : 60
  const divisor = isMobile ? 18000 : 12000
  const pitchMul = pitchDeg >= 60 ? 4 : pitchDeg >= 30 ? 2 : 1
  const floor = Math.round(baseFloor * pitchMul)
  return Math.max(
    floor,
    Math.min(MAX_FRUSTUM_TILES_CEILING, Math.round((cssWidth * cssHeight) / divisor) * pitchMul),
  )
}

/** Quadtree-based visible tile selection.
 *  Recursively subdivides from z=0, using screen-space tile size to determine LOD.
 *  Near tiles get high zoom, far tiles get low zoom — natural perspective LOD.
 *
 *  `extraMarginPx` widens the "overlaps viewport" test so tiles whose
 *  centerline data is off-screen but whose RENDERED geometry reaches
 *  back into the viewport (e.g. via stroke-offset) are still selected.
 *  Callers compute the needed margin from layer state (max
 *  stroke-offset + half stroke-width) and pass it in; default 0
 *  preserves the existing culling envelope. */
export function visibleTilesFrustum(
  camera: Camera,
  projection: Projection,
  maxZ: number,
  canvasWidth: number,
  canvasHeight: number,
  extraMarginPx: number = 0,
  /** Device-pixel-ratio of the canvas backing buffer relative to CSS
   *  pixels. **MVP must be built from device dims to MATCH the
   *  rendering pass** (which uses `camera.getFrameView(canvas.width,
   *  canvas.height)`) — feeding CSS dims here makes the camera
   *  altitude DPR× different and tile-corner cull diverges from
   *  what's actually drawn (visible artefact: viewport tiles flash
   *  white while the selector chases a higher-zoom set the renderer
   *  never asked for).
   *
   *  Only the *perceptual* knobs (tile budget, mobile classification,
   *  subdivide threshold floor) divide by dpr — those control "how
   *  many tiles cover the screen" and should stay DPR-invariant. */
  dpr: number = 1,
): TileCoord[] {
  const cssWidth = canvasWidth / dpr
  const cssHeight = canvasHeight / dpr
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  // MVP from device dims + dpr — `_buildRTCMatrix` divides height by
  // `dpr` for the altitude term so the camera position is CSS-pixel-
  // anchored (DPR-invariant). Aspect ratio (`canvasW/canvasH`) is
  // already DPR-invariant since both dims scale equally. The renderer
  // passes the same dpr to `getFrameView`, so cull projection and
  // rasterisation projection produce the same screen positions.
  const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight, dpr)
  const camMercX = camera.centerX
  const camMercY = camera.centerY
  // Non-Mercator projections render a single world (no lon-periodic
  // wrap); skip enumerating ±N copies to avoid 5× wasted tile selection
  // + downstream draws. See worldCopiesFor() in gpu-shared.ts.
  const projType = projection.name === 'mercator' ? 0 : 1
  const maxCopies = (worldCopiesFor(projType).length - 1) / 2
  // Subdivide cut-off: a tile crosses this many on-screen pixels →
  // descend into its 4 children. Threshold is in DEVICE pixels (matches
  // toScreen output) but the perceptual floor "320 CSS px" is multiplied
  // by `dpr` so a DPR=3 phone needs the tile to span 960 device px (= 320
  // CSS px) before subdividing — same perceptual cut-off as DPR=1, no
  // accidental over-subdivision on retina.
  // The half-shorter-edge term is already DPR-proportional (both
  // dimensions scale with dpr) so the proportion stays the same.
  const SUBDIVIDE_THRESHOLD = Math.max(320 * dpr, Math.min(canvasWidth, canvasHeight) * 0.5)
  // Hoisted so the camera-tile-guarantee inject below can gate on
  // pitch (low pitch DFS already covers the foreground; the inject
  // is only needed at high pitch where quadrant order matters).
  const pitchDegFn = camera.pitch ?? 0
  // Tile budget remains in CSS pixels — perceptual quantity, must
  // stay DPR-invariant so a phone doesn't load 9× more tiles for
  // the same logical viewport. Pitch-scaled because high-pitch
  // views demand more low-z horizon tiles on top of the foreground.
  const MAX_FRUSTUM_TILES = maxFrustumTilesFor(cssWidth, cssHeight, pitchDegFn)
  if ((globalThis as { __DBG_FRUSTUM?: boolean }).__DBG_FRUSTUM) {
    console.log(`[FRUSTUM cap] canvas=${canvasWidth}×${canvasHeight} (css ${cssWidth}×${cssHeight} dpr=${dpr}) mobile=${isMobileViewport(cssWidth, cssHeight)} cap=${MAX_FRUSTUM_TILES} pitch=${pitchDegFn.toFixed(1)}`)
  }

  // Project Mercator coords → screen pixel (returns null if behind camera)
  const toScreen = (mx: number, my: number): [number, number] | null => {
    const rx = mx - camMercX, ry = my - camMercY
    const cw = mvp[3] * rx + mvp[7] * ry + mvp[15]
    if (cw <= 1e-6) return null
    const cx = mvp[0] * rx + mvp[4] * ry + mvp[12]
    const cy = mvp[1] * rx + mvp[5] * ry + mvp[13]
    return [(cx / cw + 1) * 0.5 * canvasWidth, (1 - cy / cw) * 0.5 * canvasHeight]
  }

  // Lon/lat → Mercator meters
  const lonToMerc = (lon: number) => lon * DEG2RAD * R
  const latToMerc = (lat: number) => {
    const cl = Math.max(-85.051, Math.min(85.051, lat))
    return Math.log(Math.tan(Math.PI / 4 + cl * DEG2RAD / 2)) * R
  }

  // Tile y → latitude (north edge)
  const tileYToLat = (y: number, n: number) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI

  // Camera position in lon/lat for "camera inside tile" test below.
  const camLon = (camMercX / R) * (180 / Math.PI)
  const camLat = (2 * Math.atan(Math.exp(camMercY / R)) - Math.PI / 2) * (180 / Math.PI)

  // Unified classify: returns screen-space tile size in px, or -1 if not visible.
  // Handles null corners (behind camera) consistently — a tile with all corners
  // behind camera is treated as "very large" to force subdivision.
  const classifyTile = (tz: number, ox: number, y: number): number => {
    // Low-zoom tiles: projection unreliable for world-scale tiles. Force
    // subdivision when we CAN still subdivide (tz < maxZ). When tz === maxZ
    // and tz <= 3, the subdivide branch in visit() fails and the tile gets
    // pushed without a viewport check — Arctic world-fit at maxZ=3 ended up
    // with 300 tiles (all world copies × all z=3 tiles, clipped by budget)
    // for a viewport that only saw ~5% of the world. Fall through to the
    // 9-sample projection check below so unreachable leaves get culled too.
    if (tz <= 3 && tz < maxZ) return SUBDIVIDE_THRESHOLD + 1

    const tn = Math.pow(2, tz)
    const lonW = ox / tn * 360 - 180
    const lonE = (ox + 1) / tn * 360 - 180
    const latN = tileYToLat(y, tn)
    const latS = tileYToLat(y + 1, tn)

    // Camera inside this tile? At high zoom (tz < camera.zoom), a tile that
    // contains the camera projects with ALL 9 sample points far outside the
    // tiny viewport, so the overlapsViewport check would wrongly cull it.
    // The only reliable signal that the tile must be descended into is
    // "camera lon/lat falls inside the tile's lon/lat bounds". Force
    // subdivision in that case so we eventually reach the leaf tile
    // actually under the camera.
    if (camLon >= lonW && camLon <= lonE && camLat >= latS && camLat <= latN) {
      return SUBDIVIDE_THRESHOLD + 1
    }

    const mw = lonToMerc(lonW), me = lonToMerc(lonE)
    const mn = latToMerc(latN), ms = latToMerc(latS)

    // Sample 9 points: 4 corners + 4 edge midpoints + 1 center. Rotated
    // projections (bearing + pitch) can turn the tile's on-screen shape
    // into a quadrilateral whose 4-corner AABB misses part of its true
    // coverage. Extra samples catch straddle cases where one edge passes
    // through the viewport while the 4 corners are on one side.
    const mmid_h = (mw + me) * 0.5
    const mmid_v = (mn + ms) * 0.5
    const corners = [
      toScreen(mw, ms), toScreen(me, ms), toScreen(me, mn), toScreen(mw, mn),
      toScreen(mmid_h, ms), toScreen(me, mmid_v), toScreen(mmid_h, mn), toScreen(mw, mmid_v),
      toScreen(mmid_h, mmid_v),
    ]
    let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity
    let validCount = 0
    let behindCount = 0
    for (const c of corners) {
      if (!c) { behindCount++; continue }
      validCount++
      if (c[0] < sxMin) sxMin = c[0]
      if (c[0] > sxMax) sxMax = c[0]
      if (c[1] < syMin) syMin = c[1]
      if (c[1] > syMax) syMax = c[1]
    }

    // All corners behind camera — cull.
    // (Previously this forced subdivision in case the tile straddled the
    // near plane, but that caused tiles on the opposite hemisphere to flood
    // the result set with spurious world-copy children at any non-zero
    // pitch. For tz > 3 the tile is small enough that "all corners behind"
    // is a reliable cull signal; partial behind is still handled below.)
    if (validCount === 0) return -1

    // Generous margin for partially-visible tiles, plus any
    // caller-supplied extra margin (e.g. max stroke-offset) so tiles
    // whose data sits outside the strict viewport but whose RENDERED
    // geometry reaches in via offset are still selected.
    //
    // PER-AXIS WITH FLOOR. The previous `Math.max(w, h) * 0.25`
    // shrinks the smaller-axis margin for narrow viewports (iPhone
    // portrait 390×844 got 211 px horizontal margin — not enough
    // at pitch 83.9° where horizon tiles project way off-screen
    // horizontally). Per-axis 25% keeps landscape tile counts
    // identical to the old behaviour while the 192 px floor gives
    // iPhone narrow viewports a reasonable minimum.
    // Keep `max(w, h) * 0.25` for the primary margin (the existing
    // tile-selection-pitch tests pin specific tile-count ranges for
    // landscape viewports under this formula). Add a `floor` that
    // only kicks in when the larger dimension is below ~1024 —
    // iPhone portrait (844) falls into this bucket and gains ~45 px
    // of margin per edge, enough to stop clipping horizon tiles at
    // pitch ≥ 80°.
    // Pitch-aware margin. The original `max(W,H) * 0.25 + floor 256`
    // was tuned for high-pitch (80°+) views where horizon tiles
    // project far off-screen and need a large pad. At top-down /
    // low pitch that same margin pulls 4-5× more tiles than the
    // camera can see — 25 unique drawn at z=14 mobile measurement
    // for what should be ~6.
    //
    // Two scales now: `marginPctOfMax` (the proportional part) and
    // `pitchFloor` (the absolute minimum). Both ramp with pitch.
    // Tile-selection-pitch tests cover 75°+ and pin specific
    // counts under the high-pitch (0.25, 256) values, so those
    // are preserved exactly.
    const marginPctOfMax = pitchDegFn < 30 ? 0.05
      : pitchDegFn < 60 ? 0.15
      : 0.25
    const pitchFloor = pitchDegFn < 30 ? 32
      : pitchDegFn < 60 ? 128
      : 256
    const baseMargin = Math.max(canvasWidth, canvasHeight) * marginPctOfMax
    const margin = Math.max(baseMargin, pitchFloor * dpr) + Math.max(0, extraMarginPx) * dpr
    const overlapsViewport =
      sxMax >= -margin && sxMin <= canvasWidth + margin &&
      syMax >= -margin && syMin <= canvasHeight + margin

    // If any corner is behind camera, we only know the AABB of the VISIBLE
    // corners — the tile's true extent could be larger. Use a GENEROUS
    // margin for the "subdivide maybe" check so we don't miss tiles that
    // straddle the camera near plane with both bearing and pitch applied.
    // Same floor pattern as `margin` above — floor engages for narrow
    // viewports where the 2× multiplier still falls short of the
    // horizon-spill range at extreme pitch.
    const baseWide = Math.max(canvasWidth, canvasHeight) * 2
    const wideMargin = Math.max(baseWide, 2048 * dpr)
    const nearViewport =
      sxMax >= -wideMargin && sxMin <= canvasWidth + wideMargin &&
      syMax >= -wideMargin && syMin <= canvasHeight + wideMargin
    if (behindCount > 0) {
      return nearViewport ? SUBDIVIDE_THRESHOLD * 2 : -1
    }

    if (!overlapsViewport) return -1

    const size = Math.max(sxMax - sxMin, syMax - syMin)
    return Math.max(size, 1) // always > 0 when visible
  }

  const result: TileCoord[] = []

  const visit = (tz: number, x: number, y: number, ox: number): void => {
    if (result.length >= MAX_FRUSTUM_TILES) return
    const tn = Math.pow(2, tz)
    if (y < 0 || y >= tn) return
    if (ox < -maxCopies * tn || ox >= (maxCopies + 1) * tn) return

    const screenPx = classifyTile(tz, ox, y)
    if (screenPx < 0) return // not visible

    // Subdivide if tile is large on screen and we haven't reached max zoom
    if (tz < maxZ && screenPx > SUBDIVIDE_THRESHOLD && result.length + 4 <= MAX_FRUSTUM_TILES) {
      // Visit the child closest to the camera FIRST. Old code walked
      // (NW, NE, SW, SE) in fixed order, which at extreme pitch + the
      // camera in the SE quadrant burned the 300-tile budget on tiles
      // in NW/NE/SW before the camera-side branch ever got descended
      // into. Prioritising the camera-side child guarantees the
      // foreground refines to maxZ before far-side coverage starts
      // pushing on the budget. See fixture-cap-arrow-bug.test.ts for
      // the regression case.
      const childN = tn * 2
      const camChildX = Math.floor((camLon + 180) / 360 * childN)
      const camChildY = Math.floor(
        (1 - Math.log(Math.tan(Math.PI / 4 + Math.max(-85.0511, Math.min(85.0511, camLat)) * DEG2RAD / 2)) / Math.PI) / 2 * childN,
      )
      const idealDx = camChildX <= ox * 2 ? 0 : 1
      const idealDy = camChildY <= y * 2 ? 0 : 1
      // Order: ideal child, its two adjacents, then the diagonal.
      // Adjacent children (share an edge with the ideal) are closer to
      // the camera in either x or y than the diagonal opposite, so this
      // ordering monotonically progresses from "nearest" to "farthest"
      // child in tile-grid space.
      const order: Array<[number, number]> = [
        [idealDx, idealDy],
        [1 - idealDx, idealDy],
        [idealDx, 1 - idealDy],
        [1 - idealDx, 1 - idealDy],
      ]
      for (const [dx, dy] of order) {
        visit(tz + 1, x * 2 + dx, y * 2 + dy, ox * 2 + dx)
      }
      return
    }

    // Always push when visible (avoids gaps from inconsistent size checks)
    result.push({ z: tz, x, y, ox })
  }

  // Start from z=0 for each world copy — BUT iterate from the central world
  // copy outward (0, +1, -1, +2, -2, ...). DFS subdivision greedily consumes
  // MAX_FRUSTUM_TILES; if we walked the leftmost copy first, extreme pitch
  // could burn the entire budget on far-away distant-horizon tiles before
  // the foreground under the camera ever gets refined.
  visit(0, 0, 0, 0)
  for (let k = 1; k <= maxCopies; k++) {
    visit(0, 0, 0, k)
    visit(0, 0, 0, -k)
  }

  // Camera-tile guarantee. At extreme pitch + extreme bearing the DFS
  // budget can be burned by horizon tiles in the three quadrants visited
  // before the camera quadrant (NW → NE → SW → SE). The camera tile and
  // its immediate ring then never get pushed even though they contain the
  // camera and the only data the user is looking at. Repro:
  // fixture-cap-arrow-bug.test.ts (zoom=8.34 / pitch=74.8 / bearing=90).
  //
  // Two fixes vs the original blanket inject:
  //
  //   1. Skip entirely at low pitch. The DFS already produces a complete
  //      camera-region cover when the camera is looking down — there's
  //      no quadrant order risk. The blanket inject was responsible for
  //      mobile flat-pitch 25-tile over-draw measured in the inspector
  //      (cap 5 honoured by DFS, then 25 more tiles pushed past cap by
  //      this loop).
  //
  //   2. Tighten ring 5×5 (25 tiles) → 3×3 (9 tiles). The original
  //      `dy/dx -2..2` reads 5×5 and ships 25 inject tiles per call,
  //      whereas the comment said "9 tiles worst-case". 3×3 covers the
  //      camera tile and its 8 neighbours — enough for the bug-arrow
  //      regression case, half the inject of 5×5.
  // Camera-region inject at maxZ. Bypasses MAX_FRUSTUM_TILES so
  // the camera-area always renders, even when DFS spent the budget
  // on horizon tiles or camera-side children. Two shapes depending
  // on pitch:
  //
  //   pitch < 30°: viewport AABB inject — derived from canvas / tile-
  //                size math, covers exactly the tiles the camera
  //                projects onto. No over-fetch, no gap.
  //
  //   pitch ≥ 30°: fixed 5×5 ring inject around the camera tile.
  //                Perspective makes the AABB calculation invalid
  //                (foreground tile ≠ horizon tile size on screen),
  //                so we fall back to a generous Manhattan ring that
  //                guarantees the foreground+ground renders even
  //                when DFS budget burns on horizon tiles. Required
  //                for fixture-cap-arrow-bug + the filter_gdp 83.9°
  //                ground-renders regression.
  const camN = Math.pow(2, maxZ)
  const camTXf = (camLon + 180) / 360 * camN
  const camLatClamped = Math.max(-85.0511, Math.min(85.0511, camLat))
  const camTYf = (1 - Math.log(Math.tan(Math.PI / 4 + camLatClamped * DEG2RAD / 2)) / Math.PI) / 2 * camN
  let minTX: number, maxTX: number, minTY: number, maxTY: number
  if (pitchDegFn < 30) {
    const tileSizePx = 256 * Math.pow(2, (camera.zoom ?? maxZ) - maxZ)
    const halfTilesX = (cssWidth / 2) / tileSizePx
    const halfTilesY = (cssHeight / 2) / tileSizePx
    minTX = Math.floor(camTXf - halfTilesX)
    maxTX = Math.floor(camTXf + halfTilesX)
    minTY = Math.floor(camTYf - halfTilesY)
    maxTY = Math.floor(camTYf + halfTilesY)
  } else {
    const camTX = Math.floor(camTXf)
    const camTY = Math.floor(camTYf)
    minTX = camTX - 2
    maxTX = camTX + 2
    minTY = camTY - 2
    maxTY = camTY + 2
  }
  const seen = new Set<number>()
  for (const t of result) seen.add((t.z * 4194304 + t.y) * 4194304 + (t.ox + camN))
  for (let ty = minTY; ty <= maxTY; ty++) {
    if (ty < 0 || ty >= camN) continue
    for (let tx = minTX; tx <= maxTX; tx++) {
      // Wrap around the date line — same as world-copy logic above.
      const wrappedX = ((tx % camN) + camN) % camN
      const ox = tx
      const key = (maxZ * 4194304 + ty) * 4194304 + (ox + camN)
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ z: maxZ, x: wrappedX, y: ty, ox })
    }
  }

  // ── PARENT inject for high pitch ──────────────────────────────────
  // The maxZ inject above gets the camera-vicinity z=maxZ tiles into
  // `neededKeys`, which protects them from eviction. But when maxZ
  // exceeds the source archive (e.g. PMTiles maxLevel=15 + camera
  // zoom=15.78 → engine requests z=16), z=maxZ tiles must be sub-tile
  // generated from their z=maxZ-1 parents. If those parents aren't in
  // cache the sub-tile gen fails and the tile falls back two levels
  // deeper (z=maxZ-2), producing the "foreground generalised
  // ancestor blocks" the user reported at Seoul z=15.78 pitch=85°.
  //
  // Empirical evidence in fb8ee9b's diag: the close-camera area
  // rendered from z=14 fallback tiles (red overlay) while the horizon
  // showed correct z=15 primaries. With the 64-tile mobile cap, the
  // wide-pitch DFS easily filled the budget with far/horizon tiles
  // and evicted the close-area z=15 parents — even though their
  // children were in `neededKeys`.
  //
  // Fix: at high pitch, explicitly add the camera-vicinity parents
  // at z=maxZ-1 to `neededKeys` so they're protected too. Only fires
  // at pitch ≥ 30° (the same gate the maxZ inject uses) and when
  // maxZ > 0. Modest size — ⌈(maxRing+1)/2⌉² unique parents,
  // typically 9 tiles for a 5×5 ring. With the cap headroom this
  // costs us ~4-9 protected keys to fix the close-area visual.
  if (pitchDegFn >= 30 && maxZ > 0) {
    const parentZ = maxZ - 1
    const parentN = Math.pow(2, parentZ)
    // Convert min/max child tile bounds to parent tile bounds.
    const pMinTX = Math.floor(minTX / 2)
    const pMaxTX = Math.floor(maxTX / 2)
    const pMinTY = Math.floor(minTY / 2)
    const pMaxTY = Math.floor(maxTY / 2)
    // Separate dedup for parents — different zoom can't collide with
    // child injects above, so a small per-zoom set keeps the keys
    // unambiguous without bumping the existing 64-bit shift math.
    const parentSeen = new Set<number>()
    for (const t of result) {
      if (t.z === parentZ) parentSeen.add((t.y * 4194304) + (t.ox + parentN))
    }
    for (let pty = pMinTY; pty <= pMaxTY; pty++) {
      if (pty < 0 || pty >= parentN) continue
      for (let ptx = pMinTX; ptx <= pMaxTX; ptx++) {
        const wrappedX = ((ptx % parentN) + parentN) % parentN
        const pox = ptx
        const k = (pty * 4194304) + (pox + parentN)
        if (parentSeen.has(k)) continue
        parentSeen.add(k)
        result.push({ z: parentZ, x: wrappedX, y: pty, ox: pox })
      }
    }
  }

  return result
}

/**
 * Tile discovery via SCREEN-SPACE SAMPLE GRID + CORNER UNPROJECT
 * (industry-standard Mapbox GL / MapLibre pattern).
 *
 * Samples a fixed grid of screen points, unprojects each to the
 * ground (Z=0) plane, and collects the tile at the target zoom
 * that each unprojected point falls into. Also dilates by the
 * 8-neighbourhood so the output covers the "between samples"
 * gaps. Returns tiles at ONE zoom level (chosen by caller, usually
 * `round(camera.zoom)`).
 *
 * Why add this alongside `visibleTilesFrustum`:
 *
 *   `visibleTilesFrustum` does mixed-zoom quadtree DFS with per-
 *   tile MVP projection + margin heuristics. The margins depend on
 *   `Math.max(canvasWidth, canvasHeight)` which shrinks the
 *   accept range on narrow viewports (iPhone portrait), culling
 *   horizon tiles at pitch ≥ 80°. Bug repeatedly rediscovered:
 *   2026-04-21 FLICKER on `filter_gdp` demo. Each patch of the
 *   margin formula introduces new edge cases.
 *
 *   This function is ALGORITHMICALLY aspect-ratio-invariant: each
 *   sample's unproject is a geometric truth about the ground
 *   plane, independent of viewport shape. Narrow and wide
 *   viewports both get correct coverage for free.
 *
 * Trade-offs:
 *   + No margin heuristics. No aspect-ratio bug class.
 *   + Matches Mapbox's public algorithm — users get expected
 *     behaviour if they've seen web maps before.
 *   + Simpler to port to GPU compute (single pass over samples).
 *   - Single zoom (no mixed LOD). Tiles near horizon at extreme
 *     pitch may be demanded in large quantities.
 *   - Horizon samples unproject to null; very-high-pitch might
 *     return fewer tiles than the quadtree approach.
 *
 * Caller picks `targetZ`; usually `Math.round(camera.zoom)`.
 */
export function visibleTilesFrustumSampled(
  camera: Camera,
  projection: Projection,
  targetZ: number,
  canvasWidth: number,
  canvasHeight: number,
  _extraMarginPx: number = 0,
  /** Device-pixel-ratio. Forwarded to `unprojectToZ0` so the inverse
   *  MVP it builds uses CSS-pixel altitude — keeps the 9×9 sample
   *  grid landing on the SAME ground positions at any DPR (otherwise
   *  the higher altitude at DPR>1 spreads samples over a 3× wider
   *  ground footprint and inflates the tile set). */
  dpr: number = 1,
): TileCoord[] {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const n = Math.pow(2, targetZ)
  // See parallel comment in visibleTilesFrustum().
  const projType = projection.name === 'mercator' ? 0 : 1
  const maxCopies = (worldCopiesFor(projType).length - 1) / 2

  // 9 × 9 sample grid across the viewport. Denser than Mapbox's
  // default (which uses camera-space frustum corners) — our
  // extreme-pitch use case benefits from more samples along the
  // forward axis. Samples at fractions 0/8, 1/8, ..., 8/8.
  const SAMPLES_PER_AXIS = 9
  const tileSet = new Set<number>() // (x * n + y) * 2^maxCopies + (ox + maxCopies)

  const addTile = (x: number, y: number, ox: number): void => {
    if (y < 0 || y >= n) return
    if (ox < -maxCopies || ox > maxCopies) return
    // Pack (x, y, ox) into a single integer. Use `ox` offset
    // explicitly as the world copy index so wraparound at the
    // antimeridian emits all three copies.
    const key = (ox + maxCopies) * (n * n) + x * n + y
    tileSet.add(key)
  }

  // World-copy aware tile decode. The sample's absolute longitude
  // (computed from raw mercator x) tells us which world copy the
  // ground point is in — Math.floor(absTileFx / n) yields the world-
  // offset (negative = west, positive = east), and the tile-x is the
  // remainder modulo n. Without this, low-zoom mercator demos that
  // show multiple Earth copies side-by-side only emit tiles for the
  // central copy and the East/West copies render blank (regression:
  // smoke vector_categorical / water_hierarchy at zoom 0).
  const decodeAbsTile = (absMx: number, absMy: number): void => {
    const lon = (absMx / R) / DEG2RAD
    const lat = (2 * Math.atan(Math.exp(absMy / R)) - Math.PI / 2) / DEG2RAD
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
    const absTileFx = (lon + 180) / 360 * n
    const tileFy = (1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n
    const tileXFloor = Math.floor(absTileFx)
    const ox = Math.floor(tileXFloor / n)
    const tx = ((tileXFloor % n) + n) % n
    const ty = Math.floor(tileFy)
    addTile(tx, ty, ox)
  }

  // Pin the camera's current tile unconditionally — at extreme pitch
  // the camera's forward ray may miss samples that actually land on
  // it, so include it here. Matches the "camera-foot tile always
  // loaded" invariant the existing animation-coverage tests rely on
  // at low pitch.
  decodeAbsTile(camera.centerX, camera.centerY)

  for (let iy = 0; iy < SAMPLES_PER_AXIS; iy++) {
    const fy = iy / (SAMPLES_PER_AXIS - 1)
    for (let ix = 0; ix < SAMPLES_PER_AXIS; ix++) {
      const fx = ix / (SAMPLES_PER_AXIS - 1)
      const rel = camera.unprojectToZ0(fx * canvasWidth, fy * canvasHeight, canvasWidth, canvasHeight, dpr)
      if (!rel) continue // sample ray misses ground (at/above horizon)
      decodeAbsTile(camera.centerX + rel[0], camera.centerY + rel[1])
    }
  }

  // Unpack. `ox` in the result is the ABSOLUTE tile-x (including
  // world-copy shift) — matches the DFS selector's contract, which
  // the downstream worldOffDeg computation
  // (`(ox - x) * 360 / n`) depends on. Storing `ox` as a small
  // copy-index (-1, 0, 1) here was the root cause of the user-
  // reported "zoom 5+ blank canvas" regression — every tile got a
  // huge wrong longitude offset and rendered off-screen.
  const MAX = MAX_FRUSTUM_TILES_CEILING
  const result: TileCoord[] = []
  for (const key of tileSet) {
    if (result.length >= MAX) break
    const copy = Math.floor(key / (n * n)) - maxCopies
    const rest = key % (n * n)
    const x = Math.floor(rest / n)
    const y = rest % n
    const absOx = x + copy * n
    result.push({ z: targetZ, x, y, ox: absOx })
  }
  return result
}

/** Get lon/lat bounds for a tile */
export function tileBounds(coord: TileCoord): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, coord.z)
  const west = coord.x / n * 360 - 180
  const east = (coord.x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

/** Build tile URL from template */
export function tileUrl(template: string, coord: TileCoord): string {
  return template
    .replace('{z}', String(coord.z))
    .replace('{x}', String(coord.x))
    .replace('{y}', String(coord.y))
}

/** Check if a URL is a tile template */
export function isTileTemplate(url: string): boolean {
  return url.includes('{z}') && url.includes('{x}') && url.includes('{y}')
}

/** Load an image as a GPU texture (supports AbortSignal for cancellation) */
export async function loadImageTexture(
  device: GPUDevice,
  url: string,
  signal?: AbortSignal,
): Promise<GPUTexture | null> {
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const blob = await response.blob()
    if (signal?.aborted) return null
    const bitmap = await createImageBitmap(blob)

    const texture = device.createTexture({
      size: { width: bitmap.width, height: bitmap.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })

    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      { width: bitmap.width, height: bitmap.height },
    )

    bitmap.close()
    return texture
  } catch {
    return null
  }
}

/**
 * Sort tiles by distance from center (closest first → highest priority).
 */
export function sortByPriority(tiles: TileCoord[], centerTileX: number, centerTileY: number): TileCoord[] {
  return tiles.sort((a, b) => {
    // Use original x (ox) for distance — correct for world copies
    const ax = a.ox ?? a.x
    const bx = b.ox ?? b.x
    const da = Math.abs(ax - centerTileX) + Math.abs(a.y - centerTileY)
    const db = Math.abs(bx - centerTileX) + Math.abs(b.y - centerTileY)
    return da - db
  })
}
