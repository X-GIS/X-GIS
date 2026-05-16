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
 */
export function buildGlobeMatrix(
  centerLon: number, centerLat: number,
  zoom: number, pitchDeg: number, bearingDeg: number,
  cssWidthPx: number, cssHeightPx: number,
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
  // Eye direction from the target: radial at pitch 0, tilting toward
  // -heading as pitch grows so the camera looks along +heading.
  const eyeDir: Vec3 = norm([
    Math.cos(pitch) * n[0] - Math.sin(pitch) * heading[0],
    Math.cos(pitch) * n[1] - Math.sin(pitch) * heading[1],
    Math.cos(pitch) * n[2] - Math.sin(pitch) * heading[2],
  ])
  const eye: Vec3 = [
    target[0] + alt * eyeDir[0],
    target[1] + alt * eyeDir[1],
    target[2] + alt * eyeDir[2],
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

  // Perspective — identical convention to Camera._buildRTCMatrix.
  const aspect = cssWidthPx / cssHeightPx
  const f = 1 / Math.tan(FOV_RAD / 2)
  const eyeDist = len(eye) // distance from sphere centre
  const near = Math.max(1, alt * 0.01)
  // Far must reach the back of the visible sphere: eye→far-limb is at
  // most eyeDist + R. ×1.5 leaves headroom like the 2D path.
  const far = (eyeDist + EARTH_R) * 1.5
  const nf = 1 / (near - far)
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

function tileLonLat(z: number, x: number, y: number): { lonW: number; lonE: number; latN: number; latS: number } {
  const n = Math.pow(2, z)
  const lonW = x / n * 360 - 180
  const lonE = (x + 1) / n * 360 - 180
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * RAD2DEG
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * RAD2DEG
  return { lonW, lonE, latN, latS }
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
export function globeVisibleTiles(
  centerLon: number, centerLat: number,
  zoom: number, maxZ: number,
  cssWidthPx: number, cssHeightPx: number,
  pitchDeg = 0, bearingDeg = 0,
): GlobeTile[] {
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
  const MAX_TILES = 512

  const toScreen = (p: Vec3): [number, number, number] | null => {
    const cl = mulVec4(mvp, [p[0], p[1], p[2], 1])
    if (cl[3] <= 1e-6) return null
    return [
      (cl[0] / cl[3] + 1) * 0.5 * cssWidthPx,
      (1 - cl[1] / cl[3]) * 0.5 * cssHeightPx,
      cl[2] / cl[3],
    ]
  }

  const out: GlobeTile[] = []
  type Node = { z: number; x: number; y: number }
  const stack: Node[] = [{ z: 0, x: 0, y: 0 }]

  while (stack.length && out.length < MAX_TILES) {
    const t = stack.pop()!
    const { lonW, lonE, latN, latS } = tileLonLat(t.z, t.x, t.y)
    const lonM = (lonW + lonE) / 2
    const latM = (latN + latS) / 2
    const samples: Array<[number, number]> = [
      [lonW, latN], [lonE, latN], [lonW, latS], [lonE, latS], [lonM, latM],
    ]

    let anyFront = false
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let anyOnScreen = false
    for (const [lo, la] of samples) {
      const p = globeForward(lo, la)
      const pn = 1 / EARTH_R
      const facing = (p[0] * eyeN[0] + p[1] * eyeN[1] + p[2] * eyeN[2]) * pn
      if (facing > horizonCos) anyFront = true
      const s = toScreen(p)
      if (s) {
        if (s[0] < minX) minX = s[0]
        if (s[0] > maxX) maxX = s[0]
        if (s[1] < minY) minY = s[1]
        if (s[1] > maxY) maxY = s[1]
        if (s[0] >= -cssWidthPx * 0.5 && s[0] <= cssWidthPx * 1.5 &&
            s[1] >= -cssHeightPx * 0.5 && s[1] <= cssHeightPx * 1.5) {
          anyOnScreen = true
        }
      }
    }

    // Low-zoom tiles span too much sphere for a 5-sample point test to
    // judge (a tile can straddle the visible cap while all 5 samples
    // miss it — e.g. the z=0 root when centred on the antimeridian, the
    // exact "half tiles" repro). Force descent for z ≤ 2 BEFORE the
    // hemisphere cull, mirroring the 2D selector's low-z handling
    // (tile-select.ts). The 5-sample cull only becomes reliable once
    // tiles are small relative to the sphere.
    const forceDescend = t.z < maxZ && t.z <= 2
    // Whole tile on the far hemisphere → cull (this is what makes the
    // globe show only the front side; it is NOT the dateline bug — the
    // dateline is handled by working in continuous lon/lat→sphere
    // space, so both x≈0 and x≈2^z−1 stay when facing the camera).
    if (!forceDescend && !anyFront) continue
    const screenSpan = Math.max(maxX - minX, maxY - minY)
    const tooBig = !isFinite(screenSpan) || screenSpan > SUBDIVIDE_PX
    if (t.z < maxZ && (forceDescend || tooBig)) {
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          stack.push({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy })
      continue
    }
    if (anyFront && anyOnScreen) {
      out.push({ z: t.z, x: t.x, y: t.y, ox: t.x })
    }
  }
  return out
}
