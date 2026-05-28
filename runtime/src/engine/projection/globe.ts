// ═══ True 3D Globe (projType = 7) ═══
//
// The existing "globe-looking" projections (orthographic / azimuthal /
// stereographic, projType 3/4/5) are FLAT 2D azimuthal projections —
// `forward(lon,lat) -> [x,y]` onto a plane. The 2D map camera then
// applies pitch as a tilt of that plane, so pitching them just lays the
// flat disc on its side ("지도가 2D로 눕는다"). They are mathematically
// correct 2D projections and stay untouched (CPU/GPU consistency
// contract); this module adds a SEPARATE true 3D sphere mode instead.
//
// Slice 1 (this file): CPU core + interaction, all unit-testable.
//   - globeForward / globeInverse : (lon,lat) ↔ ECEF point on a sphere
//   - buildGlobeMatrix            : orbit camera (pitch keeps it 3D)
//   - unprojectGlobe              : ray↔sphere (replaces the z=0 plane
//                                   assumption for pan/zoom/tile select)
//   - globeVisibleTiles           : visible-cap tile selection — wraps
//                                   the dateline by construction
// Renderer vertex-shader propagation (project()->vec3 + WGSL mirror) is
// a deliberately separate slice: it needs a GPU to verify and this
// environment has none.

import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { MERCATOR_LAT_LIMIT } from './projection'

// Matches projection.ts EARTH_RADIUS exactly — the same sphere the 2D
// projections scale by, so globe zoom lines up with the 2D pyramid.
export const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** Dispatch id for the true 3D globe. 0..6 are the existing projections
 *  (see shaders/projection.ts); 7 is appended so the existing encoding
 *  and every projType 0..6 path stay byte-identical. */
export const GLOBE_PROJ_TYPE = 7

export const GLOBE_NAME = 'globe'

type Vec3 = [number, number, number]

// ── small vec3 helpers (local; the engine has no shared vec3 lib) ──
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const len = (a: Vec3): number => Math.sqrt(dot(a, a))
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** (lon,lat)° → point on the sphere of radius EARTH_R.
 *  Convention: lon=0,lat=0 → +X ; east → +Y ; north pole → +Z.
 *  This is the single source for the globe's geometry; the future
 *  WGSL `proj_globe` mirror (renderer slice) must match it exactly. */
export function globeForward(lon: number, lat: number): Vec3 {
  const lam = lon * DEG2RAD
  const phi = lat * DEG2RAD
  const cphi = Math.cos(phi)
  return [
    EARTH_R * cphi * Math.cos(lam),
    EARTH_R * cphi * Math.sin(lam),
    EARTH_R * Math.sin(phi),
  ]
}

/** Sphere point → (lon,lat)°. Inverse of globeForward (radius-agnostic:
 *  any point on the ray from the origin maps to the same lon/lat). */
export function globeInverse(x: number, y: number, z: number): [number, number] {
  const r = Math.sqrt(x * x + y * y + z * z) || 1
  const lat = Math.asin(Math.max(-1, Math.min(1, z / r))) * RAD2DEG
  const lon = Math.atan2(y, x) * RAD2DEG
  return [lon, lat]
}

/** Local east/north tangent unit vectors at (lon,lat). */
function localFrame(lon: number, lat: number): { up: Vec3; east: Vec3; north: Vec3 } {
  const lam = lon * DEG2RAD
  const phi = lat * DEG2RAD
  const slam = Math.sin(lam), clam = Math.cos(lam)
  const sphi = Math.sin(phi), cphi = Math.cos(phi)
  return {
    up: [cphi * clam, cphi * slam, sphi], // radial (surface normal)
    east: [-slam, clam, 0],
    north: [-sphi * clam, -sphi * slam, cphi],
  }
}

const FOV_RAD = 0.6435011087932844 // == Camera.FOV, MapLibre default

/** Camera altitude above the surface for a web-mercator-style `zoom`.
 *  Identical formula to Camera._buildRTCMatrix so a given numeric zoom
 *  frames the globe at the same scale as the 2D map at that zoom. */
export function globeAltitude(zoom: number, cssHeightPx: number): number {
  const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, zoom)
  const viewHeightMeters = cssHeightPx * metersPerPixel
  return viewHeightMeters / 2 / Math.tan(FOV_RAD / 2)
}

export interface GlobeView {
  /** Column-major MVP (P × lookAt), ABSOLUTE sphere coords. Used by
   *  unproject (ray↔sphere) and the camera/unit tests. */
  matrix: Float32Array
  /** Column-major MVP relative to the focus point (RTC): the vertex
   *  shaders feed `proj_globe(lon,lat) − proj_globe(clon,clat)` (= the
   *  sphere point minus the focus) into THIS, exactly mirroring the 2D
   *  path's `project(v) − project(center)` RTC scheme — keeps f32
   *  vertex precision on a 6.3 Mm sphere. */
  rtcMatrix: Float32Array
  /** Eye position in sphere coords. */
  eye: Vec3
  /** Look-at target = surface point at (centerLon, centerLat) = the
   *  RTC origin the shader subtracts. */
  target: Vec3
  near: number
  far: number
}

// Column-major 4×4 × 4×4 → out (same convention as camera.ts mul4).
function mul4(out: number[], a: number[], b: number[]): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
}

/** Build the orbit-camera view-projection for the globe.
 *
 *  pitch=0  → eye straight out along the surface normal at the centre
 *             (top-down view of that point); the globe is a sphere in
 *             front of the camera, NOT a flattened disc.
 *  pitch>0  → eye tilts off the normal toward the `bearing` heading and
 *             looks across the curved surface toward the limb — the
 *             sphere stays 3D (this is the fix for the reported
 *             "globe pitch → 2D" bug).
 *  bearing  → rotates the tilt/heading around the surface normal.
 *
 *  `ortho`  → use a PARALLEL (orthographic) projection instead of the
 *             perspective one. The orbit eye/lookAt (and thus the
 *             pitch/bearing tilt) are unchanged; only the projection
 *             matrix differs. With the half-extents tied to the same
 *             metres-per-pixel as the 2D pyramid, an `ortho` globe at
 *             pitch=0 is byte-identical to the flat 2D orthographic
 *             disc (orthographic projection of a sphere along the
 *             surface normal IS that disc), and pitch>0 is a true
 *             no-perspective 3D tilt. Used by the azimuthal projection
 *             set; the true `globe` leaves this false (perspective).
 */
export function buildGlobeMatrix(
  centerLon: number, centerLat: number,
  zoom: number, pitchDeg: number, bearingDeg: number,
  cssWidthPx: number, cssHeightPx: number,
  ortho = false,
): GlobeView {
  const target = globeForward(centerLon, centerLat)
  const { up: n, east, north } = localFrame(centerLon, centerLat)
  const pitch = pitchDeg * DEG2RAD
  const bearing = bearingDeg * DEG2RAD

  // Heading tangent: bearing 0 leans toward local north, +90° toward east.
  const heading: Vec3 = [
    Math.cos(bearing) * north[0] + Math.sin(bearing) * east[0],
    Math.cos(bearing) * north[1] + Math.sin(bearing) * east[1],
    Math.cos(bearing) * north[2] + Math.sin(bearing) * east[2],
  ]

  const alt = globeAltitude(zoom, cssHeightPx)
  // The azimuthal set asks for an ORTHOGRAPHIC (parallel) tilt. A true
  // parallel matrix has clip.w ≡ 1, which collapses the w-driven
  // log-depth buffer to a constant → the far hemisphere is no longer
  // depth-occluded and renders THROUGH the near one ("뒷면 렌더링").
  // Instead we keep the proven perspective orbit camera (clip.w varies,
  // so log-depth + front/back occlusion work exactly as the shipped
  // globe) but push the eye far back and narrow the FOV by the SAME
  // factor: on-screen framing is preserved while perspective
  // foreshortening across the sphere shrinks to ~1/ORTHO_TELE — a
  // telephoto that is visually parallel (≈0.6% at whole-globe zoom).
  const ORTHO_TELE = 96
  const tele = ortho ? ORTHO_TELE : 1
  const altUse = alt * tele
  // Eye direction from the target: radial at pitch 0, tilting toward
  // -heading as pitch grows so the camera looks along +heading.
  const eyeDir: Vec3 = norm([
    Math.cos(pitch) * n[0] - Math.sin(pitch) * heading[0],
    Math.cos(pitch) * n[1] - Math.sin(pitch) * heading[1],
    Math.cos(pitch) * n[2] - Math.sin(pitch) * heading[2],
  ])
  const eye: Vec3 = [
    target[0] + altUse * eyeDir[0],
    target[1] + altUse * eyeDir[1],
    target[2] + altUse * eyeDir[2],
  ]

  // lookAt (right-handed, camera looks down -Z), column-major.
  const fwd = norm(sub(target, eye))
  // Use the surface normal as the up hint; fall back if degenerate
  // (eyeDir ~ ±n, i.e. pitch ~ 0 — fwd ~ -n so cross(fwd,n) ~ 0).
  let upHint: Vec3 = n
  if (Math.abs(dot(fwd, n)) > 0.999) upHint = heading
  const s = norm(cross(fwd, upHint)) // right
  const u = cross(s, fwd) // true up
  const view = [
    s[0], u[0], -fwd[0], 0,
    s[1], u[1], -fwd[1], 0,
    s[2], u[2], -fwd[2], 0,
    -dot(s, eye), -dot(u, eye), dot(fwd, eye), 1,
  ]

  const aspect = cssWidthPx / cssHeightPx
  // Narrow the FOV by the same factor the eye was pushed back: the
  // tangent ratio (object_size / distance) that sets on-screen size is
  // invariant, so framing matches the 2D orthographic scale at every
  // zoom while the camera behaves as a near-parallel telephoto.
  const f = (1 / Math.tan(FOV_RAD / 2)) * tele
  const eyeDist = len(eye) // distance from sphere centre
  // Perspective globe keeps its original near/far. The telephoto camera
  // pushes the eye ~ORTHO_TELE× farther, so the old `alt*0.01 .. (eyeDist
  // +R)*1.5` would strand the whole sphere in a sliver of the depth
  // range and re-open the front/back z-fight — bracket it tightly to the
  // shell (within R of the limb-tangent, ±1.5 R headroom) instead.
  const near = ortho ? Math.max(1, eyeDist - EARTH_R * 1.5) : Math.max(1, alt * 0.01)
  const far = ortho ? eyeDist + EARTH_R * 1.5 : (eyeDist + EARTH_R) * 1.5
  const nf = 1 / (near - far)

  // Perspective — identical convention to Camera._buildRTCMatrix. With
  // the telephoto f/eye this is visually parallel yet keeps a varying
  // clip.w so the shared log-depth buffer occludes the far hemisphere.
  const P = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]

  const out = new Array(16)
  mul4(out, P, view)

  // RTC variant: same rotation (direction-only, translation-invariant),
  // eye expressed relative to the focus so the shader can subtract the
  // focus from each vertex. lookAt is invariant under shifting eye AND
  // target by the same vector, so this is the exact RTC of `matrix`.
  const eyeR = sub(eye, target)
  const rtcView = [
    s[0], u[0], -fwd[0], 0,
    s[1], u[1], -fwd[1], 0,
    s[2], u[2], -fwd[2], 0,
    -dot(s, eyeR), -dot(u, eyeR), dot(fwd, eyeR), 1,
  ]
  const rtcOut = new Array(16)
  mul4(rtcOut, P, rtcView)

  return { matrix: new Float32Array(out), rtcMatrix: new Float32Array(rtcOut), eye, target, near, far }
}

/** Invert a column-major 4×4 (mirror of camera.ts invert4x4 — kept
 *  local so this module stays standalone / independently testable). */
function invert4x4(m: ArrayLike<number>): Float32Array | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (Math.abs(det) < 1e-15) return null
  det = 1 / det
  const o = new Float32Array(16)
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return o
}

function mulVec4(m: ArrayLike<number>, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}

/** Screen pixel → (lon,lat)° by intersecting the eye ray with the
 *  sphere. Returns null if the ray misses the globe (points at empty
 *  space past the limb). This REPLACES the z=0-plane unproject for
 *  globe mode — pan/zoom/tile-selection all need a real sphere hit,
 *  not an intersection with a flat ground plane that doesn't exist
 *  here. `screenX/Y` and `w/h` are in the same pixel basis (device or
 *  CSS — consistent with the matrix's aspect). */
export function unprojectGlobe(
  screenX: number, screenY: number,
  w: number, h: number,
  view: GlobeView,
): [number, number] | null {
  const inv = invert4x4(view.matrix)
  if (!inv) return null
  const ndcX = (screenX / w) * 2 - 1
  const ndcY = 1 - (screenY / h) * 2
  const n4 = mulVec4(inv, [ndcX, ndcY, -1, 1])
  const f4 = mulVec4(inv, [ndcX, ndcY, 1, 1])
  const nx = n4[0] / n4[3], ny = n4[1] / n4[3], nz = n4[2] / n4[3]
  const fx = f4[0] / f4[3], fy = f4[1] / f4[3], fz = f4[2] / f4[3]
  const ox = nx, oy = ny, oz = nz
  const dx = fx - nx, dy = fy - ny, dz = fz - nz
  // Solve |o + t·d|² = R²
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (ox * dx + oy * dy + oz * dz)
  const c = ox * ox + oy * oy + oz * oz - EARTH_R * EARTH_R
  const disc = b * b - 4 * a * c
  if (disc < 0 || a < 1e-12) return null // ray misses the globe
  const sq = Math.sqrt(disc)
  const t0 = (-b - sq) / (2 * a)
  const t1 = (-b + sq) / (2 * a)
  // Nearest hit in front of the near plane (t ≥ 0 along near→far).
  let t = -1
  if (t0 >= 0) t = t0
  else if (t1 >= 0) t = t1
  if (t < 0) return null
  return globeInverse(ox + t * dx, oy + t * dy, oz + t * dz)
}

/** TileCoord-shaped result. Structurally identical to
 *  data/tile-select.ts `TileCoord` / `makeTileCoord(z,x,y,0)` output;
 *  declared locally so this module has no import cycle with the data
 *  layer. The globe renders a single world (no Mercator world copies)
 *  so `ox === x` always. */
export interface GlobeTile { z: number; x: number; y: number; ox: number }

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
  centerLon: number, centerLat: number,
  zoom: number, maxZ: number,
  cssWidthPx: number, cssHeightPx: number,
  pitchDeg = 0, bearingDeg = 0,
): GlobeTile[] {
  // Memo lookup. String key is round-tripped through toFixed(4) so
  // micro-jitter (1e-9 lon drift after a re-projection) doesn't blow
  // the cache on every frame; 4 decimals of lon ≈ 11m at equator
  // which is well below tile-pixel resolution at z=22.
  const key = `${centerLon.toFixed(4)}|${centerLat.toFixed(4)}|${zoom.toFixed(3)}|${maxZ}|${cssWidthPx.toFixed(0)}|${cssHeightPx.toFixed(0)}|${pitchDeg.toFixed(2)}|${bearingDeg.toFixed(2)}`
  if (key === _globeTilesCacheKey) return _globeTilesCacheResult
  const view = buildGlobeMatrix(
    centerLon, centerLat, zoom, pitchDeg, bearingDeg, cssWidthPx, cssHeightPx,
  )
  const mvp = view.matrix
  const eye = view.eye
  const eyeLen = len(eye) || 1
  // A surface point P is visible only if it faces the eye:
  // dot(normalize(P), normalize(eye)) > R/|eye|  (horizon cut).
  const horizonCos = EARTH_R / eyeLen
  const eyeN: Vec3 = [eye[0] / eyeLen, eye[1] / eyeLen, eye[2] / eyeLen]

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
    const W = cssWidthPx, H = cssHeightPx
    const probes: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [W, 0], [0, H], [W, H], [W * 0.5, H * 0.5],
      [W * 0.5, 0], [W * 0.5, H], [0, H * 0.5], [W, H * 0.5],
    ]
    let lonMin = Infinity, lonMax = -Infinity
    let latMin = Infinity, latMax = -Infinity
    let hits = 0
    for (const [sx, sy] of probes) {
      const ll = unprojectGlobe(sx, sy, W, H, view)
      if (!ll) continue
      hits++
      const lo = ll[0], la = ll[1]
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
        Math.min(tileN - 1, Math.max(0,
          Math.floor(((lo + 180) / 360) * tileN)))
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
  const m0 = mvp[0]!, m1 = mvp[1]!, m3 = mvp[3]!
  const m4 = mvp[4]!, m5 = mvp[5]!, m7 = mvp[7]!
  const m8 = mvp[8]!, m9 = mvp[9]!, m11 = mvp[11]!
  const m12 = mvp[12]!, m13 = mvp[13]!, m15 = mvp[15]!
  const pn = 1 / EARTH_R
  const eyeN0 = eyeN[0], eyeN1 = eyeN[1], eyeN2 = eyeN[2]
  // Eye position in world coords + distance from eye to camera target
  // (the focal point) — basis for the SSE-style distance LOD: a tile
  // 2× farther than the target gets `desiredZ = zoom - 1`. Memory
  // project_non_merc_z14_pitch_over_select.
  const eye0 = eye[0], eye1 = eye[1], eye2 = eye[2]
  const distEyeToTarget = Math.sqrt(
    (view.target[0] - eye0) ** 2
    + (view.target[1] - eye1) ** 2
    + (view.target[2] - eye2) ** 2,
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
    const lonW = tx / tileN * 360 - 180
    const lonE = (tx + 1) / tileN * 360 - 180
    const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tileN))) * RAD2DEG
    const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tileN))) * RAD2DEG
    const lonM = (lonW + lonE) / 2
    const latM = (latN + latS) / 2
    // 5 sample lon/lat pairs — flat scalar form (no allocation).
    const ll0L = lonW, ll0A = latN
    const ll1L = lonE, ll1A = latN
    const ll2L = lonW, ll2A = latS
    const ll3L = lonE, ll3A = latS
    const ll4L = lonM, ll4A = latM

    let anyFront = false
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let anyInFront = 0  // count of samples with valid clip.w (in front of near plane)
    let distCenter = 0  // 3D Euclidean dist from eye to centre sample
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
    const anyOnScreenEmit = anyInFront > 0
      && maxX >= minXEmit && minX <= maxXEmit
      && maxY >= minYEmit && minY <= maxYEmit
    // Sub-pixel cull (mirrors tiles-sse.ts MIN_TILE_SCREEN_AREA_PX_SQ).
    // At pitch ≥ 60° horizon tiles project to AABBs of 1-2 px per side,
    // paying full draw-call cost for ~zero visible detail. 4 px² = 2×2
    // px is the lowest reliable AA threshold. Skip the check when the
    // tile contains the camera target (forceDescend / centre-of-view
    // tile must always pass regardless of how its samples project at
    // extreme pitch).
    const screenAreaPx = isFinite(maxX - minX) && isFinite(maxY - minY)
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
    const containsTarget =
      centerLon >= lonW && centerLon <= lonE
      && centerLat >= latS && centerLat <= latN
    const forceDescend = tz < maxZ && (tz <= 2 || containsTarget)
    // Whole tile on the far hemisphere → cull (this is what makes the
    // globe show only the front side; it is NOT the dateline bug — the
    // dateline is handled by working in continuous lon/lat→sphere
    // space, so both x≈0 and x≈2^z−1 stay when facing the camera).
    if (!forceDescend && !anyFront) continue
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
    const desiredZ = useDistLOD
      ? zoom + Math.log2(distEyeToTarget / distCenter)
      : Infinity
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
      const cz = tz + 1, cx0 = tx * 2, cy0 = ty * 2
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
    if (anyFront && anyOnScreenEmit
      && (containsTarget || screenAreaPx >= MIN_TILE_SCREEN_AREA_PX_SQ)) {
      out.push({ z: tz, x: tx, y: ty, ox: tx })
    }
  }
  _globeTilesCacheKey = key
  _globeTilesCacheResult = out
  return out
}
