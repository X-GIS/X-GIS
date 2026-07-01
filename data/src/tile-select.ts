// ═══ Raster Tile Loader — 웹 맵 타일 로딩 ═══
import { worldCopiesFor, TILE_PX } from '@xgis/engine'

// TileCoord / LoadedTile + the pure tile-math helpers live in sibling modules
// (tile-select-types / tile-select-helpers) and are surfaced by the @xgis/data
// barrel directly, so tile-select no longer re-exports them (that would make the
// names ambiguous under the barrel's `export *`). It only needs TileCoord here.
import type { TileCoord } from './tile-select-types'

// ═══ Frustum-based tile selection ═══

import type { Camera } from '@xgis/engine'
import { type Projection, MERCATOR_LAT_LIMIT, mercatorYToLat } from '@xgis/engine'
import { PROJECTION_NAME_TO_TYPE } from '@xgis/engine'
import { EARTH_R } from '@xgis/engine'
import { safeFetch } from '@xgis/shared'

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
  // Pitch multiplier was 1/2/4 — measured Bright at z=14 pitch=80°
  // selecting 2700+ tiles, hitting 63 ms / frame frame time (16 fps).
  // Mapbox uses ~200-400 tiles for the equivalent view because their
  // selector picks a SINGLE coarse zoom for the horizon strip rather
  // than letting DFS keep subdividing. We can't (yet) match that
  // selector design — but we can clamp the budget hard so drawCall
  // count stays in 60 fps territory: 1.5/2 multiplier instead of 2/4.
  // The horizon strip becomes visibly chunkier (one or two zoom levels
  // coarser) past pitch 60°, which is preferable to a 1-fps freeze.
  const pitchMul = pitchDeg >= 60 ? 2 : pitchDeg >= 30 ? 1.5 : 1
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
   *  rendering pass** (which uses `camera.getECEFFrameView(canvas.width,
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
  const R = EARTH_R
  // MVP from device dims + dpr — `_buildRTCMatrix` divides height by
  // `dpr` for the altitude term so the camera position is CSS-pixel-
  // anchored (DPR-invariant). Aspect ratio (`canvasW/canvasH`) is
  // already DPR-invariant since both dims scale equally. The renderer
  // passes the same dpr to `getECEFFrameView` (post Phase 2 PR 2d.5),
  // so cull projection and rasterisation projection produce the same
  // screen positions.
  const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight, dpr)
  const camMercX = camera.centerX
  const camMercY = camera.centerY
  // Non-Mercator projections render a single world (no lon-periodic
  // wrap); skip enumerating ±N copies to avoid 5× wasted tile selection
  // + downstream draws. See worldCopiesFor() in gpu-shared.ts.
  // Table-ified (PR-A target #3): only {mercator,equirect,natural_earth}
  // reach here and worldCopiesFor(1)===worldCopiesFor(2), so the table
  // lookup is byte-equivalent to the prior `?0:1` for every live input.
  const projType = PROJECTION_NAME_TO_TYPE[projection.name] ?? 0
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
    const cl = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
    return Math.log(Math.tan(Math.PI / 4 + cl * DEG2RAD / 2)) * R
  }

  // Tile y → latitude (north edge)
  const tileYToLat = (y: number, n: number) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI

  // Camera position in lon/lat for "camera inside tile" test below.
  const camLon = (camMercX / R) * (180 / Math.PI)
  const camLat = mercatorYToLat(camMercY)

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

    // Distance-based LOD criterion (MapLibre `covering_tiles.ts` v5.24).
    // Each tile's desired zoom decreases as it moves further from the
    // camera; subdivide while `tz < desiredZ`, emit once `tz >=
    // desiredZ`. This naturally produces a smooth pyramid (foreground
    // gets currentZoom, horizon gets currentZoom - log2(distRatio))
    // without depending on screen-AABB shape, which the prior `max(w,h)`
    // / `min(w,h)` / geomean variants all got wrong on at least one of
    // {desktop, mobile} × {low pitch, high pitch}.
    //
    // `cw` is clip-space w from the MVP matrix == view-axis depth from
    // the camera. Because all rx/ry are world-mercator deltas relative
    // to (camMercX, camMercY) — the viewport-centre-on-ground point —
    // `mvp[15]` is the depth at that centre, and `cw_tile` below is the
    // depth at the tile centre. Their ratio is dimensionless and
    // FOV-invariant, so the desired-zoom shift is the same on a phone
    // and a desktop at equal pitch+camera distance.
    //
    // Reference: see formula in MapLibre's `createCalculateTileZoomFunction`
    //            developer-guides/covering-tiles.md (b=1 default, equal
    //            screen-area-per-tile across the viewport).
    const cw_center = mvp[15]
    const tile_rx = mmid_h - camMercX
    const tile_ry = mmid_v - camMercY
    const cw_tile = mvp[3] * tile_rx + mvp[7] * tile_ry + mvp[15]
    if (cw_tile <= 1e-6) {
      // Tile centre is behind camera but some corner is visible — this
      // is the "straddles near plane" case; force subdivision so the
      // children get classified individually.
      return SUBDIVIDE_THRESHOLD + 1
    }
    const desiredZ = camera.zoom + Math.log2(cw_center / cw_tile)
    // SUBDIVIDE_THRESHOLD is a fixed positive constant; we just need to
    // straddle it so `visit()` makes the subdivide-vs-emit decision. The
    // returned value isn't a real screen size anymore — the visibility
    // gate above already culled invisible tiles.
    return tz < Math.floor(desiredZ) ? SUBDIVIDE_THRESHOLD + 1 : 1
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
        (1 - Math.log(Math.tan(Math.PI / 4 + Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, camLat)) * DEG2RAD / 2)) / Math.PI) / 2 * childN,
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
  const camLatClamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, camLat))
  const camTYf = (1 - Math.log(Math.tan(Math.PI / 4 + camLatClamped * DEG2RAD / 2)) / Math.PI) / 2 * camN
  let minTX: number, maxTX: number, minTY: number, maxTY: number
  if (pitchDegFn < 30) {
    const tileSizePx = TILE_PX * Math.pow(2, (camera.zoom ?? maxZ) - maxZ)
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

  // ── PARENT inject (fallbackOnly) ──────────────────────────────────
  // High-pitch view at a zoom near the archive maxLevel: the screen-
  // space sampler's ray distribution (perspective compresses many
  // rays into the horizon band) lets close-camera tiles slip out of
  // `stableKeys`. Under the 64-key mobile cap they get evicted, then
  // re-fetched on the next frame as the camera holds — visible as
  // foreground rendering from z=maxZ-1 (or deeper) ancestor blocks
  // even when camera zoom is at maxZ.
  //
  // Fix: keep the camera-vicinity parents at z=maxZ-1 RESIDENT by
  // adding them to `result` with `fallbackOnly: true`. The renderer
  // routes flagged tiles into `fallbackKeys` instead of `neededKeys`,
  // so they participate in EVICTION PROTECTION (stableKeys = needed
  // ∪ fallback) but render through STENCIL_TEST — drawing only
  // where the primary children's STENCIL_WRITE didn't already
  // paint. No duplicate primary-on-primary draws across zoom
  // levels (the bug the earlier b464f6a inject introduced when
  // combined with the currentZ-clamp at e4b2d66).
  if (pitchDegFn >= 30 && maxZ > 0) {
    const parentZ = maxZ - 1
    const parentN = Math.pow(2, parentZ)
    const pMinTX = Math.floor(minTX / 2)
    const pMaxTX = Math.floor(maxTX / 2)
    const pMinTY = Math.floor(minTY / 2)
    const pMaxTY = Math.floor(maxTY / 2)
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
        result.push({ z: parentZ, x: wrappedX, y: pty, ox: pox, fallbackOnly: true })
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
  const R = EARTH_R
  const n = Math.pow(2, targetZ)
  // See parallel comment in visibleTilesFrustum(). Table-ified (PR-A
  // target #3): byte-equivalent to `?0:1` — `isMerc`/`maxCopies` behave
  // identically for natural_earth at projType 2 vs the prior 1.
  const projType = PROJECTION_NAME_TO_TYPE[projection.name] ?? 0
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

  // Projection centre + circumference for the projection-aware decode.
  // The GPU draws non-Mercator geometry as projection.forward(lon,lat)
  // relative to the projected centre, so an unprojected screen sample
  // (camera.unprojectToZ0 returns coords in that SAME projected space
  // for non-Mercator) must be run through projection.inverse — NOT the
  // Mercator inverse — to recover the lon/lat the renderer actually
  // paints there. Mercator (projType 0) keeps the original raw path.
  const isMerc = projType === 0
  const RAD2DEG = 180 / Math.PI
  const WORLD_W = 2 * Math.PI * R
  const camLon = (camera.centerX / R) * RAD2DEG
  // Match the GPU's projection centre (renderFrame clamps centerLat to ±85).
  const camLat = Math.max(-85, Math.min(85,
    mercatorYToLat(camera.centerY)))
  const centerProj = isMerc ? [0, 0] : projection.forward(camLon, camLat)

  // CONTINUOUS lon (may exceed ±180 for world copies) + lat in degrees.
  // `Math.floor(absTileFx / n)` yields the world-offset (negative = west,
  // positive = east); the tile-x is the remainder modulo n. Without the
  // world copies low-zoom multi-Earth demos render the East/West copies
  // blank (regression: smoke vector_categorical / water_hierarchy z0).
  const decodeLonLat = (lon: number, lat: number): void => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
    const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
    const absTileFx = (lon + 180) / 360 * n
    const tileFy = (1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n
    const tileXFloor = Math.floor(absTileFx)
    const ox = Math.floor(tileXFloor / n)
    const tx = ((tileXFloor % n) + n) % n
    const ty = Math.floor(tileFy)
    addTile(tx, ty, ox)
  }

  // Convert an unprojected sample (relative to camera centre) → lon/lat.
  const decodeSample = (relX: number, relY: number): void => {
    if (isMerc) {
      decodeLonLat(
        ((camera.centerX + relX) / R) * RAD2DEG,
        mercatorYToLat(camera.centerY + relY),
      )
    } else {
      const [lonW, lat] = projection.inverse(centerProj[0]! + relX, centerProj[1]! + relY)
      // projection.inverse wraps lon to ±180; restore the continuous lon
      // so the dateline world copy resolves to the correct ox.
      decodeLonLat(lonW + Math.round(relX / WORLD_W) * 360, lat)
    }
  }

  // Pin the camera's current tile unconditionally — at extreme pitch
  // the camera's forward ray may miss samples that actually land on
  // it, so include it here. Matches the "camera-foot tile always
  // loaded" invariant the existing animation-coverage tests rely on
  // at low pitch.
  decodeLonLat(camLon, camLat)

  for (let iy = 0; iy < SAMPLES_PER_AXIS; iy++) {
    const fy = iy / (SAMPLES_PER_AXIS - 1)
    for (let ix = 0; ix < SAMPLES_PER_AXIS; ix++) {
      const fx = ix / (SAMPLES_PER_AXIS - 1)
      const rel = camera.unprojectToZ0(fx * canvasWidth, fy * canvasHeight, canvasWidth, canvasHeight, dpr)
      if (!rel) continue // sample ray misses ground (at/above horizon)
      decodeSample(rel[0], rel[1])
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

/** Load an image as a GPU texture (supports AbortSignal for cancellation) */
export async function loadImageTexture(
  device: GPUDevice,
  url: string,
  signal?: AbortSignal,
): Promise<GPUTexture | null> {
  // Defensive: empty / non-string URL would hit the current document
  // URL and createImageBitmap would fail on the HTML payload. Mirror
  // of fetchTileWithRetry empty-URL guard (iter 348).
  if (!url || typeof url !== 'string') return null
  // SSRF guard for the raster image-tile path (covers both the primary
  // and parent-fallback call sites in raster-renderer). safeFetch validates
  // the URL AND re-checks every redirect hop (following manually) so a
  // host urlTemplate pointing at — or 302-ing to — a private/loopback host
  // throws → caught below → null, the same graceful fallback as an
  // offline/404 tile.
  try {
    const response = await safeFetch(url, { signal }, 'raster tile URL')
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
