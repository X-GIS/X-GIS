// ═══ Globe visible-tile selection (relocated from @xgis/engine, #781) ═══
//
// Descends the web-mercator tile pyramid for the true-3D globe camera,
// keeping camera-facing tiles that project inside the viewport. This is
// tile-pyramid SELECTION — a @xgis/data concern (GlobeTile is structurally
// the data layer's TileCoord), not generic engine math. The sphere/camera
// primitives it drives (buildGlobeMatrix, unprojectGlobe) stay in
// @xgis/engine and are imported here.

import { buildGlobeMatrix, unprojectGlobe, EARTH_R, MERCATOR_LAT_LIMIT } from '@xgis/geo'
import { eyeHorizon } from '@xgis/shared'

// Redeclared locally (trivial constants; the engine's copies are module-private).
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** TileCoord-shaped result. Structurally identical to
 *  data/tile-select.ts `TileCoord` / `makeTileCoord(z,x,y,0)` output;
 *  declared locally so this module has no import cycle with the data
 *  layer. The globe renders a single world (no Mercator world copies)
 *  so `ox === x` always. */
export interface GlobeTile {
  z: number
  x: number
  y: number
  ox: number
}

/** Visible-cap tile selection for the globe.
 *
 *  Descends the web-mercator tile pyramid, keeping tiles that are on
 *  the camera-facing hemisphere AND project inside the viewport, and
 *  subdividing those still larger than ~one screen until `maxZ`.
 *
 *  The dateline ("날짜변경선") is handled BY CONSTRUCTION: tiles are
 *  tested in lon/lat→sphere space, which is continuous across ±180°, so
 *  a view centred near the antimeridian keeps tiles on BOTH sides
 *  (x≈0 and x≈2^z−1). The old non-Mercator path collapsed to a single
 *  non-wrapping lon window and dropped the far half — fixed here.
 */
// Per-call memo for globeVisibleTiles. The function inputs depend ONLY
// on camera state + canvas — every source within the same frame hits
// the same answer. Pre-fix vector-tile-renderer.ts called it per
// source-show, paying the same recursive sphere-tile traversal 5-8×
// per frame on OFM Bright (multiple sources × 60 fps = O(1M) toScreen
// multiplies/sec on a Seoul-zoom-15 globe view — user-reported perf
// degradation, 2026-05-18). The memo key serialises every input value
// the algorithm reads, so a parameter change invalidates the cache.
let _globeTilesCacheKey: string | null = null
let _globeTilesCacheResult: GlobeTile[] = []

export function globeVisibleTiles(
  centerLon: number,
  centerLat: number,
  zoom: number,
  maxZ: number,
  cssWidthPx: number,
  cssHeightPx: number,
  pitchDeg = 0,
  bearingDeg = 0,
): GlobeTile[] {
  // Memo lookup. String key is round-tripped through toFixed(4) so
  // micro-jitter (1e-9 lon drift after a re-projection) doesn't blow
  // the cache on every frame; 4 decimals of lon ≈ 11m at equator
  // which is well below tile-pixel resolution at z=22.
  const key = `${centerLon.toFixed(4)}|${centerLat.toFixed(4)}|${zoom.toFixed(3)}|${maxZ}|${cssWidthPx.toFixed(0)}|${cssHeightPx.toFixed(0)}|${pitchDeg.toFixed(2)}|${bearingDeg.toFixed(2)}`
  if (key === _globeTilesCacheKey) return _globeTilesCacheResult
  const view = buildGlobeMatrix(
    centerLon,
    centerLat,
    zoom,
    pitchDeg,
    bearingDeg,
    cssWidthPx,
    cssHeightPx,
  )
  const mvp = view.matrix
  const eye = view.eye
  // A surface point P is visible only if it faces the eye:
  // dot(normalize(P), normalize(eye)) > R/|eye|  (horizon cut). Single authority.
  const { eyeN, horizonCos } = eyeHorizon(eye, EARTH_R)

  const SUBDIVIDE_PX = Math.max(256, Math.min(cssWidthPx, cssHeightPx) * 0.5)
  // Tile-output cap. Mercator visibleTilesSSE typically returns 200-300
  // tiles at normal zoom; the previous 512 cap was 1.7× over that with
  // no observable visual gain (tiles past ~300 are far enough off-axis
  // they contribute nothing to the visible hemisphere on a 1080p canvas).
  // Lowering trims worst-case traversal post-front-face cull — Seoul
  // z=15+ Globe view with OFM Bright hits the cap, so this directly
  // limits the recursive node count after the iter 458 SoA stack landed.
  const MAX_TILES = 300

  // Hoisted above the overzoom branch so both it and the legacy
  // descent share one accumulator.
  const out: GlobeTile[] = []

  // ─── Overzoom geographic-footprint selection (iter 149) ──────────
  // Root (probes iter 147/148): once the camera zoom exceeds maxZ a
  // single maxZ tile projects LARGER than the whole viewport, so the
  // 5-sample descent/cull below is geometrically meaningless — the
  // descent prune (`!anyFront` under a ~0° cone) collapses the set
  // to ~1 tile and globe/oblique go near-blank past z≈15. (ortho/
  // azi/stereo are unaffected: vtr.ts:2951 routes only globe(7) /
  // oblique(6) / nearAntimeridian here; the others use the overzoom-
  // capable visibleTilesSSE.) Bypass the heuristic entirely in the
  // overzoom regime: unproject the viewport corners + edges onto the
  // sphere, take the lon/lat bbox, emit every maxZ tile covering it
  // — the same overzoom set visibleTilesSSE yields for the flat
  // path. Deterministic; output bounded by the (tiny, at overzoom)
  // footprint → no recursion, structurally cannot explode.
  if (zoom > maxZ + 1e-3) {
    const W = cssWidthPx,
      H = cssHeightPx
    const probes: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
      [W * 0.5, H * 0.5],
      [W * 0.5, 0],
      [W * 0.5, H],
      [0, H * 0.5],
      [W, H * 0.5],
    ]
    let lonMin = Infinity,
      lonMax = -Infinity
    let latMin = Infinity,
      latMax = -Infinity
    let hits = 0
    for (const [sx, sy] of probes) {
      const ll = unprojectGlobe(sx, sy, W, H, view)
      if (!ll) continue
      hits++
      const lo = ll[0],
        la = ll[1]
      if (lo < lonMin) lonMin = lo
      if (lo > lonMax) lonMax = lo
      if (la < latMin) latMin = la
      if (la > latMax) latMax = la
    }
    // Need ≥1 hit AND a non-limb-straddling box; otherwise fall
    // through to the legacy descent rather than emit nothing / half
    // the world (a corner ray grazing the limb can blow the span).
    if (hits > 0 && lonMax - lonMin <= 170 && latMax - latMin <= 170) {
      const tileN = (1 << maxZ) | 0
      const lonToX = (lo: number): number =>
        Math.min(tileN - 1, Math.max(0, Math.floor(((lo + 180) / 360) * tileN)))
      const latToY = (la: number): number => {
        // iter-312 (A-2) — was a coarse ±85.05 literal that disagreed
        // with MERCATOR_LAT_LIMIT (±85.051129) used by every other
        // tile-Y derivation. The 0.0011° gap classified the polar-
        // most tile row differently in globe selection vs render.
        const r = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, la)) * DEG2RAD
        const yf = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2
        return Math.min(tileN - 1, Math.max(0, Math.floor(yf * tileN)))
      }
      // ±1 tile pad so an edge tile only fractionally on-screen
      // isn't dropped. north (latMax) → smaller y.
      const x0 = Math.max(0, lonToX(lonMin) - 1)
      const x1 = Math.min(tileN - 1, lonToX(lonMax) + 1)
      const y0 = Math.max(0, latToY(latMax) - 1)
      const y1 = Math.min(tileN - 1, latToY(latMin) + 1)
      for (let ty = y0; ty <= y1 && out.length < MAX_TILES; ty++) {
        for (let tx = x0; tx <= x1 && out.length < MAX_TILES; tx++) {
          out.push({ z: maxZ, x: tx, y: ty, ox: tx })
        }
      }
      if (out.length > 0) {
        _globeTilesCacheKey = key
        _globeTilesCacheResult = out
        return out
      }
    }
  }

  // Pre-compute the off-screen bounds + matrix row scratch ONCE outside
  // the recursion. Allocation per node was the GC hot spot at z=15+
  // Seoul on globe — 32k nodes × 5 samples × 2 array allocs per sample
  // = ~300k transient arrays/frame (toScreen tuple + mulVec4 tuple).
  // Inline both ops into the loop; reuse scalar locals.
  //
  // EMIT pad (memory project_non_merc_z14_pitch_over_select): the
  // visible-viewport rectangle plus a 25 %-of-viewport margin. The
  // previous 1-viewport pad on each side (4× area) let many leaves at
  // pitch ≥ 45° pass `anyOnScreen` because the horizon hemisphere
  // wrapped through it. At z=14 + pitch=60° Seoul the loose pad
  // emitted 206 tiles vs ~17 the mercator control selects (12× over-
  // select, drag p95 144-211 ms → 5-7 fps). Tightening to 25 %
  // matches the `marginPctOfMax` floor tile-select.ts uses at pitch
  // ≥ 60°, so the sphere selector emits the same envelope of
  // on-screen tiles as the flat selector. Descent is NOT gated by
  // this AABB — it depends on `tooBig` (screen span > SUBDIVIDE_PX)
  // and the explicit `forceDescend` low-zoom / containsTarget cases —
  // so children of an edge-straddling tile still get visited.
  const emitPadX = cssWidthPx * 0.25
  const emitPadY = cssHeightPx * 0.25
  const minXEmit = -emitPadX
  const maxXEmit = cssWidthPx + emitPadX
  const minYEmit = -emitPadY
  const maxYEmit = cssHeightPx + emitPadY
  // Matrix elements as locals (avoids index-into-typed-array on every
  // mvp[i] read inside the hot loop).
  const m0 = mvp[0]!,
    m1 = mvp[1]!,
    m3 = mvp[3]!
  const m4 = mvp[4]!,
    m5 = mvp[5]!,
    m7 = mvp[7]!
  const m8 = mvp[8]!,
    m9 = mvp[9]!,
    m11 = mvp[11]!
  const m12 = mvp[12]!,
    m13 = mvp[13]!,
    m15 = mvp[15]!
  const pn = 1 / EARTH_R
  const eyeN0 = eyeN[0],
    eyeN1 = eyeN[1],
    eyeN2 = eyeN[2]
  // Eye position in world coords + distance from eye to camera target
  // (the focal point) — basis for the SSE-style distance LOD: a tile
  // 2× farther than the target gets `desiredZ = zoom - 1`. Memory
  // project_non_merc_z14_pitch_over_select.
  const eye0 = eye[0],
    eye1 = eye[1],
    eye2 = eye[2]
  const distEyeToTarget = Math.sqrt(
    (view.target[0] - eye0) ** 2 + (view.target[1] - eye1) ** 2 + (view.target[2] - eye2) ** 2,
  )

  // (`out` hoisted above the overzoom branch.)
  // 3 parallel number arrays as a structure-of-arrays stack — avoids
  // the {z, x, y} object literal allocation per push. At z=15 globe
  // ~32k node visits, so the pre-fix Node[] stack churned 32k
  // transient objects per call (already memoised once per frame by
  // iter 456, but still spikes on the first call). number[] push/
  // pop hits the JS engine's typed numeric storage fast path.
  const stackZ: number[] = [0]
  const stackX: number[] = [0]
  const stackY: number[] = [0]

  while (stackZ.length && out.length < MAX_TILES) {
    const tz = stackZ.pop()!
    const tx = stackX.pop()!
    const ty = stackY.pop()!
    // Inline tileLonLat to avoid the 4-field object allocation per
    // node visit. At z=15 globe ~32k node visits = 32k transient
    // {lonW, lonE, latN, latS} objects pre-fix. V8 hidden-class
    // sharing kept the pressure manageable but per-node object
    // alloc still showed in heap-profile traces during the
    // 2026-05-18 globe regression chase. Scalar locals match.
    // Bitshift for integer power-of-2 is ~3-5× faster than Math.pow
    // on V8 (no float coercion + IEEE handling). tz is guaranteed
    // 0..22 (camera maxZoom) so int32 doesn't overflow.
    const tileN = (1 << tz) | 0
    const lonW = (tx / tileN) * 360 - 180
    const lonE = ((tx + 1) / tileN) * 360 - 180
    const latN = Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / tileN))) * RAD2DEG
    const latS = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / tileN))) * RAD2DEG
    const lonM = (lonW + lonE) / 2
    const latM = (latN + latS) / 2
    // 5 sample lon/lat pairs — flat scalar form (no allocation).
    const ll0L = lonW,
      ll0A = latN
    const ll1L = lonE,
      ll1A = latN
    const ll2L = lonW,
      ll2A = latS
    const ll3L = lonE,
      ll3A = latS
    const ll4L = lonM,
      ll4A = latM

    let anyFront = false
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    let anyInFront = 0 // count of samples with valid clip.w (in front of near plane)
    let distCenter = 0 // 3D Euclidean dist from eye to centre sample
    // Unroll the 5-sample loop. Inline globeForward + mulVec4 + toScreen
    // so the hot path has zero array allocations per node.
    for (let si = 0; si < 5; si++) {
      const lo = si === 0 ? ll0L : si === 1 ? ll1L : si === 2 ? ll2L : si === 3 ? ll3L : ll4L
      const la = si === 0 ? ll0A : si === 1 ? ll1A : si === 2 ? ll2A : si === 3 ? ll3A : ll4A
      // Inline globeForward — sin/cos pair.
      const lam = lo * DEG2RAD
      const phi = la * DEG2RAD
      const cphi = Math.cos(phi)
      const px = EARTH_R * cphi * Math.cos(lam)
      const py = EARTH_R * cphi * Math.sin(lam)
      const pz = EARTH_R * Math.sin(phi)
      // Horizon cull check.
      if ((px * eyeN0 + py * eyeN1 + pz * eyeN2) * pn > horizonCos) anyFront = true
      // Inline mulVec4 — w-divide and screen-space conversion.
      const cw = m3 * px + m7 * py + m11 * pz + m15
      if (si === 4) {
        // 3D Euclidean dist eye → tile centre for distance-LOD.
        // Sample 4 is (lonM, latM) — see ll4L/ll4A above.
        distCenter = Math.sqrt((px - eye0) ** 2 + (py - eye1) ** 2 + (pz - eye2) ** 2)
      }
      if (cw <= 1e-6) continue
      anyInFront++
      const cx = m0 * px + m4 * py + m8 * pz + m12
      const cy = m1 * px + m5 * py + m9 * pz + m13
      const sx = (cx / cw + 1) * 0.5 * cssWidthPx
      const sy = (1 - cy / cw) * 0.5 * cssHeightPx
      if (sx < minX) minX = sx
      if (sx > maxX) maxX = sx
      if (sy < minY) minY = sy
      if (sy > maxY) maxY = sy
    }
    // Tile's projected screen AABB (across the 5 samples) vs the
    // viewport-plus-emit-pad rectangle. The previous test was
    // "ANY sample falls inside the loose 1-viewport pad" — that
    // emitted a tile when even ONE corner barely intersected the
    // wide pad, so high-pitch leaves with a single near-horizon
    // sample passed through (memory project_non_merc_z14_pitch_over_
    // select: 206 tiles emitted at p=60° vs 17 the mercator control
    // picks). True AABB overlap with a 25 % pad emits only tiles whose
    // projected box visibly intersects the viewport — same envelope as
    // the flat tile-select.ts margin (matches its `marginPctOfMax` at
    // pitch ≥ 60°). Descent path (`tooBig`/`forceDescend`) is
    // independent so children of edge-straddling tiles are still
    // visited.
    const anyOnScreenEmit =
      anyInFront > 0 && maxX >= minXEmit && minX <= maxXEmit && maxY >= minYEmit && minY <= maxYEmit
    // Sub-pixel cull (mirrors tiles-sse.ts MIN_TILE_SCREEN_AREA_PX_SQ).
    // At pitch ≥ 60° horizon tiles project to AABBs of 1-2 px per side,
    // paying full draw-call cost for ~zero visible detail. 4 px² = 2×2
    // px is the lowest reliable AA threshold. Skip the check when the
    // tile contains the camera target (forceDescend / centre-of-view
    // tile must always pass regardless of how its samples project at
    // extreme pitch).
    const screenAreaPx =
      isFinite(maxX - minX) && isFinite(maxY - minY)
        ? Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
        : 0

    // Low-zoom tiles span too much sphere for a 5-sample point test to
    // judge (a tile can straddle the visible cap while all 5 samples
    // miss it — e.g. the z=0 root when centred on the antimeridian, the
    // exact "half tiles" repro). Force descent for z ≤ 2 BEFORE the
    // hemisphere cull, mirroring the 2D selector's low-z handling
    // (tile-select.ts). The 5-sample cull only becomes reliable once
    // tiles are small relative to the sphere.
    //
    // iter 144: ALSO force descent down the single quadtree branch
    // whose lon/lat bbox contains the camera target. Root cause of
    // the 2026-05-19 non-Mercator render-fail (memory
    // project_non_mercator_systemic_2026_05_19): zoomed in, the
    // visible-cone half-angle θ=acos(EARTH_R/eyeLen) shrinks to
    // ~0.8°, so an intermediate tile (z3..~8) that CONTAINS the
    // camera still has all 5 horizon samples outside that tight
    // cone → anyFront=false → the whole branch over the camera was
    // pruned and globeVisibleTiles returned empty. Geometric
    // containment is exclusive — at most ONE tile per level
    // contains the point — so this forces at most +maxZ extra node
    // visits (NOT the 4^zFloor explosion the reverted iter-143
    // forced-descent approach caused), and it touches neither the
    // screen-AABB nor the emit gate (so the z=0 world-copy path is
    // byte-unchanged). Robust at any zoom: pure bbox containment,
    // no sample reliability assumption.
    // Pole ownership (issue #469): a globe camera can target a latitude BEYOND
    // the Web-Mercator limit (±85.0511°) — the geographic poles, which every
    // sphere-class projection renders but no Mercator tile's lat range reaches
    // (every tile's |latN| ≤ 85.0511). Without special-casing them, a pole-
    // targeting camera has containsTarget=false for EVERY tile, so the focal-
    // tile guarantee never fires; at a zoomed-in pole view the coarse root then
    // also fails anyFront (its ±85.05° samples sit outside the tiny visible
    // cap) and globeVisibleTiles returns nothing. That is invisible for normal
    // sources (their detailed rim tiles still emit) but fatal for a per-source
    // POLAR CAP: its geometry lives at lat > 85.0511 and its only tile is the
    // z=0 root (maxLevel 0 ⇒ selector maxZ 0), so an empty selection means the
    // ±5° pole disc renders black (the ocean_land Arctic hole). The pole-edge
    // column OWNS the pole: y=0 (north edge, latN=85.0511) for a north-pole
    // target, y=2^z−1 (south edge) for a south-pole target. Treat it as the
    // focal tile so the cap root is selected + drawn as an unclipped primary.
    // Guarded on the strict > limit test, so ALL sub-pole views (|lat| ≤
    // 85.0511) are byte-identical — no blast radius outside true pole views.
    const lonInTile = centerLon >= lonW && centerLon <= lonE
    const containsTarget =
      (lonInTile && centerLat >= latS && centerLat <= latN) ||
      (lonInTile && centerLat > MERCATOR_LAT_LIMIT && ty === 0) ||
      (lonInTile && centerLat < -MERCATOR_LAT_LIMIT && ty === tileN - 1)
    const forceDescend = tz < maxZ && (tz <= 2 || containsTarget)
    // Whole tile on the far hemisphere → cull (this is what makes the
    // globe show only the front side; it is NOT the dateline bug — the
    // dateline is handled by working in continuous lon/lat→sphere
    // space, so both x≈0 and x≈2^z−1 stay when facing the camera).
    // EXCEPT the focal-point tile (containsTarget): it sits at screen
    // centre and is always visible, but at low maxZ its coarse 5 corner
    // samples (lon ±180 / poles for the z0 root) can all miss the front
    // cap → anyFront=false. Never horizon-cull the focal tile.
    if (!forceDescend && !containsTarget && !anyFront) continue
    const screenSpan = Math.max(maxX - minX, maxY - minY)
    const tooBig = !isFinite(screenSpan) || screenSpan > SUBDIVIDE_PX
    // Distance-LOD (memory project_non_merc_z14_pitch_over_select):
    // SSE-style `desiredZ = zoom + log2(dT/dC)` coarsens horizon LOD
    // naturally — a tile 2× farther than the focal point hits
    // `desiredZ = zoom - 1`, so a leaf at z=14 above a z=13 desire
    // gets emitted at z=13 instead of subdividing to 4 z=14 grand-
    // children. Without this rule the pitch-driven screen-span
    // heuristic kept subdividing every branch all the way to maxZ —
    // at pitch 60°/75° that emitted 95-262 leaves on 1280×720 vs the
    // mercator SSE control's 20-36 (4-13× over-select; p95 drag
    // 144-211 ms = 5-7 fps).
    //
    // Uses 3D Euclidean distance (eye → tile centre) NOT perspective
    // clip.w. clip.w flips negative for tiles beyond the far plane —
    // those are exactly the horizon tiles we want to coarsen, so a
    // clip.w gate would miss the bug. The 3D distance is sign-stable;
    // the perspective matrix's sign is irrelevant to the perceptual
    // zoom level.
    const useDistLOD = distCenter > 0 && distEyeToTarget > 0
    const desiredZ = useDistLOD ? zoom + Math.log2(distEyeToTarget / distCenter) : Infinity
    // Descent rule: descend if EITHER the tile spans too many on-
    // screen pixels (foreground subdivision — preserves the pre-fix
    // behaviour for the camera-side branch) AND it's at or below the
    // distance-LOD's desired zoom. A horizon tile with `desiredZ ≈ 10`
    // at `tz = 11` is rejected here (11 ≥ 10) and gets emitted at
    // tz=11 instead of subdividing to 4 z=12 children that would each
    // recurse to z=14. This is the SSE pattern's "single coarse zoom
    // for the horizon strip" behaviour expressed inside the spherical
    // quadtree.
    if (tz < maxZ && (forceDescend || (tooBig && tz < Math.floor(desiredZ)))) {
      const cz = tz + 1,
        cx0 = tx * 2,
        cy0 = ty * 2
      // 4 children pushed via parallel arrays (no object literal).
      stackZ.push(cz, cz, cz, cz)
      stackX.push(cx0, cx0 + 1, cx0, cx0 + 1)
      stackY.push(cy0, cy0, cy0 + 1, cy0 + 1)
      continue
    }
    // Emit gate: front-hemisphere + viewport-overlap + non-trivial
    // screen size (sub-pixel cull). containsTarget tile passes
    // unconditionally so the camera-foot is never dropped.
    const MIN_TILE_SCREEN_AREA_PX_SQ = 4
    // The tile geometrically containing the camera target is the finest LOD
    // over the centre of view — always visible, so emit it even when its
    // coarse 5 corner/centre samples miss the on-screen region. Without this
    // the z0 root over an off-centre lon (samples at lon ±180 / poles) failed
    // anyFront/anyOnScreenEmit and the whole frame selected ZERO tiles → a
    // black canvas for flat ortho/azi/stereo at z0 p0 (the long-standing
    // project_non_merc_z0_disc_render_fail "blank z0" symptom). containsTarget
    // reaches the emit gate only as a leaf (tz === maxZ); at tz < maxZ it
    // force-descends, so this adds at most the focal column — one tile
    // generically, up to four when the camera centre lands exactly on a tile
    // corner (inclusive bbox test; e.g. lon0/lat0) — all genuinely covering it.
    if (
      containsTarget ||
      (anyFront && anyOnScreenEmit && screenAreaPx >= MIN_TILE_SCREEN_AREA_PX_SQ)
    ) {
      out.push({ z: tz, x: tx, y: ty, ox: tx })
    }
  }
  _globeTilesCacheKey = key
  _globeTilesCacheResult = out
  return out
}
