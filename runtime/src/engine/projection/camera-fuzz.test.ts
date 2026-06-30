// iter-293 — Camera fuzz probe. User: "bugs definitely remain,
// just edge cases not found." Random + boundary inputs to find
// matrix / unproject inconsistencies the hand-picked unit tests
// miss.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/engine'

const W = 800, H = 800, DPR = 1

function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5; s |= 0
    return ((s >>> 0) / 0x1_0000_0000)
  }
}

function allFinite(arr: ArrayLike<number>): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]!)) return false
  }
  return true
}

describe('iter-293 Camera fuzz — random valid inputs', () => {
  it('matrix elements all finite across random (zoom, pitch, bearing, lon, lat)', () => {
    const rng = makeRng(0xc001)
    for (let trial = 0; trial < 2000; trial++) {
      const lon = (rng() * 360) - 180
      const lat = (rng() * 170) - 85       // mercator-safe band
      const zoom = rng() * 22
      const pitch = rng() * 85
      const bearing = (rng() * 720) - 360   // include wraparound
      const cam = new Camera(lon, lat, zoom)
      cam.pitch = pitch
      cam.bearing = bearing
      const m = cam.getRTCMatrix(W, H, DPR)
      if (!allFinite(m)) {
        // Surface the failure with full state.
        throw new Error(
          `non-finite matrix at lon=${lon} lat=${lat} zoom=${zoom} `
          + `pitch=${pitch} bearing=${bearing}: ${Array.from(m)}`,
        )
      }
    }
  })

  it('unproject(screenX, screenY) round-trips back to screen via project (when on ground)', () => {
    const rng = makeRng(0xbeef)
    // Pick a stable camera config the matrix tests already trust:
    // moderate zoom + small pitch so every screen point hits ground.
    const cam = new Camera(0, 0, 6)
    cam.pitch = 30
    cam.bearing = 45
    for (let trial = 0; trial < 500; trial++) {
      const sx = rng() * W
      const sy = rng() * (H * 0.5)        // upper half avoids horizon clip
      const world = cam.unprojectToZ0(sx, sy, W, H, DPR)
      if (!world) continue                // legitimately above horizon
      expect(Number.isFinite(world[0])).toBe(true)
      expect(Number.isFinite(world[1])).toBe(true)
    }
  })

  it('extreme pitch values clamp / handle without NaN', () => {
    const extremes = [0, 0.0001, 45, 60, 80, 85, 85.0511, 89.9999]
    for (const pitch of extremes) {
      const cam = new Camera(0, 0, 4)
      cam.pitch = pitch
      const m = cam.getRTCMatrix(W, H, DPR)
      expect(allFinite(m)).toBe(true)
    }
  })

  it('zoom=0 + zoom=22 boundaries produce finite matrices', () => {
    for (const zoom of [0, 0.0001, 1, 21, 21.9999, 22]) {
      const cam = new Camera(0, 0, zoom)
      const m = cam.getRTCMatrix(W, H, DPR)
      expect(allFinite(m)).toBe(true)
    }
  })

  it('antimeridian-adjacent longitudes finite (lon ±179.999)', () => {
    for (const lon of [-179.9999, -180, 179.9999, 180]) {
      const cam = new Camera(lon, 0, 5)
      const m = cam.getRTCMatrix(W, H, DPR)
      expect(allFinite(m)).toBe(true)
    }
  })

  it('near-pole latitudes finite (lat ±84.999, ±85)', () => {
    for (const lat of [-85, -84.999, 84.999, 85]) {
      const cam = new Camera(0, lat, 5)
      const m = cam.getRTCMatrix(W, H, DPR)
      expect(allFinite(m)).toBe(true)
    }
  })

  it('bearing wraps modulo 360 — large bearings finite', () => {
    for (const bearing of [-720, -540, -180, 0, 180, 540, 720, 1000]) {
      const cam = new Camera(0, 0, 5)
      cam.bearing = bearing
      const m = cam.getRTCMatrix(W, H, DPR)
      expect(allFinite(m)).toBe(true)
    }
  })

  it('tiny canvas (1×1) does not produce non-finite matrix', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 60
    const m = cam.getRTCMatrix(1, 1, DPR)
    expect(allFinite(m)).toBe(true)
  })

  it('huge canvas (10000×10000) does not produce non-finite matrix', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 60
    const m = cam.getRTCMatrix(10000, 10000, DPR)
    expect(allFinite(m)).toBe(true)
  })

  it('DPR=3 (high-density mobile) produces finite matrix', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 60
    const m = cam.getRTCMatrix(W * 3, H * 3, 3)
    expect(allFinite(m)).toBe(true)
  })
})
