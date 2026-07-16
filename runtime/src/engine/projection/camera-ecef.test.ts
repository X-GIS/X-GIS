// Camera ECEF accessor tests (Phase 2 PR 2b).
//
// Verifies that the camera exposes the ECEF anchor + ENU rotation derived
// from the canonical Mercator-metre `centerX, centerY` fields without
// changing the existing legacy matrix builders. These accessors are the
// scaffolding that Phase 2 PR 2c+ shader paths consume.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { lonLatToECEF, ecefToENURotation, WGS84 } from '@xgis/shared'

describe('Camera.getECEFCenter — derives ECEF from canonical Mercator centre', () => {
  it('lon=0, lat=0 anchor → ECEF (A, 0, 0) on the WGS84 equator', () => {
    const cam = new Camera(0, 0, 2)
    const ecef = cam.getECEFCenter()
    expect(ecef[0]).toBeCloseTo(WGS84.A, 3)
    expect(ecef[1]).toBeCloseTo(0, 3)
    expect(ecef[2]).toBeCloseTo(0, 3)
  })

  it('lon=90, lat=0 → ECEF (0, A, 0)', () => {
    const cam = new Camera(90, 0, 2)
    const ecef = cam.getECEFCenter()
    expect(ecef[0]).toBeCloseTo(0, 3)
    expect(ecef[1]).toBeCloseTo(WGS84.A, 3)
    expect(ecef[2]).toBeCloseTo(0, 3)
  })

  it('Seoul (126.97797, 37.56583) → matches the WGS84 ellipsoid ECEF reference', () => {
    const cam = new Camera(126.97797, 37.56583, 14)
    const fromCamera = cam.getECEFCenter()
    // The camera's ECEF anchor is the WGS84 ELLIPSOID (lonLatToECEF, E2≠0) —
    // the tiles' 3D-position datum (#1152 INC-1). Compare against
    // `lonLatToECEF`, not the sphere `lonLatToECEFSphere` (which the anchor
    // used pre-INC-1, ~21.5 km apart at this mid-latitude). See the
    // getECEFCenter docstring + the ellipsoid-datum-unification design doc.
    const direct = lonLatToECEF(126.97797, 37.56583)
    // Mercator-metre round-trip via the Camera ctor introduces f64
    // rounding; 1 mm agreement is the contract.
    expect(fromCamera[0]).toBeCloseTo(direct[0], 3)
    expect(fromCamera[1]).toBeCloseTo(direct[1], 3)
    expect(fromCamera[2]).toBeCloseTo(direct[2], 3)
  })

  it('not cached — re-reads centerX/Y each call', () => {
    const cam = new Camera(0, 0, 2)
    const before = cam.getECEFCenter()
    const lon = 10
    const mx = lon * (Math.PI / 180) * WGS84.A
    cam.centerX = mx
    cam.centerY = 0
    const after = cam.getECEFCenter()
    expect(after[0]).not.toBeCloseTo(before[0], 0)
    expect(after[1]).not.toBeCloseTo(before[1], 0)
    expect(after[0]).toBeCloseTo(WGS84.A * Math.cos((lon * Math.PI) / 180), 2)
    expect(after[1]).toBeCloseTo(WGS84.A * Math.sin((lon * Math.PI) / 180), 2)
  })
})

describe('Camera.getECEFToENURotation — tangent-plane basis at camera anchor', () => {
  it('matches `ecefToENURotation(cam_lon, cam_lat)` directly', () => {
    const cam = new Camera(126.97797, 37.56583, 14)
    const fromCamera = cam.getECEFToENURotation()
    const direct = ecefToENURotation(126.97797, 37.56583)
    for (let i = 0; i < 16; i++) {
      expect(fromCamera[i]).toBeCloseTo(direct[i], 6)
    }
  })

  it('returns a fresh Float32Array each call (no shared mutation)', () => {
    const cam = new Camera(0, 0, 2)
    const a = cam.getECEFToENURotation()
    const b = cam.getECEFToENURotation()
    expect(a).not.toBe(b)
  })
})

describe('Phase 2 PR 2b — legacy matrix builders unchanged', () => {
  it('getRTCMatrix still returns a finite column-major MVP', () => {
    const cam = new Camera(126.97797, 37.56583, 14)
    cam.pitch = 30
    cam.bearing = 45
    const mvp = cam.getRTCMatrix(1920, 1080, 1)
    expect(mvp).toBeInstanceOf(Float32Array)
    expect(mvp.length).toBe(16)
    expect(Number.isFinite(mvp[15])).toBe(true)
  })
})
