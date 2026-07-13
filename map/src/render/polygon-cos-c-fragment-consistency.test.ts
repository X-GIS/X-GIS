// Workflow #2 baseline: 3D back-face culling consistency check.
//
// The WGSL `polygon_cos_c_fragment(abs_merc_x, abs_merc_y)` at
// renderer.ts:151 reconstructs lon/lat from absolute-Mercator
// fragment varyings, then routes through `needs_backface_cull` to
// produce the per-fragment cull signal. If the WGSL reconstruction
// disagrees with the CPU `cosC(lon, lat)` ground truth on the back
// hemisphere, the GPU lets back-face fragments through that should
// be discarded — exactly the "red pixel appears" symptom of
// workflow #2.
//
// This test ports the WGSL math to TS (f64) and sweeps abs_merc_x/y
// across the full Mercator extent on globe (projType=7) +
// orthographic (3). For every sample the fragment-level cull MUST
// match the lon/lat cosC sign (front-hemisphere visible, back-
// hemisphere culled).
//
// A failure here = back-face culling is broken in 3D projections.

import { describe, expect, it } from 'vitest'
import { cosC, needsBackfaceCullWgsl } from '@xgis/map'
import { globeEyeUniform } from '@xgis/map'

const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180

// #600 — a FAR NADIR eye over (clon, clat): the globe arm now uses the
// eye-horizon cap, but with the eye on the centre normal at large altitude the
// horizon → the strict hemisphere (horizonCos → 0), so the cull sign still
// matches the cosC ground truth this file asserts. (A pitched eye is exercised
// by back-face-cull-comprehensive's #600 discriminating block.)
function nadirEye(clon: number, clat: number): readonly [number, number, number] {
  const lam = clon * DEG2RAD,
    phi = clat * DEG2RAD,
    c = Math.cos(phi)
  const s = EARTH_R * 1e6 // far altitude → horizonCos ≈ 0 ≈ strict hemisphere
  return [s * c * Math.cos(lam), s * c * Math.sin(lam), s * Math.sin(phi)]
}

// CPU port of WGSL `polygon_cos_c_fragment`. Inverts Web Mercator
// to lon/lat, returns the same back-face signal the GPU computes.
function polygonCosCFragmentCpu(
  absMercX: number,
  absMercY: number,
  projType: number,
  clon: number,
  clat: number,
): number {
  const absLon = absMercX / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(absMercY / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  // #600 — globe(7) needs globe_eye (far nadir eye ⇒ horizon ≈ strict
  // hemisphere). Disc arms ignore it (pass a real eye anyway, harmless).
  const eye = nadirEye(clon, clat)
  return needsBackfaceCullWgsl(
    projType,
    absLon,
    absLat,
    clon,
    clat,
    globeEyeUniform(eye) as [number, number, number, number],
  )
}

function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = lon * DEG2RAD * EARTH_R
  const latRad = lat * DEG2RAD
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  return [x, y]
}

describe('polygon_cos_c_fragment CPU/GPU consistency (workflow #2 baseline)', () => {
  it('round-trip: cull signal at fragment matches lon/lat cosC for globe (projType=7)', () => {
    const clon = 0,
      clat = 20
    // Sweep 12×12 grid across the visible Mercator range.
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const lon = -170 + (i / 11) * 340
        const lat = -80 + (j / 11) * 160
        const [mx, my] = lonLatToMerc(lon, lat)
        const cull = polygonCosCFragmentCpu(mx, my, 7, clon, clat)
        const groundTruth = cosC(lon, lat, clon, clat)
        // globe projType returns raw cosC — sign should match.
        expect(
          Math.sign(cull),
          `mismatch at lon=${lon} lat=${lat}: cull=${cull} truth=${groundTruth}`,
        ).toBe(Math.sign(groundTruth))
      }
    }
  })

  it('round-trip: orthographic (projType=3) raw cosC matches', () => {
    const clon = 0,
      clat = 0
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const lon = -160 + (i / 9) * 320
        const lat = -75 + (j / 9) * 150
        const [mx, my] = lonLatToMerc(lon, lat)
        const cull = polygonCosCFragmentCpu(mx, my, 3, clon, clat)
        const truth = cosC(lon, lat, clon, clat)
        expect(cull).toBeCloseTo(truth, 4)
      }
    }
  })

  it('flat projections (mercator/equirect/natural_earth) always return ≥1 (no cull)', () => {
    const clon = 127,
      clat = 37
    for (const pt of [0, 1, 2, 6]) {
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          const lon = -170 + (i / 7) * 340
          const lat = -80 + (j / 7) * 160
          const [mx, my] = lonLatToMerc(lon, lat)
          const cull = polygonCosCFragmentCpu(mx, my, pt, clon, clat)
          expect(cull).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('back hemisphere on globe always culls (red pixel test)', () => {
    // Camera at (0, 0). Antipodal points should all have cosC < 0.
    const clon = 0,
      clat = 0
    const antipodal = [
      [180, 0],
      [-180, 0],
      [170, 10],
      [-170, -10],
      [175, 45],
      [-175, -45],
    ]
    for (const [lon, lat] of antipodal) {
      const [mx, my] = lonLatToMerc(lon, lat)
      const cull = polygonCosCFragmentCpu(mx, my, 7, clon, clat)
      // cull < 0 means fragment IS on back hemisphere — shader discards.
      // If this fails: red pixel WOULD leak through on back-face. Bug.
      expect(
        cull,
        `antipodal point (${lon},${lat}) classified front; back-face cull broken`,
      ).toBeLessThan(0)
    }
  })

  it('front hemisphere on globe always passes (blue pixel test)', () => {
    const clon = 0,
      clat = 0
    const front = [
      [0, 0],
      [10, 0],
      [0, 10],
      [-10, -10],
      [30, 30],
      [-30, -30],
      [60, 0],
      [0, 60],
    ]
    for (const [lon, lat] of front) {
      const [mx, my] = lonLatToMerc(lon, lat)
      const cull = polygonCosCFragmentCpu(mx, my, 7, clon, clat)
      expect(
        cull,
        `front point (${lon},${lat}) classified back; visible fragment would be discarded`,
      ).toBeGreaterThan(0)
    }
  })
})
