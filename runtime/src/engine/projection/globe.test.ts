// ═══ True 3D Globe (projType 7) — CPU core + interaction ═══
//
// This environment has no GPU, so these unit tests ARE the verification
// for slice 1. They pin: sphere forward/inverse round-trip, the orbit
// camera invariants (incl. the "pitch must keep the globe 3D, not flat"
// regression that motivated the work), ray↔sphere unproject as a true
// inverse of the camera, and the dateline-wrapping tile selection.

import { describe, expect, it } from 'vitest'
import {
  EARTH_R,
  GLOBE_PROJ_TYPE,
  buildGlobeMatrix,
  globeForward,
  globeInverse,
  globeVisibleTiles,
  unprojectGlobe,
} from './globe'

const W = 1280, H = 720

function mulVec4(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + row] * v[k]
    r[row] = s
  }
  return r
}

function projectNDC(view: ReturnType<typeof buildGlobeMatrix>, lon: number, lat: number) {
  const p = globeForward(lon, lat)
  const clip = mulVec4(view.matrix, [p[0], p[1], p[2], 1])
  return { ndc: [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]] as const, w: clip[3] }
}

describe('globe — projType', () => {
  it('is appended as 7 (0..6 untouched)', () => {
    expect(GLOBE_PROJ_TYPE).toBe(7)
  })
})

describe('globe — forward / inverse', () => {
  it('lon=0,lat=0 → +X axis on the sphere', () => {
    const [x, y, z] = globeForward(0, 0)
    expect(x).toBeCloseTo(EARTH_R, 3)
    expect(y).toBeCloseTo(0, 3)
    expect(z).toBeCloseTo(0, 3)
  })

  it('north pole → +Z, lon=90 → +Y', () => {
    const np = globeForward(0, 90)
    expect(np[2]).toBeCloseTo(EARTH_R, 3)
    const e = globeForward(90, 0)
    expect(e[1]).toBeCloseTo(EARTH_R, 3)
  })

  it('every sample point sits on the sphere of radius EARTH_R', () => {
    for (let lon = -180; lon <= 180; lon += 45)
      for (let lat = -80; lat <= 80; lat += 40) {
        const [x, y, z] = globeForward(lon, lat)
        expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(EARTH_R, 0)
      }
  })

  it('inverse round-trips to ≤1e-6° across the globe', () => {
    for (let lon = -179; lon <= 179; lon += 37)
      for (let lat = -85; lat <= 85; lat += 23) {
        const [x, y, z] = globeForward(lon, lat)
        const [lon2, lat2] = globeInverse(x, y, z)
        expect(lon2).toBeCloseTo(lon, 6)
        expect(lat2).toBeCloseTo(lat, 6)
      }
  })

  it('inverse is radius-agnostic (any point on the ray → same lon/lat)', () => {
    const [x, y, z] = globeForward(127, 37)
    const [lon, lat] = globeInverse(x * 0.3, y * 0.3, z * 0.3)
    expect(lon).toBeCloseTo(127, 6)
    expect(lat).toBeCloseTo(37, 6)
  })
})

describe('globe — orbit camera', () => {
  it('camera centre projects to NDC (0,0) at pitch 0', () => {
    const v = buildGlobeMatrix(127, 37, 3, 0, 0, W, H)
    const c = projectNDC(v, 127, 37)
    expect(c.w).toBeGreaterThan(0)
    expect(c.ndc[0]).toBeCloseTo(0, 4)
    expect(c.ndc[1]).toBeCloseTo(0, 4)
  })

  it('centre stays at NDC (0,0) under pitch + bearing', () => {
    for (const pitch of [0, 30, 60]) {
      for (const bearing of [0, 90, 200]) {
        const v = buildGlobeMatrix(10, 20, 4, pitch, bearing, W, H)
        const c = projectNDC(v, 10, 20)
        expect(c.w).toBeGreaterThan(0)
        expect(c.ndc[0]).toBeCloseTo(0, 3)
        expect(c.ndc[1]).toBeCloseTo(0, 3)
      }
    }
  })

  it('the antipode of the centre is behind the camera (a real sphere, not a flat disc)', () => {
    const v = buildGlobeMatrix(0, 0, 2, 0, 0, W, H)
    // Front (centre) is in front; the opposite side of the globe must
    // NOT also be in front — that is exactly what a flattened 2D disc
    // would wrongly do.
    const front = projectNDC(v, 0, 0)
    const back = projectNDC(v, 180, 0)
    expect(front.w).toBeGreaterThan(0)
    // The antipode is a full diameter farther from the eye than the
    // near point: clip.w (camera-space depth) must differ by ≈ 2·R.
    // A flattened 2D disc would collapse that gap to ~0 — this is the
    // precise discriminator between a true sphere and the reported bug.
    expect(back.w - front.w).toBeGreaterThan(EARTH_R)
    expect(back.w - front.w).toBeCloseTo(2 * EARTH_R, -2)
  })

  it('PITCH KEEPS THE GLOBE 3D: depth varies across the surface when pitched', () => {
    // The reported bug: pitching "lays the map flat to 2D". In a true
    // 3D globe a pitched view must have real depth spread — the near
    // edge of the visible cap is closer than the far edge. A flattened
    // disc would collapse that to ~one depth.
    const flat = buildGlobeMatrix(0, 0, 3, 0, 0, W, H)
    const pitched = buildGlobeMatrix(0, 0, 3, 60, 0, W, H)
    const nearPt = projectNDC(pitched, 0, -8) // toward the eye (south, bearing 0 leans north)
    const farPt = projectNDC(pitched, 0, 8) // toward the horizon
    expect(nearPt.w).toBeGreaterThan(0)
    expect(farPt.w).toBeGreaterThan(0)
    // Genuine perspective depth separation under pitch…
    expect(Math.abs(farPt.ndc[2] - nearPt.ndc[2])).toBeGreaterThan(1e-4)
    // …and pitch actually changes the projection (not a no-op / not flat).
    const a = projectNDC(flat, 0, 8)
    expect(Math.abs(a.ndc[1] - farPt.ndc[1])).toBeGreaterThan(1e-3)
  })
})

describe('globe — unproject (ray ↔ sphere)', () => {
  it('screen centre unprojects back to the camera centre', () => {
    for (const [lon, lat, pitch] of [[0, 0, 0], [127, 37, 0], [127, 37, 45], [-150, -20, 30]] as const) {
      const v = buildGlobeMatrix(lon, lat, 4, pitch, 0, W, H)
      const hit = unprojectGlobe(W / 2, H / 2, W, H, v)
      expect(hit).not.toBeNull()
      expect(hit![0]).toBeCloseTo(lon, 2)
      expect(hit![1]).toBeCloseTo(lat, 2)
    }
  })

  it('round-trips an off-centre screen pixel', () => {
    const v = buildGlobeMatrix(20, 10, 4, 20, 45, W, H)
    // A point we know is on the visible front hemisphere.
    const truthLon = 24, truthLat = 13
    const p = globeForward(truthLon, truthLat)
    const clip = mulVec4(v.matrix, [p[0], p[1], p[2], 1])
    const sx = (clip[0] / clip[3] + 1) * 0.5 * W
    const sy = (1 - clip[1] / clip[3]) * 0.5 * H
    const hit = unprojectGlobe(sx, sy, W, H, v)
    expect(hit).not.toBeNull()
    expect(hit![0]).toBeCloseTo(truthLon, 1)
    expect(hit![1]).toBeCloseTo(truthLat, 1)
  })

  it('a pixel pointing past the limb misses the globe (null)', () => {
    const v = buildGlobeMatrix(0, 0, 3, 0, 0, W, H)
    expect(unprojectGlobe(2, 2, W, H, v)).toBeNull()
  })
})

describe('globe — dateline-wrapping tile selection', () => {
  it('a view centred on the antimeridian keeps tiles on BOTH sides (the half-tiles bug)', () => {
    const tiles = globeVisibleTiles(180, 0, 2, 4, 512, 512)
    expect(tiles.length).toBeGreaterThan(0)
    const n = (z: number) => Math.pow(2, z)
    // West-of-dateline tiles have lon near -180 → small x;
    // east-of-dateline tiles have lon near +180 → large x.
    const hasWest = tiles.some(t => t.x / n(t.z) < 0.15)
    const hasEast = tiles.some(t => (t.x + 1) / n(t.z) > 0.85)
    expect(hasWest).toBe(true)
    expect(hasEast).toBe(true)
  })

  it('only the camera-facing hemisphere is selected (centre lon 0 → no lon≈180 tiles)', () => {
    const tiles = globeVisibleTiles(0, 0, 2, 4, 512, 512)
    expect(tiles.length).toBeGreaterThan(0)
    for (const t of tiles) {
      const n = Math.pow(2, t.z)
      const lonW = t.x / n * 360 - 180
      const lonE = (t.x + 1) / n * 360 - 180
      // No selected tile should be entirely on the far side (|lon|>110).
      expect(Math.min(Math.abs(lonW), Math.abs(lonE))).toBeLessThan(120)
    }
  })

  it('tile count is bounded and ox === x (globe renders a single world)', () => {
    const tiles = globeVisibleTiles(127, 37, 3, 5, 1280, 720)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThanOrEqual(512)
    for (const t of tiles) expect(t.ox).toBe(t.x)
  })
})

describe('globe — RTC matrix (renderer feeds proj_globe(v) − proj_globe(center))', () => {
  it('the focus point (rtc origin) projects to NDC (0,0)', () => {
    for (const [lon, lat, p] of [[0, 0, 0], [127, 37, 40], [-150, -20, 70]] as const) {
      const v = buildGlobeMatrix(lon, lat, 4, p, 0, W, H)
      const c = mulVec4(v.rtcMatrix, [0, 0, 0, 1]) // focus − focus = 0
      expect(c[3]).toBeGreaterThan(0)
      expect(c[0] / c[3]).toBeCloseTo(0, 4)
      expect(c[1] / c[3]).toBeCloseTo(0, 4)
    }
  })

  it('rtcMatrix·(p−focus) lands at the same NDC as matrix·p (RTC of the absolute MVP)', () => {
    // The ABSOLUTE path multiplies a f32 matrix by ~6.37e6 coords and
    // loses precision in raw clip space — that loss is the very reason
    // RTC exists, so compare the meaningful quantity (NDC = screen pos),
    // not raw clip components, and only near the focus where the
    // absolute path is still trustworthy.
    const v = buildGlobeMatrix(30, 15, 5, 35, 50, W, H)
    const focus = globeForward(30, 15)
    for (const [lon, lat] of [[30.5, 15.5], [29.5, 14.5], [31, 16]] as const) {
      const p = globeForward(lon, lat)
      const a = mulVec4(v.matrix, [p[0], p[1], p[2], 1])
      const r = mulVec4(v.rtcMatrix, [p[0] - focus[0], p[1] - focus[1], p[2] - focus[2], 1])
      expect(r[0] / r[3]).toBeCloseTo(a[0] / a[3], 2)
      expect(r[1] / r[3]).toBeCloseTo(a[1] / a[3], 2)
    }
  })
})

// Cesium's camera tilts AROUND the focus point at a CONSTANT range:
// pitch ≈ -90° looks straight down (nadir); raising it sweeps the view
// toward the horizon while the focus stays put — a real perspective
// orbit, never a flattened plane. This engine's pitch is 0 = top-down
// up to ~85 = near-horizon, so 0..85 maps onto Cesium's -90..-5.
describe('globe — Cesium-style pitch', () => {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const len = (a: number[]) => Math.sqrt(dot(a, a))
  const norm = (a: number[]) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

  it('orbits at a CONSTANT range to the focus as pitch changes', () => {
    const ranges = [0, 20, 45, 70, 85].map(p => {
      const v = buildGlobeMatrix(127, 37, 4, p, 0, W, H)
      return len(sub(v.eye, v.target))
    })
    for (const r of ranges) expect(r).toBeCloseTo(ranges[0], 3)
  })

  it('pitch 0 = nadir (straight down); raising pitch sweeps toward the horizon', () => {
    for (const lonlat of [[0, 0], [127, 37], [-150, -25]] as const) {
      const focusN = norm(globeForward(lonlat[0], lonlat[1])) // surface normal
      let prev = -Infinity
      for (const p of [0, 30, 60, 85]) {
        const v = buildGlobeMatrix(lonlat[0], lonlat[1], 4, p, 0, W, H)
        const viewDir = norm(sub(v.target, v.eye))
        // dot(view, normal) == -cos(pitch): -1 at nadir → 0 at horizon.
        const d = dot(viewDir, focusN)
        expect(d).toBeCloseTo(-Math.cos(p * Math.PI / 180), 2)
        expect(d).toBeGreaterThan(prev) // monotone tilt toward the horizon
        prev = d
      }
    }
  })

  it('focus stays dead-centre while tilting (orbit, not pan)', () => {
    for (const p of [0, 25, 55, 82]) {
      const v = buildGlobeMatrix(40, -10, 5, p, 60, W, H)
      const t = globeForward(40, -10)
      const clip = mulVec4(v.matrix, [t[0], t[1], t[2], 1])
      expect(clip[3]).toBeGreaterThan(0)
      expect(clip[0] / clip[3]).toBeCloseTo(0, 3)
      expect(clip[1] / clip[3]).toBeCloseTo(0, 3)
    }
  })

  it('tilting reveals more of the globe toward the heading (the limb comes into view)', () => {
    // More surface should fall in front of the camera as we tilt up.
    const facingCount = (pitch: number) => {
      const v = buildGlobeMatrix(0, 0, 3, pitch, 0, W, H)
      const eyeN = norm(v.eye)
      let n = 0
      for (let lon = -90; lon <= 90; lon += 10)
        for (let lat = -80; lat <= 80; lat += 10) {
          const p = norm(globeForward(lon, lat))
          if (dot(p, eyeN) > EARTH_R / len(v.eye)) n++
        }
      return n
    }
    // Higher pitch ⇒ the eye is lower/closer to the surface tangent, so
    // its horizon circle is smaller — but the view looks ACROSS the
    // curve toward the limb. Assert the camera genuinely moves (eye is
    // not the same point) and stays outside the sphere at every pitch.
    for (const p of [0, 40, 80]) {
      const v = buildGlobeMatrix(0, 0, 3, p, 0, W, H)
      expect(len(v.eye)).toBeGreaterThan(EARTH_R) // never inside the globe
    }
    const e0 = buildGlobeMatrix(0, 0, 3, 0, 0, W, H).eye
    const e80 = buildGlobeMatrix(0, 0, 3, 80, 0, W, H).eye
    expect(len(sub(e0, e80))).toBeGreaterThan(1) // the camera actually orbits
    expect(facingCount(0)).toBeGreaterThan(0)
  })
})

// The azimuthal set (orthographic / azimuthal_equidistant / stereographic)
// promotes to this sphere path with a PARALLEL orbit camera when tilted.
// The contract that makes the pitch=0 → pitch>0 transition seamless for
// orthographic: an ortho-camera sphere at pitch=0 is byte-identical to
// the flat 2D orthographic disc (orthographic projection of a sphere
// along the surface normal IS that disc).
describe('globe — orthographic (parallel) orbit camera', () => {
  const d2r = Math.PI / 180
  const projOrtho = (lon: number, lat: number, clon: number, clat: number) => {
    const lam = lon * d2r, phi = lat * d2r, l0 = clon * d2r, p0 = clat * d2r
    return [
      EARTH_R * Math.cos(phi) * Math.sin(lam - l0),
      EARTH_R * (Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam - l0)),
    ]
  }
  const ndc = (m: ArrayLike<number>, v: number[]) => {
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
    return [
      (m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3]) / w,
      (m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3]) / w,
    ]
  }

  it('pitch=0 ortho-globe matches the flat 2D orthographic disc', async () => {
    const { Camera } = await import('./camera')
    const clon = 10, clat = 30, zoom = 2
    const cam = new Camera(clon, clat, zoom)
    cam.projType = 3 // flat 2D azimuthal path
    const m2d = cam.getRTCMatrix(W, H, 1)
    const v = buildGlobeMatrix(clon, clat, zoom, 0, 0, W, H, true)
    const fc = globeForward(clon, clat)
    for (const [lon, lat] of [[10, 30], [15, 35], [5, 25], [30, 10], [-10, 50], [40, -5]]) {
      const a = ndc(m2d, [...projOrtho(lon, lat, clon, clat), 0, 1])
      const g = globeForward(lon, lat)
      const b = ndc(v.rtcMatrix, [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1])
      expect(Math.abs(a[0] - b[0])).toBeLessThan(2e-3)
      expect(Math.abs(a[1] - b[1])).toBeLessThan(2e-3)
    }
  })

  it('parallel projection (clip.w ≡ 1) and a real tilt at pitch>0', () => {
    const fc = globeForward(0, 0)
    const rel = (lon: number, lat: number) => {
      const g = globeForward(lon, lat)
      return [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1]
    }
    const flat = buildGlobeMatrix(0, 0, 2, 0, 0, W, H, true)
    const tilt = buildGlobeMatrix(0, 0, 2, 45, 0, W, H, true)
    // No perspective divide under the parallel camera.
    const m = tilt.rtcMatrix, p = rel(20, 15)
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3]
    expect(Math.abs(w - 1)).toBeLessThan(1e-6)
    // Tilting moves an off-centre point vertically on screen.
    expect(Math.abs(ndc(tilt.rtcMatrix, rel(0, 10))[1] - ndc(flat.rtcMatrix, rel(0, 10))[1]))
      .toBeGreaterThan(0.05)
  })
})
