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

import { WORLD_MERC, TILE_PX } from './world-scale'
import { flatViewHeightCapM } from './projections-table'
import { mul4, perspectiveMatrix } from '@xgis/shared'
import { EARTH, ecefToLonLat } from '@xgis/shared'

// Matches projection.ts EARTH_RADIUS exactly — the same sphere the 2D
// projections scale by, so globe zoom lines up with the 2D pyramid.
export const EARTH_R = EARTH.sphereR
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** Dispatch id for the true 3D globe. 0..6 are the existing projections
 *  (see shaders/projection.ts); 7 is appended so the existing encoding
 *  and every projType 0..6 path stay byte-identical. */
export const GLOBE_PROJ_TYPE = 7

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
  return [EARTH_R * cphi * Math.cos(lam), EARTH_R * cphi * Math.sin(lam), EARTH_R * Math.sin(phi)]
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
  const slam = Math.sin(lam),
    clam = Math.cos(lam)
  const sphi = Math.sin(phi),
    cphi = Math.cos(phi)
  return {
    up: [cphi * clam, cphi * slam, sphi], // radial (surface normal)
    east: [-slam, clam, 0],
    north: [-sphi * clam, -sphi * slam, cphi],
  }
}

const FOV_RAD = 0.6435011087932844 // == Camera.FOV, MapLibre default

/** Camera altitude above the surface for a web-mercator-style `zoom`.
 *  Identical formula to Camera._buildRTCMatrix so a given numeric zoom
 *  frames the globe at the same scale as the 2D map at that zoom.
 *
 *  `ortho`/`projType` — the azimuthal-promoted-to-globe path (orthographic
 *  3 / azimuthal_eq 4 / stereographic 5 tilted) MUST keep the SAME screen
 *  scale as the flat 2D disc at the pitch=0 boundary, or the disc jumps
 *  size the instant the user tilts (project: azimuthal-disc-pitch-framing).
 *  The perspective globe (projType 7, ortho=false) keeps its own
 *  `zoom<1`-gated sphere cap byte-identical. For the ortho branch the
 *  altitude is driven from the EXACT flat-path cap (`flatViewHeightCapM`,
 *  the same per-projType policy `_buildRTCMatrix` uses for pitch=0): the
 *  uncapped/zoom<1 rule above gives the WRONG altitude at z≥1 for ortho
 *  (2.45× too high → disc 2.5× too small) and at z<1 for azi/stereo (0.32×
 *  → disc ~3× too big). Using the flat cap with NO zoom gate makes the
 *  telephoto silhouette radius equal the flat-disc altitude at every zoom,
 *  so pitch>0 only tilts the SAME-scale disc. */
export function globeAltitude(
  zoom: number,
  cssHeightPx: number,
  ortho = false,
  projType = GLOBE_PROJ_TYPE,
): number {
  const metersPerPixel = WORLD_MERC / TILE_PX / Math.pow(2, zoom)
  const rawViewHeightMeters = cssHeightPx * metersPerPixel
  if (ortho) {
    // Azimuthal-promoted disc: drive altitude from the flat-path cap so
    // it is CONTINUOUS with the flat 2D disc at pitch=0. 2·EARTH_R for
    // ortho (3), WORLD_MERC for azi_eq/stereo (4/5) — single source of
    // truth shared with the flat MVP (flatViewHeightCapM).
    const viewHeightMeters = Math.min(rawViewHeightMeters, flatViewHeightCapM(projType, WORLD_MERC))
    return viewHeightMeters / 2 / Math.tan(FOV_RAD / 2)
  }
  // #450: NO z<1 cap. The perspective globe follows MapLibre's mercator pixel
  // scale at every zoom — disc diameter ≈ worldSize/π — so it SHRINKS as you
  // zoom out (z0 ≈ 150 px, matching ML). The earlier `min(raw, 2·EARTH_R)` cap
  // clamped the z<1 view height to the sphere diameter, forcing the globe to
  // ~3× ML's size (a near-full-viewport disc that, under pitch, became the
  // reported #450 grazing close-up). The azimuthal/ortho DISC keeps its own
  // flatViewHeightCapM (the ortho branch above); this touches only the true
  // perspective globe, and only at z<1 (z≥1 was already uncapped, so the
  // foreshortening tests at globe.test.ts:331 are unaffected).
  return rawViewHeightMeters / 2 / Math.tan(FOV_RAD / 2)
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
  centerLon: number,
  centerLat: number,
  zoom: number,
  pitchDeg: number,
  bearingDeg: number,
  cssWidthPx: number,
  cssHeightPx: number,
  ortho = false,
  projType = GLOBE_PROJ_TYPE,
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

  const alt = globeAltitude(zoom, cssHeightPx, ortho, projType)
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
    s[0],
    u[0],
    -fwd[0],
    0,
    s[1],
    u[1],
    -fwd[1],
    0,
    s[2],
    u[2],
    -fwd[2],
    0,
    -dot(s, eye),
    -dot(u, eye),
    dot(fwd, eye),
    1,
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
  // Perspective — identical convention to Camera._buildRTCMatrix. With
  // the telephoto f/eye this is visually parallel yet keeps a varying
  // clip.w so the shared log-depth buffer occludes the far hemisphere.
  const P = perspectiveMatrix(f, near, far, aspect)

  const out = new Array(16)
  mul4(out, P, view)

  // RTC variant: same rotation (direction-only, translation-invariant),
  // eye expressed relative to the focus so the shader can subtract the
  // focus from each vertex. lookAt is invariant under shifting eye AND
  // target by the same vector, so this is the exact RTC of `matrix`.
  const eyeR = sub(eye, target)
  const rtcView = [
    s[0],
    u[0],
    -fwd[0],
    0,
    s[1],
    u[1],
    -fwd[1],
    0,
    s[2],
    u[2],
    -fwd[2],
    0,
    -dot(s, eyeR),
    -dot(u, eyeR),
    dot(fwd, eyeR),
    1,
  ]
  const rtcOut = new Array(16)
  mul4(rtcOut, P, rtcView)

  return {
    matrix: new Float32Array(out),
    rtcMatrix: new Float32Array(rtcOut),
    eye,
    target,
    near,
    far,
  }
}

/** Invert a column-major 4×4 (mirror of camera.ts invert4x4 — kept
 *  local so this module stays standalone / independently testable). */
function invert4x4(m: ArrayLike<number>): Float32Array | null {
  const a00 = m[0],
    a01 = m[1],
    a02 = m[2],
    a03 = m[3]
  const a10 = m[4],
    a11 = m[5],
    a12 = m[6],
    a13 = m[7]
  const a20 = m[8],
    a21 = m[9],
    a22 = m[10],
    a23 = m[11]
  const a30 = m[12],
    a31 = m[13],
    a32 = m[14],
    a33 = m[15]
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32
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

function mulVec4(
  m: ArrayLike<number>,
  v: [number, number, number, number],
): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}

/** Screen pixel → (lon,lat)° by intersecting the eye ray with the WGS84
 *  ELLIPSOID (scale-to-sphere trick). Returns null if the ray misses the
 *  globe (points at empty space past the limb). This REPLACES the z=0-plane
 *  unproject for globe mode — pan/zoom/tile-selection and cursor/pick/measure
 *  all need a real ellipsoid hit, not an intersection with a flat ground
 *  plane that doesn't exist here. `screenX/Y` and `w/h` are in the same pixel
 *  basis (device or CSS — consistent with the matrix's aspect).
 *
 *  INC-2 boundary (docs/architecture/design/ellipsoid-datum-unification.md):
 *  the READBACK path (this function) intersects the WGS84 ellipsoid and
 *  inverts via the ellipsoidal `ecefToLonLat` (Bowring geodetic), so
 *  cursor/pick/measure return the same geodetic datum the vector tiles /
 *  point anchors already use (unified in INC-1). Everything on the RENDER /
 *  camera side deliberately stays SPHERE-based here — the surface geometry
 *  (`globeForward`, `buildGlobeMatrix` focus, the raster grid) and the sphere
 *  horizon stack (`eyeHorizon`, `globeVisibleTiles`, the GPU under-occluder
 *  cull) move to the ellipsoid together in INC-3 (which also unifies the
 *  deliberate CPU/GPU `e2` divergence and re-runs the df64 battery). Until
 *  then a bounded sub-degree geodetic/geocentric readback offset between the
 *  ellipsoid unproject and the still-spherical surface is the known,
 *  documented cost of splitting the increment.
 *
 *  `ellipsoid` — pass `false` to keep the pre-INC-2 SPHERE behaviour (k = 1
 *  intersection + spherical `globeInverse`). The globe TILE selector
 *  (`globeVisibleTiles`, data package) sets this so its Web-Mercator tile
 *  bbox stays on the sphere IN LOCKSTEP with the still-spherical render +
 *  `eyeHorizon` cull; it flips to the ellipsoid together with them in INC-3.
 *  The cursor/pick/measure + pan/zoom anchor readback path uses the default. */
export function unprojectGlobe(
  screenX: number,
  screenY: number,
  w: number,
  h: number,
  view: GlobeView,
  ellipsoid = true,
): [number, number] | null {
  const inv = invert4x4(view.matrix)
  if (!inv) return null
  const ndcX = (screenX / w) * 2 - 1
  const ndcY = 1 - (screenY / h) * 2
  const n4 = mulVec4(inv, [ndcX, ndcY, -1, 1])
  const f4 = mulVec4(inv, [ndcX, ndcY, 1, 1])
  const nx = n4[0] / n4[3],
    ny = n4[1] / n4[3],
    nz = n4[2] / n4[3]
  const fx = f4[0] / f4[3],
    fy = f4[1] / f4[3],
    fz = f4[2] / f4[3]
  const ox = nx,
    oy = ny,
    oz = nz
  const dx = fx - nx,
    dy = fy - ny,
    dz = fz - nz
  // Intersect the WGS84 ellipsoid x²/a² + y²/a² + z²/b² = 1 via the
  // scale-to-sphere trick: scaling z by k = a/b maps the ellipsoid onto the
  // sphere of radius a (= EARTH_R). Scaling is linear, so the ray PARAMETER t
  // is invariant under it — we solve the quadratic in the scaled frame, then
  // evaluate the hit on the ORIGINAL (unscaled) ray, so the direction never
  // needs re-normalising. k = 1 for a perfect sphere (f = 0) OR when the caller
  // opts out via `ellipsoid = false`, so both reduce byte-for-byte to the
  // previous sphere intersection.
  const k = ellipsoid ? EARTH.a / EARTH.b : 1
  const ozk = oz * k,
    dzk = dz * k
  // Solve |(ox,oy,ozk) + t·(dx,dy,dzk)|² = a²
  const a = dx * dx + dy * dy + dzk * dzk
  const b = 2 * (ox * dx + oy * dy + ozk * dzk)
  const c = ox * ox + oy * oy + ozk * ozk - EARTH_R * EARTH_R
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
  const hx = ox + t * dx,
    hy = oy + t * dy,
    hz = oz + t * dz
  // Readback (default): invert via the ELLIPSOIDAL Bowring solution (geodetic
  // lat), NOT the spherical asin used by globeInverse — this is the INC-2 datum
  // fix. `ellipsoid = false` keeps the spherical inverse for the INC-3-deferred
  // sphere callers (tile selector).
  if (!ellipsoid) return globeInverse(hx, hy, hz)
  const [lon, lat] = ecefToLonLat(hx, hy, hz, EARTH)
  return [lon, lat]
}
