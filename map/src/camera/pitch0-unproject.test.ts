// #777 IV3 — gates for the pitch-0 unprojector.
//
// `groundBasisAt` gets identity-at-pitch-0 by construction ONLY if the inverse it
// composes against really is the live projection with pitch forced to 0. Three
// properties make that true, and the third is what stops a stub from passing:
//
//   1. the LIVE `getRTCMatrixInverse` is unperturbed by any use of this class,
//   2. at pitch 0 the pitch-0 inverse EQUALS the live one, element for element,
//   3. at pitch > 0 the two DIFFER — without this, "return the live matrix" greens
//      1 and 2.
//
// Plus the cache: a pure tilt must be a HIT (pitch is excluded from the key by
// design) while every other camera change must be a MISS — a stale pitch-0 inverse
// after a pan would place every ground-aligned label against the previous frame.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { Pitch0Unprojector } from './pitch0-unproject'

const W = 900,
  H = 700,
  DPR = 1

const copy = (m: Float32Array): number[] => Array.from(m)

describe('#777 IV3 — Pitch0Unprojector: the live camera is never perturbed', () => {
  it('leaves getRTCMatrixInverse byte-identical across pitch-0 use, at pitch > 0', () => {
    const cam = new Camera(0, 0, 6)
    cam.bearing = 37
    cam.pitch = 55
    const before = copy(cam.getRTCMatrixInverse(W, H, DPR))

    const p0 = new Pitch0Unprojector()
    p0.matrixInverse(cam, W, H, DPR)
    p0.unprojectToLonLat(cam, 120, 260, W, H, DPR)

    expect(copy(cam.getRTCMatrixInverse(W, H, DPR))).toEqual(before)
  })

  it('leaves the live unprojection byte-identical too', () => {
    const cam = new Camera(1_200_000, 4_500_000, 9)
    cam.bearing = -22
    cam.pitch = 48
    const before = cam.unprojectToLonLat(300, 400, W, H, DPR)

    new Pitch0Unprojector().unprojectToLonLat(cam, 300, 400, W, H, DPR)

    expect(cam.unprojectToLonLat(300, 400, W, H, DPR)).toEqual(before)
  })
})

describe('#777 IV3 — Pitch0Unprojector: equals the live inverse exactly at pitch 0', () => {
  for (const bearing of [0, 37, 90, 180, -125]) {
    it(`element-for-element at bearing ${bearing}`, () => {
      const cam = new Camera(500_000, -2_000_000, 7)
      cam.bearing = bearing
      cam.pitch = 0
      const live = copy(cam.getRTCMatrixInverse(W, H, DPR))
      const p0 = copy(new Pitch0Unprojector().matrixInverse(cam, W, H, DPR))
      expect(p0).toEqual(live)
    })
  }

  it('and so does the composed unprojection, at every probe corner', () => {
    const cam = new Camera(0, 0, 4)
    cam.bearing = 61
    cam.pitch = 0
    const p0 = new Pitch0Unprojector()
    for (const [x, y] of [
      [10, 10],
      [W - 10, 10],
      [W / 2, H / 2],
      [10, H - 10],
    ]) {
      expect(p0.unprojectToLonLat(cam, x, y, W, H, DPR)).toEqual(
        cam.unprojectToLonLat(x, y, W, H, DPR),
      )
    }
  })
})

describe('#777 IV3 — Pitch0Unprojector: NOT the live inverse once pitched', () => {
  // Non-vacuity. A stub that forwarded to `getRTCMatrixInverse` would pass every
  // assertion above; this is the one it cannot pass.
  for (const pitch of [15, 40, 60]) {
    it(`differs from the live inverse at pitch ${pitch}`, () => {
      const cam = new Camera(0, 0, 6)
      cam.pitch = pitch
      const live = copy(cam.getRTCMatrixInverse(W, H, DPR))
      const p0 = copy(new Pitch0Unprojector().matrixInverse(cam, W, H, DPR))
      expect(p0).not.toEqual(live)
    })
  }

  it('is invariant to pitch — the same matrix at 0, 30 and 70', () => {
    // A FRESH instance per pitch on purpose. Reusing one would return the cached
    // matrix (pitch is excluded from the key), so the assertion would hold even
    // for an implementation that does not force pitch at all — vacuous. Each
    // instance here builds from scratch against the pitched camera.
    const cam = new Camera(0, 0, 6)
    cam.bearing = 12
    cam.pitch = 0
    const at0 = copy(new Pitch0Unprojector().matrixInverse(cam, W, H, DPR))
    for (const pitch of [30, 70]) {
      cam.pitch = pitch
      expect(copy(new Pitch0Unprojector().matrixInverse(cam, W, H, DPR))).toEqual(at0)
    }
  })
})

describe('#777 IV3 — Pitch0Unprojector: the cache invalidates on everything but pitch', () => {
  // Asserted on the composed lon/lat rather than the matrix, because the flat MVP
  // is RTC — it carries no camera-centre translate, so a pan leaves the matrix
  // (and its inverse) untouched and moves only the `relToLonLat` compose. A
  // matrix-level assertion here would be un-failable, i.e. vacuous.
  const mutations: Array<[string, (c: Camera) => void]> = [
    ['a pan in x', (c) => c.pan(60, 0, W, H)],
    ['a pan in y', (c) => c.pan(0, 60, W, H)],
    ['zoom', (c) => (c.zoom += 1)],
    ['bearing', (c) => (c.bearing += 25)],
  ]
  for (const [name, mutate] of mutations) {
    it(`re-resolves after ${name}`, () => {
      const cam = new Camera(0, 1_000_000, 6)
      const p0 = new Pitch0Unprojector()
      const before = p0.unprojectToLonLat(cam, 240, 300, W, H, DPR)
      mutate(cam)
      expect(p0.unprojectToLonLat(cam, 240, 300, W, H, DPR)).not.toEqual(before)
    })
  }

  it('rebuilds after the viewport or dpr changes', () => {
    const cam = new Camera(0, 0, 6)
    const p0 = new Pitch0Unprojector()
    const before = copy(p0.matrixInverse(cam, W, H, DPR))
    expect(copy(p0.matrixInverse(cam, W, H + 120, DPR))).not.toEqual(before)
    expect(copy(p0.matrixInverse(cam, W, H, 2))).not.toEqual(before)
  })

  it('rebuilds after projType changes — the view-height cap is per-projType', () => {
    const cam = new Camera(0, 0, 1)
    const p0 = new Pitch0Unprojector()
    const merc = copy(p0.matrixInverse(cam, W, H, DPR))
    cam.projType = 3 // orthographic — capped at 2·EARTH_R, not WORLD_MERC
    expect(copy(p0.matrixInverse(cam, W, H, DPR))).not.toEqual(merc)
  })
})

describe('#777 IV3 — Pitch0Unprojector: out-of-scope projections yield no basis input', () => {
  // The honest degradation: no pitch-0 lon/lat under the azimuthal discs or the
  // globe ⇒ `groundBasisAt` returns null ⇒ the label billboards, exactly as today.
  for (const projType of [3, 4, 5, 7]) {
    it(`returns null for projType ${projType}`, () => {
      const cam = new Camera(0, 0, 5)
      cam.projType = projType
      expect(new Pitch0Unprojector().unprojectToLonLat(cam, W / 2, H / 2, W, H, DPR)).toBeNull()
    })
  }
})
