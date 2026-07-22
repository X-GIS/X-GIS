import { describe, it, expect } from 'vitest'
import { buildGlobeMatrix, unprojectGlobe, EARTH_R } from './globe'
import { EARTH } from '@xgis/shared'
import { WORLD_MERC, TILE_PX } from './world-scale'

// ═══ Globe unproject — inverse-matrix precision gate (interaction jitter) ═══
//
// Companion to raster-globe-jitter.test.ts (which gates the GPU tile arm). This
// gates the CPU INTERACTION arm: screen→sphere unproject, which drives the
// drag/zoom anchor loop (globe-anchor.ts panGlobeToScreenAnchor /
// zoomAtGlobeAnchored). `unprojectGlobe` INVERTS the ABSOLUTE globe MVP and
// casts a ray in ECEF, where the eye sits ~6.4 Mm from Earth centre.
//
// The reported bug ("?proj=globe at Tokyo z17.7 엄청나게 흔들립니다, zoom+drag"):
// the absolute matrix was Float32Array AND invert4x4 returned Float32Array, so
// the clip→ECEF back-projection quantised by ~1 m. The anchor loop pins a ground
// point under the cursor by unprojecting EVERY frame, so that ~1 m re-quantised
// as the camera moved → the recovered centre (hence the whole render) shook tens
// of px at z17+. Fix: both the absolute matrix and its inverse are f64 now (the
// GPU still gets the f32 focus-relative rtcMatrix, unaffected).
//
// This gate is the closed form of that unproject, with a precision toggle on the
// matrix AND its inverse, proving BOTH must stay f64:
//   1. shipped (f64/f64): a stationary ground point is rock-steady (<0.05 px)
//      under a small camera pan at every zoom — no shake.
//   2. the f32 inverse is LOAD-BEARING: the old f32 matrix+inverse re-shakes
//      >1 px at z17.7 (≥20× worse), so a regression that drops f64 re-shakes.

const DEG2RAD = Math.PI / 180
const FOV_RAD = 0.6435011087932844
type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const len = (a: V3): number => Math.sqrt(dot(a, a))
const norm = (a: V3): V3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
function ecefEll(lon: number, lat: number): V3 {
  const lam = lon * DEG2RAD,
    phi = lat * DEG2RAD,
    s = Math.sin(phi),
    c = Math.cos(phi)
  const n = EARTH.a / Math.sqrt(1 - EARTH.e2 * s * s)
  return [n * c * Math.cos(lam), n * c * Math.sin(lam), n * (1 - EARTH.e2) * s]
}
function localUp(lon: number, lat: number): V3 {
  const lam = lon * DEG2RAD,
    phi = lat * DEG2RAD
  return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)]
}
function perspective(fp: number, near: number, far: number, aspect: number): number[] {
  const m = new Array(16).fill(0)
  m[0] = fp / aspect
  m[5] = fp
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}
function mul4(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  return o
}
/** Absolute globe MVP at pitch=bearing=0 (top-down). `narrow` → f32 matrix (the
 *  pre-fix `new Float32Array(out)`). */
function buildMat(
  clon: number,
  clat: number,
  zoom: number,
  w: number,
  h: number,
  narrow: boolean,
): number[] {
  const target = ecefEll(clon, clat)
  const n = localUp(clon, clat)
  const alt = ((WORLD_MERC / TILE_PX / Math.pow(2, zoom)) * h) / 2 / Math.tan(FOV_RAD / 2)
  const eye: V3 = [target[0] + alt * n[0], target[1] + alt * n[1], target[2] + alt * n[2]]
  const fwd = norm(sub(target, eye))
  // pitch=0 → fwd≈-n (degenerate up hint), so upHint falls back to north.
  const north: V3 = [
    -Math.sin(clat * DEG2RAD) * Math.cos(clon * DEG2RAD),
    -Math.sin(clat * DEG2RAD) * Math.sin(clon * DEG2RAD),
    Math.cos(clat * DEG2RAD),
  ]
  const upHint = Math.abs(dot(fwd, n)) > 0.999 ? north : n
  const s = norm(cross(fwd, upHint)),
    u = cross(s, fwd)
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
  const eyeDist = len(eye)
  const P = perspective(
    1 / Math.tan(FOV_RAD / 2),
    Math.max(1, alt * 0.01),
    (eyeDist + EARTH_R) * 1.5,
    w / h,
  )
  const out = mul4(P, view)
  return narrow ? Array.from(new Float32Array(out)) : out
}
/** column-major 4×4 inverse; `narrow` → f32 output (the pre-fix invert4x4). */
function invert(m: number[], narrow: boolean): number[] | null {
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
  const o = [
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]
  return narrow ? Array.from(new Float32Array(o)) : o
}
function mulV4(m: number[], v: [number, number, number, number]) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}
/** Ray↔ellipsoid hit (ECEF) for a cursor, with matrix+inverse precision toggle. */
function unprojHit(
  clon: number,
  clat: number,
  zoom: number,
  px: number,
  py: number,
  w: number,
  h: number,
  narrow: boolean,
): V3 | null {
  const inv = invert(buildMat(clon, clat, zoom, w, h, narrow), narrow)
  if (!inv) return null
  const ndcX = (px / w) * 2 - 1,
    ndcY = 1 - (py / h) * 2
  const n4 = mulV4(inv, [ndcX, ndcY, -1, 1]),
    f4 = mulV4(inv, [ndcX, ndcY, 1, 1])
  const ox = n4[0] / n4[3],
    oy = n4[1] / n4[3],
    oz = n4[2] / n4[3]
  const dx = f4[0] / f4[3] - ox,
    dy = f4[1] / f4[3] - oy,
    dz = f4[2] / f4[3] - oz
  const k = EARTH.a / EARTH.b,
    ozk = oz * k,
    dzk = dz * k
  const A = dx * dx + dy * dy + dzk * dzk
  const B = 2 * (ox * dx + oy * dy + ozk * dzk)
  const C = ox * ox + oy * oy + ozk * ozk - EARTH_R * EARTH_R
  const disc = B * B - 4 * A * C
  if (disc < 0 || A < 1e-12) return null
  const sq = Math.sqrt(disc),
    t0 = (-B - sq) / (2 * A),
    t1 = (-B + sq) / (2 * A)
  const t = t0 >= 0 ? t0 : t1 >= 0 ? t1 : -1
  if (t < 0) return null
  return [ox + t * dx, oy + t * dy, oz + t * dz]
}

/** Peak-to-peak on-screen wobble (px) of a STATIONARY unproject hit as the camera
 *  pans a few metres — the literal shake the anchor loop turns into centre jitter. */
function panJitterPx(zoom: number, narrow: boolean): number {
  const clon = 139.83404,
    clat = 35.68591,
    w = 1200,
    h = 800
  const px = w * 0.62,
    py = h * 0.44 // a fixed grabbed cursor, off centre
  const pxPerM = (TILE_PX * 2 ** zoom) / WORLD_MERC
  const hits: V3[] = []
  const SWEEP_M = 6
  for (let kk = 0; kk <= 200; kk++) {
    const dLon = ((SWEEP_M / (DEG2RAD * EARTH_R)) * kk) / 200
    const hp = unprojHit(clon + dLon, clat, zoom, px, py, w, h, narrow)
    if (hp) hits.push(hp)
  }
  // remove the smooth drift (least-squares line per axis), take residual p2p.
  let jit = 0
  for (const ax of [0, 1, 2]) {
    const xs = hits.map((_, i) => i),
      ys = hits.map((hp) => hp[ax])
    const n = xs.length,
      mx = (n - 1) / 2,
      my = ys.reduce((a, b) => a + b, 0) / n
    let sxy = 0,
      sxx = 0
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my)
      sxx += (xs[i] - mx) ** 2
    }
    const slope = sxy / sxx
    let lo = Infinity,
      hi = -Infinity
    for (let i = 0; i < n; i++) {
      const r = ys[i] - (my + slope * (xs[i] - mx))
      if (r < lo) lo = r
      if (r > hi) hi = r
    }
    jit = Math.max(jit, hi - lo)
  }
  return jit * pxPerM
}

const ZOOMS = [15, 16, 17.7, 19, 20.5]

describe('globe unproject — inverse precision gate (interaction anchor jitter)', () => {
  it('SHIPPED (f64 matrix+inverse): a stationary ground point is rock-steady (<0.05px) at every zoom', () => {
    for (const z of ZOOMS) {
      const jit = panJitterPx(z, false)
      expect(
        jit,
        `f64 unproject jitter ${jit.toExponential(2)}px @z${z} (must be <0.05px)`,
      ).toBeLessThan(0.05)
    }
  })

  it('OLD f32 matrix+inverse: the SAME point shakes >1px at Tokyo z17.7 (the fix is load-bearing)', () => {
    const jit = panJitterPx(17.7, true)
    expect(
      jit,
      `old f32 unproject jitter ${jit.toFixed(2)}px @z17.7 (must exceed 1px)`,
    ).toBeGreaterThan(1)
  })

  it('f64 removes ≥20× of the unproject jitter at z17.7', () => {
    const oldJ = panJitterPx(17.7, true)
    const newJ = panJitterPx(17.7, false)
    expect(oldJ / Math.max(newJ, 1e-9)).toBeGreaterThan(20)
  })

  it('the shipped GlobeView carries an f64 matrix64 for unproject (the GPU uses the f32 rtcMatrix)', () => {
    const v = buildGlobeMatrix(139.83404, 35.68591, 17.7, 0, 0, 1200, 800, false)
    expect(v.matrix64).toBeInstanceOf(Float64Array)
    expect(v.rtcMatrix).toBeInstanceOf(Float32Array)
    // real unproject at screen centre returns the camera centre (sanity that the
    // f64 path is wired): within 1e-5° (~1px) of (clon, clat).
    const ll = unprojectGlobe(600, 400, 1200, 800, v)!
    expect(Math.abs(ll[0] - 139.83404)).toBeLessThan(1e-5)
    expect(Math.abs(ll[1] - 35.68591)).toBeLessThan(1e-5)
  })
})
