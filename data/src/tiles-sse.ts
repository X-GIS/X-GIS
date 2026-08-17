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

import { EARTH, CAMERA_FOV_RAD } from '@xgis/shared'
import type { Projection } from '@xgis/geo'
import { mercatorYToLat } from '@xgis/geo'
import { worldCopiesFor, TILE_PX } from '@xgis/geo'
import { PROJECTION_NAME_TO_TYPE } from '@xgis/geo'
import type { TileCoord, TileSelectionCamera } from './tile-select-types'

const EARTH_CIRC_M = EARTH.worldMerc
const PI_R = Math.PI * EARTH.sphereR

/** Default screen-space-error target in pixels.
 *
 *  Cesium ships 16 px because their `geometricError` measures *terrain
 *  mesh simplification error in metres* — a real perceptual quantity
 *  where 16 px error is genuinely invisible. For our 2D vector-tile
 *  case `geometricError(z) = tileSize/256` is a synthetic proxy and a
 *  much tighter budget matches the historical Mapbox/MapLibre frustum-
 *  selector behaviour (emit at the camera's native zoom — `cz =
 *  floor(zoom)` for vector sources at tileSize=512, restored 2026-05-15
 *  after diagnosing that the prior `floor(zoom + 0.7)` loaded one LOD
 *  deeper than ML at fractional camera zooms).
 *
 *  Empirical sweep on Bright at z=14 Tokyo (1280×800):
 *
 *    target  pitch=0      pitch=40    pitch=80    note
 *      1     15.6 ms(64)  19 ms(53)   154 ms(6)   horizon explodes at pitch
 *      4     ~14 ms       ~17 ms      ~50 ms      historical balance
 *     16      7 ms        7 ms        12 ms       fast but z=10 max
 *
 *  Was 4 — chosen for the high-pitch perf cliff. The cost at low pitch
 *  was effectively invisible on Bright (a feature-dense basemap where
 *  z=14 still fills the viewport with many tiles even at target=4).
 *  But on sparse vector sources (one-layer geojson countries) the
 *  selector stops at z=5 for a zoom=6.93 camera — `ssePx≈3.83 < 4` —
 *  and the single z=5 tile renders the same 19-vertex polygon spread
 *  across a 2500 km × 2500 km area, producing visibly coarse wedge
 *  edges where the user expected z=7 native detail.
 *
 *  Lowered to 1 to match Mapbox/MapLibre native-zoom rendering at low
 *  pitch (ssePx≈0.96 at z=7 → emit z=7). The high-pitch ramp below
 *  re-injects horizon coarsening so pitch=80° still hits the historical
 *  target=12 sweet spot. */
const DEFAULT_TARGET_SSE_PX = 1

/** Where the far-field SSE ceiling starts and finishes engaging, in multiples of
 *  the camera altitude (see `effectiveTarget` in the DFS).
 *
 *  NEAR is 2 because an UNPITCHED viewport is entirely inside it: with FOV 45°
 *  the frame's corner sits at √(1 + tan²22.5° + (aspect·tan22.5°)²) ≈ 1.3
 *  altitudes even on a wide 16:10 canvas. That is what makes the grading
 *  behaviour-preserving at low pitch rather than merely approximately so.
 *  FAR is 5 so the ceiling arrives gradually across the pitched ground stretch
 *  instead of as another band edge — the kind of edge that produced the
 *  pitch-60→70 cliff this replaces. Swept 4/5/8 on Paris z14+z16: the emitted
 *  count barely moves (41-54) and the native-LOD count does not move at all,
 *  because the total is set by NEAR — i.e. by how much foreground you insist on
 *  drawing at native zoom. FAR only trims the mid-field, so it is chosen for a
 *  smooth gradient rather than for a count. */
const FAR_RAMP_NEAR = 2
const FAR_RAMP_FAR = 5
const FAR_RAMP_SPAN = FAR_RAMP_FAR - FAR_RAMP_NEAR

/** Ceiling on the far-field target once `farTargetBoost` has been applied. Higher than
 *  the ramp's own 24 on purpose: the ramp's top is what a HEALTHY host should be asked
 *  to draw, while the boost only ever arrives from a host that is already missing its
 *  frame budget, where a coarser horizon beats a frozen map. Bounded all the same, so
 *  a runaway multiplier saturates instead of emptying the screen — and the foreground
 *  is unreachable from here regardless, since this scales the DISTANCE-graded target
 *  only. */
const ADAPTIVE_FAR_SSE_MAX = 64

/** Hard cap on emitted PRIMARY tile count (fallbackOnly ancestors are not
 *  charged — see the emit-budget block in the DFS). Safety net only, but "only
 *  in theory" was too generous: a pitched Bright/Liberty view already measures
 *  200-300 tiles (globe-visible-tiles.ts:91) and 254 at Liberty Paris z=18.25
 *  pitch=70 WITH the high-pitch SSE relief applied, so a denser scene reaches
 *  this. When it does the viewport is genuinely uncovered, which is why hitting
 *  it now reports through `onTruncated` instead of silently returning short. */
const MAX_EMITTED = 600

/** DIAGNOSTIC ONLY — hard-caps the emitted tile count so a tester can A/B
 *  "does drawing fewer tiles fix the frame rate?" without any code change. The
 *  camera-priority DFS already emits nearest-first, so the cap keeps the
 *  foreground and drops the far horizon. Two sources, runtime-first:
 *    • `window.__xgisMaxTiles` — RUNTIME override, re-read every call so the
 *      perf overlay's one-tap A/B can toggle it between scenarios (a number
 *      caps, `null` forces "no cap" overriding the URL, `undefined` defers).
 *    • `?maxtiles=N` — the static URL default (read once, memoised).
 *  Returns null when neither is set so production behaviour is byte-identical.
 *  NOT a perf feature — it leaves the viewport partially uncovered by design. */
function maxTilesCap(): number | null {
  if (typeof window !== 'undefined') {
    const rt = (window as { __xgisMaxTiles?: number | null }).__xgisMaxTiles
    if (rt !== undefined) return typeof rt === 'number' && rt >= 1 ? Math.floor(rt) : null
  }
  return urlMaxTiles()
}
let _maxTilesFlag: number | null | undefined
function urlMaxTiles(): number | null {
  if (_maxTilesFlag !== undefined) return _maxTilesFlag
  _maxTilesFlag = null
  if (typeof window !== 'undefined') {
    try {
      const v = new URL(window.location.href).searchParams.get('maxtiles')
      if (v !== null) {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 1) _maxTilesFlag = Math.floor(n)
      }
    } catch {
      /* non-browser / bad URL → no cap */
    }
  }
  return _maxTilesFlag
}

export interface VisibleTilesSSEOptions {
  /** Subdivide-cutoff in screen pixels. Default 16. */
  targetSSEPx?: number
  /** Hard cap on emitted PRIMARY tiles — safety net for pathological cameras.
   *  fallbackOnly ancestors are not charged against it (they protect tiles
   *  already inside the budget from eviction; they are not extra draw work). */
  maxEmitted?: number
  /** Called when the cap actually bit, i.e. the returned set does NOT cover the
   *  viewport. Without it the truncation is invisible — the array is the same
   *  shape either way — and missing tiles reach the screen with no diagnostic. */
  onTruncated?: (emitted: number, cap: number) => void
  /** Multiplier on the FAR-FIELD error ceiling only (#1393). 1 (default) leaves
   *  selection byte-identical. Injected rather than read from a controller so this
   *  package stays content- and policy-blind — the composition root owns the quality
   *  ladder and passes the notch's value down, the same inversion `selectBackend`
   *  uses for `renewSurface`.
   *
   *  It scales `farTargetSSE`, never `baseTarget`, so what it coarsens is what the
   *  distance grading already treats as horizon; the foreground #1346 restored keeps
   *  native LOD at every pitch and every notch. On an UNPITCHED camera there is no
   *  far field (a 45° FOV frame lies inside `FAR_RAMP_NEAR`), so this is inert there
   *  by construction — flat dense scenes are the DPR lever's job, not this one. */
  farTargetBoost?: number
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
// iter-253 (Plan AAA A.2) — module-level scratch for `injectedParents`
// (see visibleTilesSSE body). Cleared at function entry; reused
// across calls. Safe because visibleTilesSSE is invoked sequentially
// within the synchronous render loop.
const _injectedParentsScratch = new Set<number>()

export function visibleTilesSSE(
  camera: TileSelectionCamera,
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
  const pitchDeg = camera.pitch ?? 0
  // High-pitch horizon protection. base=1 gives Mapbox-style native
  // zoom at low pitch but the foreshortened ground at pitch>60° emits
  // too many horizon tiles (table above: target=1 pitch=80° → 154 ms).
  // Ramp toward target=12 at pitch=80° — matches the historical
  // pitch=80°/target=12 sweet spot. Below 60° we keep base unchanged
  // (the visual fidelity reason for lowering the default in the first
  // place).
  // The FAR-FIELD ceiling. Applied by DISTANCE, not to every tile in the frame —
  // see `effectiveTarget` in the DFS. Raising it globally is what broke the
  // foreground: measured on the real selector (Paris z16, 1280×800), a pitch=70
  // frame emitted ZERO tiles at the native zoom — the whole screen, foreground
  // included, came from z8–z14 ancestors — while pitch≤60 emitted every tile at
  // native z16. That is the cliff behind "lowering the pitch makes it much
  // heavier": crossing 60° downward, 12 coarse tiles become 20 native ones, and
  // since buildings only exist at z≥14 the pitched view carried almost no
  // buildings at all until the pitch came down. The claim above — "without
  // affecting the foreground (foreground SSE stays high regardless of target)" —
  // simply was not true; a global target coarsens near tiles just as hard.
  let farTargetSSE = baseTarget
  if (opts.targetSSEPx === undefined && pitchDeg > 60) {
    const t = Math.min(1, (pitchDeg - 60) / 20)
    farTargetSSE = Math.min(24, baseTarget + t * (12 - baseTarget))
    // iter-190 — additional ramp for high-z + high-pitch views.
    // Probe 2026-05-20 Liberty Paris z=18.25 pitch=70: idle frame
    // 85 ms, 254 tiles, 1.7M vertices. z=18 multiplies the fore-
    // shortened ground tile fan by 2× over z=17, so the base
    // 60°→80° ramp (top=12 at p=80) leaves z=18 p=70 emitting too
    // many horizon tiles. Above z=17 push the SSE target toward 24
    // proportionally so horizon LOD coarsens hard while the
    // foreground (high screen-space-error tiles) still subdivides
    // to native resolution.
    if (camera.zoom > 17) {
      const zBoost = Math.min(1, (camera.zoom - 17) / 1.5)
      farTargetSSE = Math.min(24, farTargetSSE + zBoost * (24 - farTargetSSE))
    }
  }
  // Adaptive far-field relief (#1393). Multiplies the ramp's OWN far target rather
  // than the base, so it composes with the pitch/zoom ramp instead of competing with
  // it — at pitch 80 the ramp already asks for 12, and a multiple of the base (1)
  // would be silently swallowed by it. Only engages where the ramp did, so a view
  // whose far field the grading left alone is untouched here too.
  const boost = opts.farTargetBoost ?? 1
  if (boost > 1 && farTargetSSE > baseTarget)
    farTargetSSE = Math.min(ADAPTIVE_FAR_SSE_MAX, farTargetSSE * boost)
  // `?maxtiles=N` (diagnostic) wins over the explicit opt and the default so
  // the A/B cap applies on every selection path; null/absent → normal behaviour.
  const maxEmitted = maxTilesCap() ?? opts.maxEmitted ?? MAX_EMITTED

  // Camera altitude in Mercator metres — derived from the CSS-pixel
  // viewport (matches camera.ts:120): only THIS term is DPR-invariant.
  // Selection as a whole is not — see `ssePx` below (#1379).
  const cssHeight = canvasHeight / dpr
  // #1440: was a local `FOV_DEG = 45` annotated "Camera.FOV — fixed in this
  // engine". Camera.FOV is 36.87 deg; the two had drifted, inflating
  // tanHalfFov by 24 % and with it the altitude, ssePx, horizon distance and
  // far-field ramp below. Both packages now read the one constant.
  const halfFovRad = CAMERA_FOV_RAD / 2
  const tanHalfFov = Math.tan(halfFovRad)
  const metersPerPixelGround = EARTH_CIRC_M / TILE_PX / Math.pow(2, camera.zoom)
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
  // Resolve projType from the authoritative PROJECTIONS table (mirrors
  // data/tile-select.ts:153). The prior `projection.name` ternary collapsed
  // every disc/globe projection to equirectangular (projType 1), so
  // worldCopiesFor() ran the DFS from 5 world-copy roots on SINGLE_WORLD
  // discs and reprojected lon up to ±900° on a non-periodic surface.
  const projType = PROJECTION_NAME_TO_TYPE[projection.name] ?? 0
  const horizonCullActive = projType === 0 && !opts.disableHorizonCull
  const earthR = EARTH.sphereR
  const horizonDist = horizonCullActive
    ? 1.2 * Math.sqrt(2 * earthR * Math.max(altitude, 1))
    : Infinity

  // Projection-aware screen projection. Tile bounds are enumerated in
  // Mercator meters (the tile pyramid is Web Mercator), but the GPU
  // draws non-Mercator geometry as `projection.forward(lon,lat)` relative
  // to the projected camera centre, then applies this SAME Mercator-built
  // MVP (see renderer.ts project_geom path). The cull MUST mirror that:
  // converting each Mercator-meter corner → lon/lat → projection.forward
  // makes selection screen-space match what's actually rasterised. Skip
  // it for Mercator (projType 0) so that hot path stays byte-identical.
  const RAD2DEG = 180 / Math.PI
  const camLon = (camMx / earthR) * RAD2DEG
  // Match the GPU's projection centre (renderFrame clamps centerLat to
  // ±85 before feeding it as proj_params.z).
  const camLat = Math.max(-85, Math.min(85, mercatorYToLat(camMy)))
  const centerProj = projType === 0 ? [0, 0] : projection.forward(camLon, camLat)
  // Frustum cull via the camera's MVP — same matrix the renderer uses
  // to draw, so cull and rasterisation agree on screen space at any DPR.
  // `far` comes from the same call so the FAR plane can bound the selection
  // too (#1427) — see `beyondFarPlane` below.
  const { matrix: mvp, far: farDepth } = camera.getFrameView(canvasWidth, canvasHeight, dpr)
  const toScreen = (mx: number, my: number): [number, number, number] | null => {
    let rx: number, ry: number
    if (projType === 0) {
      rx = mx - camMx
      ry = my - camMy
    } else {
      const lonAbs = (mx / earthR) * RAD2DEG
      const lat = mercatorYToLat(my)
      const p = projection.forward(lonAbs, lat)
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
      // projection.forward wraps lon to the primary world (clon±180); add
      // the world-copy offset back on x so adjacent copies land at the
      // right screen position, matching the GPU's `project_geom` world_off.
      const wo = Math.floor((lonAbs - camLon + 180) / 360)
      rx = p[0] + wo * EARTH_CIRC_M - centerProj[0]!
      ry = p[1] - centerProj[1]!
    }
    const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[15]!
    if (cw <= 1e-6) return null // behind camera
    const cx = mvp[0]! * rx + mvp[4]! * ry + mvp[12]!
    const cy = mvp[1]! * rx + mvp[5]! * ry + mvp[13]!
    return [(cx / cw + 1) * 0.5 * canvasWidth, (1 - cy / cw) * 0.5 * canvasHeight, cw]
  }

  // ── FAR-PLANE CULL (#1427) ────────────────────────────────────────
  // The camera's far plane is the single authority for where the rendered
  // world ends — the GPU clips every fragment past it — so a tile entirely
  // beyond it is pure waste. This is TIGHTER than the globe-horizon cull
  // above (which stays as the non-Mercator / disabled-far fallback): at the
  // reported camera the far plane reaches ~58 km of ground where the globe
  // horizon allowed ~193 km, and it is the horizon MapLibre draws to.
  //
  // Exact on Mercator, where `cw` is affine in (mx, my) and its minimum over
  // the tile rectangle is therefore attained at one of the four sampled
  // corners. `projection.forward` is not affine, so this reuses
  // `horizonCullActive` verbatim rather than re-deriving the same predicate —
  // same Mercator-only scope, same `disableHorizonCull` escape hatch, and no
  // second projType branch for the #996 ratchet to count. A corner behind the
  // camera returns null and is skipped: it can only lower the true minimum,
  // so skipping it can never cull a tile that should have been kept.
  const beyondFarPlane = (corners: ([number, number, number] | null)[]): boolean => {
    if (!horizonCullActive) return false
    let cwMin = Infinity
    for (const c of corners) if (c && c[2] < cwMin) cwMin = c[2]
    return cwMin > farDepth
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
    const corners: ([number, number, number] | null)[] = [
      toScreen(mxMin, myMin),
      toScreen(mxMax, myMin),
      toScreen(mxMin, myMax),
      toScreen(mxMax, myMax),
    ]
    if (beyondFarPlane(corners)) return false
    let allBehind = true
    let allLeft = true,
      allRight = true,
      allTop = true,
      allBottom = true
    let minSx = Infinity,
      maxSx = -Infinity,
      minSy = Infinity,
      maxSy = -Infinity
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
  // iter-253 (Plan AAA A.2) — module-level scratch. visibleTilesSSE
  // is called ~once per render per source (sequential within a
  // frame, no async). Pre-iter-253 allocated a fresh Set per call.
  const injectedParents = _injectedParentsScratch
  injectedParents.clear()
  const parentKey = (z: number, x: number, y: number, worldCopy: number): number =>
    // Pack (worldCopy, z, x, y) into a 53-bit number for Set lookup.
    // worldCopy fits ±10 (overhead bits), z ≤ 22 (5 bits), x/y ≤ 2^22.
    ((worldCopy + 16) * 32 + z) * (1 << 22) * (1 << 22) + x * (1 << 22) + y

  // ── Emit budget (#1374) ───────────────────────────────────────────────────
  // The cap governs PRIMARY tiles only. It used to test `result.length`, which
  // also counts the fallbackOnly ancestors pushed below — those are eviction-
  // protection metadata for tiles already inside the budget, not additional draw
  // work, so charging them shrank the real tile budget by ~24% (deduped, they
  // amortise to ≈0.31 pushes per primary) with nothing in the docs saying so.
  let emitted = 0

  // DFS. `n` = 2^z = number of tiles per side at this level. The
  // mercator x range is shifted by `worldCopy * EARTH_CIRC_M` so a
  // single DFS pass can be driven from each world copy's root.
  const visit = (z: number, x: number, y: number, worldCopy: number): void => {
    if (emitted >= maxEmitted) return

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
    const closestX = camMx < mxMin ? mxMin : camMx > mxMax ? mxMax : camMx
    const closestY = camMy < myMin ? myMin : camMy > myMax ? myMax : camMy
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

    // Distance-graded target. The far-field ceiling engages by how far the tile
    // is compared with the camera's own altitude — the quantity that actually
    // says "this is horizon, not foreground" — instead of being applied to every
    // tile whenever the camera happens to be pitched. Below FAR_RAMP_NEAR the
    // tile keeps the base target, so it still subdivides to native zoom no matter
    // how steep the pitch; past FAR_RAMP_FAR it pays the full ceiling.
    //
    // Low-pitch views are UNTOUCHED by construction: with a 45° FOV every tile in
    // an unpitched viewport sits within ~1.3 altitudes of the camera (corner
    // included), which is below FAR_RAMP_NEAR, so `farness` is 0 and the target is
    // exactly `baseTarget` — the same value the old code used there.
    const farness =
      farTargetSSE === baseTarget
        ? 0
        : Math.min(1, Math.max(0, (distance / altitude - FAR_RAMP_NEAR) / FAR_RAMP_SPAN))
    const effectiveTarget = baseTarget + farness * (farTargetSSE - baseTarget)

    if (ssePx > effectiveTarget && z < maxZ) {
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
        const cdx = ccx - camMx,
          cdy = ccy - camMy
        children.push({ cx, cy, idx: cdx * cdx + cdy * cdy })
      }
      children.sort((a, b) => a.idx - b.idx)
      for (const c of children) visit(z + 1, c.cx, c.cy, worldCopy)
    } else {
      // Emit at this level. `ox = x + worldCopy * 2^z` per the
      // TileCoord absolute-x contract (see loader/tiles.ts:39).
      result.push({ z, x, y, ox: x + worldCopy * n })
      emitted++

      // fallbackOnly parent inject — push (z-1, z-2) parents flagged
      // `fallbackOnly` so eviction protects them. Renderer routes
      // these through the fallback path (clipped to children's bounds)
      // when the primary slice hasn't uploaded yet. De-duped via
      // `injectedParents` so the SAME coord across siblings doesn't
      // emit twice.
      let pz = z,
        px = x,
        py = y
      for (let depth = 0; depth < FALLBACK_PARENT_DEPTH && pz > 0; depth++) {
        pz -= 1
        px >>>= 1
        py >>>= 1
        const k = parentKey(pz, px, py, worldCopy)
        if (injectedParents.has(k)) break
        injectedParents.add(k)
        result.push({
          z: pz,
          x: px,
          y: py,
          ox: px + worldCopy * (1 << pz),
          fallbackOnly: true,
        })
      }
    }
  }

  // Run the DFS from each world copy's root. `projType` was computed
  // earlier (alongside the horizon-cull setup); single-world disc/globe
  // projections resolve to `worldCopies = [0]` (one iteration), while the
  // cylindrical family (mercator/equirect/natural_earth/oblique) enumerates
  // the ±N copies.
  //
  // NEAREST COPY FIRST. The table order is [-2,-1,0,1,2] — the camera's own
  // world sits THIRD — while the emit cap is a shared running total checked at
  // `visit` entry. So the two off-screen copies got first claim on the budget
  // and, whenever they legitimately consumed it (a camera spanning the
  // antimeridian, where more than one copy really is on screen), the PRIMARY
  // world returned at its root and emitted nothing: a contiguous band of map
  // simply absent. Sorting by distance from the camera's own copy makes the
  // budget flow to the most relevant world first, so anything the cap drops is
  // the least relevant copy rather than the one the user is looking at. Copies
  // are otherwise independent, so ordering changes nothing else — and a
  // single-copy projection has nothing to sort.
  const copyOrder = [...worldCopiesFor(projType)].sort((a, b) => Math.abs(a) - Math.abs(b))
  for (const wc of copyOrder) {
    visit(0, 0, 0, wc)
  }
  // Truncation is a COVERAGE failure, not a perf detail: the viewport is left
  // partially uncovered and the array alone cannot say so, which is exactly how
  // "tiles that should be visible are missing" reaches a user with no diagnostic
  // anywhere. Report it so the caller can surface/degrade deliberately. Optional
  // and side-effect-free when unset, so the return shape stays identical to
  // `visibleTilesFrustum` (the swap-behind-a-flag contract).
  if (emitted >= maxEmitted) opts.onTruncated?.(emitted, maxEmitted)
  return result
}
