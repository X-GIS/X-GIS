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

export interface TileCoord {
  z: number
  x: number   // wrapped x (0..2^z-1) for data lookup
  y: number
  ox?: number  // original x (may be < 0 or >= 2^z) for world-copy positioning
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
function isMobileViewport(canvasWidth: number, canvasHeight: number): boolean {
  return Math.max(canvasWidth, canvasHeight) <= 900
}
// Viewport-aware tile budget — replaces the old static cap.
// Density of ~one tile per 12 K pixels keeps drawCalls bounded on
// any viewport: desktop 1280×720 → 76 tiles, mobile 390×844 → 27
// tiles. Floor on mobile is tighter (real iPhones throttle past
// ~60 unique tiles ≈ 240 drawCalls).
const MAX_FRUSTUM_TILES_CEILING = 300
function maxFrustumTilesFor(canvasWidth: number, canvasHeight: number): number {
  // Real-device inspector data (iPhone, Tokyo z=9.1, performance
  // preset): GPU pass 17.4 ms (60 fps target 16.7 ms — just past),
  // fps 30s avg 35. Even with DPR 1.0 + msaa 1, 196 K line SDF
  // segments + 429 K triangles per frame is too much for the
  // sustained mobile GPU budget. Tightening visible cap further:
  //   - mobile floor 12 → 8 (caps 4-layer triangles ~300 K/frame)
  //   - viewport-area divisor 18 K → 24 K (smaller default count)
  // Desktop unchanged.
  const isMobile = isMobileViewport(canvasWidth, canvasHeight)
  const floor = isMobile ? 8 : 60
  const divisor = isMobile ? 24000 : 12000
  return Math.max(
    floor,
    Math.min(MAX_FRUSTUM_TILES_CEILING, Math.round((canvasWidth * canvasHeight) / divisor)),
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
): TileCoord[] {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)
  const camMercX = camera.centerX
  const camMercY = camera.centerY
  // Non-Mercator projections render a single world (no lon-periodic
  // wrap); skip enumerating ±N copies to avoid 5× wasted tile selection
  // + downstream draws. See worldCopiesFor() in gpu-shared.ts.
  const projType = projection.name === 'mercator' ? 0 : 1
  const maxCopies = (worldCopiesFor(projType).length - 1) / 2
  // Subdivide cut-off: a tile crosses this many on-screen pixels →
  // descend into its 4 children. Hard-coded 400 was tuned for
  // desktop; on small mobile viewports (390 × 844 iPhone) it
  // forces nearly every tile to subdivide all the way to leaves
  // because tiles cover most of the viewport at coarse z. Result:
  // continuous wheel zoom on mobile spawns 150+ visible tiles
  // ≈ thermal throttling. Scale the threshold to ~half the
  // shorter viewport edge so mobile gets roughly the same
  // "tile count per screen" budget as desktop. Floor at 256 so a
  // tiny canvas (e.g. inset preview) doesn't lose all detail.
  const SUBDIVIDE_THRESHOLD = Math.max(320, Math.min(canvasWidth, canvasHeight) * 0.5)
  const MAX_FRUSTUM_TILES = maxFrustumTilesFor(canvasWidth, canvasHeight)

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
    const pitchDeg = camera.pitch ?? 0
    const marginPctOfMax = pitchDeg < 30 ? 0.05
      : pitchDeg < 60 ? 0.15
      : 0.25
    const pitchFloor = pitchDeg < 30 ? 32
      : pitchDeg < 60 ? 128
      : 256
    const baseMargin = Math.max(canvasWidth, canvasHeight) * marginPctOfMax
    const margin = Math.max(baseMargin, pitchFloor) + Math.max(0, extraMarginPx)
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
    const wideMargin = Math.max(baseWide, 2048)
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
  // camera and the only data the user is looking at. Repro: GeoJSON line
  // at lat=0 invisible at zoom=8.34 / pitch=74.8 / bearing=90 over (29.19,
  // -0.146); see fixture-cap-arrow-bug.test.ts. Inject the 3×3 ring at
  // maxZ around the camera tile, bypassing MAX_FRUSTUM_TILES (9 tiles
  // worst-case) so the camera-area always renders.
  const camN = Math.pow(2, maxZ)
  const camTX = Math.floor((camLon + 180) / 360 * camN)
  const camLatClamped = Math.max(-85.0511, Math.min(85.0511, camLat))
  const camTY = Math.floor(
    (1 - Math.log(Math.tan(Math.PI / 4 + camLatClamped * DEG2RAD / 2)) / Math.PI) / 2 * camN,
  )
  const seen = new Set<number>()
  for (const t of result) seen.add((t.z * 4194304 + t.y) * 4194304 + (t.ox + camN))
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ty = camTY + dy
      if (ty < 0 || ty >= camN) continue
      const tx = camTX + dx
      // Wrap around the date line — same as world-copy logic above.
      const wrappedX = ((tx % camN) + camN) % camN
      const ox = tx
      const key = (maxZ * 4194304 + ty) * 4194304 + (ox + camN)
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ z: maxZ, x: wrappedX, y: ty, ox })
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

  // Add the camera's current tile unconditionally — at extreme
  // pitch the camera's forward ray may miss samples that actually
  // land on it, so pin it here. Matches the "camera-foot tile
  // always loaded" invariant the existing animation-coverage
  // tests rely on at low pitch.
  {
    const camLon = (camera.centerX / R) / DEG2RAD
    const camLat = (2 * Math.atan(Math.exp(camera.centerY / R)) - Math.PI / 2) / DEG2RAD
    const cx = Math.floor((camLon + 180) / 360 * n)
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, camLat))
    const cy = Math.floor(
      (1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n,
    )
    addTile(cx, cy, 0)
  }

  for (let iy = 0; iy < SAMPLES_PER_AXIS; iy++) {
    const fy = iy / (SAMPLES_PER_AXIS - 1)
    for (let ix = 0; ix < SAMPLES_PER_AXIS; ix++) {
      const fx = ix / (SAMPLES_PER_AXIS - 1)
      const rel = camera.unprojectToZ0(fx * canvasWidth, fy * canvasHeight, canvasWidth, canvasHeight)
      if (!rel) continue // sample ray misses ground (at/above horizon)
      const mx = camera.centerX + rel[0]
      const my = camera.centerY + rel[1]
      const lon = (mx / R) / DEG2RAD
      const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
      const tileFx = (lon + 180) / 360 * n
      const tileFy = (1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n
      const tx = Math.floor(tileFx)
      const ty = Math.floor(tileFy)
      // Record the tile AND its 8-neighbours. Adjacent sample
      // points at the grid's edges may project to the interior of
      // a tile — neighbour dilation fills the fringe.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          addTile(tx + dx, ty + dy, 0)
        }
      }
    }
  }

  // Unpack and cap.
  const MAX = maxFrustumTilesFor(canvasWidth, canvasHeight)
  const result: TileCoord[] = []
  for (const key of tileSet) {
    if (result.length >= MAX) break
    const ox = Math.floor(key / (n * n)) - maxCopies
    const rest = key % (n * n)
    const x = Math.floor(rest / n)
    const y = rest % n
    result.push({ z: targetZ, x, y, ox })
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
