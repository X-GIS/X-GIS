// ═══ #1198 — extrusion lighting frame: shader-rotation ⇄ mesh-normal oracle ═══
//
// The extrude VS rotates each `face_normal` (built by polygon-mesh in the
// VERTEX's own ENU frame, expressed in ECEF) BACK into that ENU frame:
//
//   e = ny·cosλ − nx·sinλ
//   n = nz·cosφ − sinφ·(nx·cosλ + ny·sinλ)
//   u = cosφ·(nx·cosλ + ny·sinλ) + nz·sinφ
//
// This test mirrors that exact math on the CPU and drives it with the REAL
// mesh generator's output across the lon/lat domain, proving BY CONSTRUCTION
// (not by sampling a render):
//   1. every roof normal maps to ENU ≈ (0,0,1) — so flat-projection lighting
//      `dot(N_enu, raw_light)` is position-invariant (the #1198 gradient is
//      structurally impossible), and
//   2. every wall normal maps to |ENU.z| ≈ 0 — so `|N_enu.z| < 0.5` is an
//      EXACT wall/roof discriminator, and
//   3. (fail-before witness) the OLD discriminator `|N_ecef.z| < 0.5`
//      misclassifies equatorial roofs as walls — the bug this replaces.
//
// Tolerance: roof normals are sphere-radial by design while positions are
// ellipsoidal (polygon-mesh comment) — the geodetic-vs-geocentric latitude
// deflection is ≤ 0.192°, so |ENU.xy| ≤ sin(0.192°) ≈ 0.0034. Walls use the
// EDGE-MIDPOINT basis while abs_lon/lat is per-vertex; our test edges span
// ≤ 0.02°, keeping that skew ≪ the roof tolerance.

import { describe, it, expect } from 'vitest'
import { generateWallMeshExtrudedECEF } from './polygon-mesh'

const DEG2RAD = Math.PI / 180
const R = 6378137
const mercX = (lonDeg: number) => lonDeg * DEG2RAD * R
const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2)) * R

// Float slots per polygon-mesh.ts (stride 11).
const STRIDE = 11
const LON = 4,
  LAT = 5,
  NX = 6,
  NY = 7,
  NZ = 8

/** The shader's ECEF→vertex-ENU rotation, mirrored verbatim (#1198). */
function toEnu(lonDeg: number, latDeg: number, nx: number, ny: number, nz: number) {
  const sLon = Math.sin(lonDeg * DEG2RAD)
  const cLon = Math.cos(lonDeg * DEG2RAD)
  const sLat = Math.sin(latDeg * DEG2RAD)
  const cLat = Math.cos(latDeg * DEG2RAD)
  const h = nx * cLon + ny * sLon
  return {
    e: ny * cLon - nx * sLon,
    n: nz * cLat - sLat * h,
    u: cLat * h + nz * sLat,
  }
}

/** A small square (side ~0.02°) centred on (lon, lat), as absolute-Mercator
 *  rings with tile origin 0 (tile-local == absolute). */
function meshAt(lonDeg: number, latDeg: number) {
  const d = 0.01
  const ring = [
    [mercX(lonDeg - d), mercY(latDeg - d)],
    [mercX(lonDeg + d), mercY(latDeg - d)],
    [mercX(lonDeg + d), mercY(latDeg + d)],
    [mercX(lonDeg - d), mercY(latDeg + d)],
    [mercX(lonDeg - d), mercY(latDeg - d)],
  ]
  return generateWallMeshExtrudedECEF(
    [{ rings: [ring], featId: 1 }],
    new Map([[1, 100]]),
    undefined,
    0,
    0,
    [0, 0, 0],
  )
}

// Domain sweep: equator, mid-latitudes both hemispheres, high latitude, and
// near-antimeridian longitudes — the whole territory the anchor-relative
// formulation drifted across.
const SITES: Array<[number, number]> = [
  [0, 0],
  [120, 1],
  [-70, -55],
  [30, 70],
  [179, -80],
  [-179.5, 45],
]

describe('#1198 extrusion lighting frame (shader rotation ⇄ mesh normals)', () => {
  for (const [lon, lat] of SITES) {
    it(`roofs → ENU (0,0,1), walls → ENU z≈0 at (${lon}, ${lat})`, () => {
      const mesh = meshAt(lon, lat)
      const v = mesh.vertices
      let roofs = 0
      let walls = 0
      for (let i = 0; i < v.length; i += STRIDE) {
        const { e, n, u } = toEnu(v[i + LON]!, v[i + LAT]!, v[i + NX]!, v[i + NY]!, v[i + NZ]!)
        // Every normal is unit-length in ENU too (rotation preserves norm).
        expect(Math.hypot(e, n, u)).toBeCloseTo(1, 3)
        if (Math.abs(u) > 0.5) {
          // Roof (or wall-top sharing the radial normal): exact up.
          expect(Math.abs(e)).toBeLessThan(0.005)
          expect(Math.abs(n)).toBeLessThan(0.005)
          expect(u).toBeGreaterThan(0.999)
          roofs++
        } else {
          // Wall: horizontal in the local frame.
          expect(Math.abs(u)).toBeLessThan(0.01)
          walls++
        }
      }
      // The discriminator is bimodal AND both classes are present.
      expect(roofs).toBeGreaterThan(0)
      expect(walls).toBeGreaterThan(0)
    })
  }

  it('fail-before witness: the old |N_ecef.z| < 0.5 test misclassifies equatorial roofs', () => {
    const mesh = meshAt(120, 1) // near-equator: radial up has ECEF z ≈ sin(1°)
    const v = mesh.vertices
    let misclassified = 0
    for (let i = 0; i < v.length; i += STRIDE) {
      const { u } = toEnu(v[i + LON]!, v[i + LAT]!, v[i + NX]!, v[i + NY]!, v[i + NZ]!)
      const isRoofTruth = Math.abs(u) > 0.5
      const oldSaysWall = Math.abs(v[i + NZ]!) < 0.5
      if (isRoofTruth && oldSaysWall) misclassified++
    }
    // Every equatorial roof vertex was wall-classified by the old test —
    // the vertical-gradient ramp dimmed whole roofs near the equator.
    expect(misclassified).toBeGreaterThan(0)
  })
})
