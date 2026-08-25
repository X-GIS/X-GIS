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
import {
  Pitch0Unprojector,
  makeGroundProjector,
  makeGroundMercProjector,
  type FlatGroundView,
} from './pitch0-unproject'
import { makeLabelProjectors } from '../render-loop-helpers'

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

describe('#777 IV3 — Pitch0Unprojector: out-of-scope projections yield no UNPROJECTION', () => {
  // The inverse's scope, unchanged. D1 INC-1 no longer routes the basis through
  // it — a forward Jacobian ratio needs no inverse, which is exactly how the
  // azimuthal discs came into scope — but `unprojectToLonLat` is still the
  // authority for "what lon/lat is under this unpitched pixel" and still says
  // null here.
  for (const projType of [3, 4, 5, 7]) {
    it(`returns null for projType ${projType}`, () => {
      const cam = new Camera(0, 0, 5)
      cam.projType = projType
      expect(new Pitch0Unprojector().unprojectToLonLat(cam, W / 2, H / 2, W, H, DPR)).toBeNull()
    })
  }
})

describe('D1 INC-1 — Pitch0Unprojector.matrix: the FORWARD half of the same pair', () => {
  it('is the live matrix element for element at pitch 0, and differs once pitched', () => {
    // The property the whole identity-at-pitch-0 rung rests on, asserted on the
    // FORWARD matrix this time: `groundBasisAt` composes two projectors built
    // from these two matrices, so "same matrix ⇒ same function ⇒ exact identity"
    // is only true if this holds. The pitched half is the non-vacuity: without
    // it, "return the live matrix" would green the first assertion.
    const cam = new Camera(500_000 / 1e5, -20, 7)
    cam.bearing = 61
    cam.pitch = 0
    expect(copy(new Pitch0Unprojector().matrix(cam, W, H, DPR))).toEqual(
      copy(cam.getViewForProjection(0, W, H, DPR).matrix),
    )
    cam.pitch = 55
    expect(copy(new Pitch0Unprojector().matrix(cam, W, H, DPR))).not.toEqual(
      copy(cam.getViewForProjection(0, W, H, DPR).matrix),
    )
  })

  it('shares one build with matrixInverse — a pure tilt is a HIT, a zoom a MISS', () => {
    // `matrix` and `matrixInverse` are two readers of one build. If either drove
    // its own cache the two could describe different cameras inside one frame,
    // and the basis would compose a forward from before the zoom with an inverse
    // from after it. Asserted on ZOOM, not on a pan: the flat MVP is RTC and
    // carries no camera-centre translate, so a pan leaves it untouched (the
    // describe above says the same, and tests the pan through the compose).
    const cam = new Camera(0, 0, 6)
    const p0 = new Pitch0Unprojector()
    const before = copy(p0.matrix(cam, W, H, DPR))
    cam.pitch = 42
    expect(copy(p0.matrix(cam, W, H, DPR))).toEqual(before)
    // Cross-reader: the INVERSE is fetched first after the zoom, so a `matrix`
    // that read a cache of its own would still be serving the stale build.
    cam.zoom += 1
    p0.matrixInverse(cam, W, H, DPR)
    expect(copy(p0.matrix(cam, W, H, DPR))).not.toEqual(before)
    expect(copy(p0.matrix(cam, W, H, DPR))).toEqual(
      copy(new Pitch0Unprojector().matrix(cam, W, H, DPR)),
    )
  })
})

// The composition parity gate. `makeGroundProjector` re-states the flat arm's
// lon/lat → rtc → NDC → screen chain so it can drop the VIEWPORT cull that would
// withhold the basis from the far field (NEEDS-PROBE 1, measured in that
// function's header). Re-stating it is only safe while it stays the SAME chain,
// so this asserts the two agree wherever the culled one answers — for every
// flat projType, at pitch and unpitched. A drift in either composition fails it.
describe('D1 INC-1 — makeGroundProjector agrees with makeLabelProjectors where both answer', () => {
  for (const projType of [0, 1, 2, 3, 4, 5, 6]) {
    it(`projType ${projType}`, () => {
      let compared = 0
      let culledOnly = 0
      for (const pitch of [0, 45, 65]) {
        for (const zoom of [2, 9, 15]) {
          const cam = new Camera(11, 31, zoom)
          cam.projType = projType
          cam.bearing = 24
          cam.pitch = pitch
          const flat: FlatGroundView = {
            projType,
            ccx: cam.centerX,
            ccy: cam.centerY,
            centerLon: 11,
            centerLat: 31,
          }
          const mvp = cam.getViewForProjection(projType, W, H, DPR).matrix
          const culled = makeLabelProjectors(mvp, W, H, {
            ...flat,
            visibleWorldCopies: [0],
          }).projectLonLat
          const free = makeGroundProjector(mvp, W, H, flat)
          for (let dLon = -40; dLon <= 40; dLon += 5) {
            for (let dLat = -30; dLat <= 30; dLat += 5) {
              const a = culled(11 + dLon, 31 + dLat)
              const ax = a ? a[0] : NaN
              const ay = a ? a[1] : NaN
              const b = free(11 + dLon, 31 + dLat)
              if (a === null) {
                if (b !== null) culledOnly++
                continue
              }
              expect(b, `projType=${projType} pitch=${pitch} z=${zoom} d=${dLon},${dLat}`).not.toBe(
                null,
              )
              // Bit-for-bit: the same arithmetic in the same order, so anything
              // but equality means the two chains have drifted.
              expect([b![0], b![1]], `projType=${projType} pitch=${pitch} z=${zoom}`).toEqual([
                ax,
                ay,
              ])
              compared++
            }
          }
        }
      }
      // Non-vacuity, both ways: the lattice must actually reach points the culled
      // projector answers for, AND points it rejects while the cull-free one
      // answers — otherwise "cull-free" would be an untested claim.
      expect(compared, 'the lattice found no commonly-projectable points').toBeGreaterThan(50)
      expect(
        culledOnly,
        'the cull-free projector never answered where the culled one did not',
      ).toBeGreaterThan(0)
    })
  }
})

// The MERC-domain twin of the gate above. The line-label pass walks a polyline of
// mercator metres and feeds `projectMercAny` directly — the merc→lonLat→merc round
// trip it replaced was ~80 % of that loop's frame time — so its pitch-0 twin has to
// take the same input domain or pay the round trip back on every sample of every
// ground-aligned road. `makeGroundMercProjector` therefore re-states the same
// chain a second time, and the same argument applies: re-stating is only safe
// while it stays the SAME chain.
describe('D1 INC-4 — makeGroundMercProjector agrees with projectMercAny where both answer', () => {
  for (const projType of [0, 1, 2, 6]) {
    it(`projType ${projType}`, () => {
      let compared = 0
      let culledOnly = 0
      for (const pitch of [0, 45, 65]) {
        for (const zoom of [2, 9, 15]) {
          const cam = new Camera(11, 31, zoom)
          cam.projType = projType
          cam.bearing = 24
          cam.pitch = pitch
          const flat: FlatGroundView = {
            projType,
            ccx: cam.centerX,
            ccy: cam.centerY,
            centerLon: 11,
            centerLat: 31,
          }
          const mvp = cam.getViewForProjection(projType, W, H, DPR).matrix
          const culled = makeLabelProjectors(mvp, W, H, {
            ...flat,
            visibleWorldCopies: [0],
          }).projectMercAny
          const free = makeGroundMercProjector(mvp, W, H, flat)
          for (let dx = -3_000_000; dx <= 3_000_000; dx += 500_000) {
            for (let dy = -2_000_000; dy <= 2_000_000; dy += 500_000) {
              const mx = cam.centerX + dx
              const my = cam.centerY + dy
              const a = culled(mx, my, 0)
              const ax = a ? a[0] : NaN
              const ay = a ? a[1] : NaN
              const b = free(mx, my, 0)
              if (a === null) {
                if (b !== null) culledOnly++
                continue
              }
              expect(b, `projType=${projType} pitch=${pitch} z=${zoom} d=${dx},${dy}`).not.toBe(
                null,
              )
              expect([b![0], b![1]], `projType=${projType} pitch=${pitch} z=${zoom}`).toEqual([
                ax,
                ay,
              ])
              compared++
            }
          }
        }
      }
      expect(compared, 'the lattice found no commonly-projectable points').toBeGreaterThan(50)
      expect(
        culledOnly,
        'the cull-free projector never answered where the culled one did not',
      ).toBeGreaterThan(0)
    })
  }

  it('applies the world-copy period, so the plane is the SAME copy as the live run', () => {
    const cam = new Camera(0, 0, 4)
    cam.pitch = 50
    const flat: FlatGroundView = {
      projType: 0,
      ccx: cam.centerX,
      ccy: cam.centerY,
      centerLon: 0,
      centerLat: 0,
    }
    const mvp = cam.getViewForProjection(0, W, H, DPR).matrix
    const free = makeGroundMercProjector(mvp, W, H, flat)
    const live = makeLabelProjectors(mvp, W, H, {
      ...flat,
      visibleWorldCopies: [0, 1],
    }).projectMercAny
    for (const wo of [-1, 0, 1]) {
      const a = live(1_000_000, 500_000, wo)
      const b = free(1_000_000, 500_000, wo)
      expect(b).not.toBe(null)
      if (a !== null) expect([b![0], b![1]]).toEqual([a[0], a[1]])
    }
    // Non-vacuity: a projector that ignored the copy index would return one point.
    const p0 = free(1_000_000, 500_000, 0)!
    const x0 = p0[0]
    const p1 = free(1_000_000, 500_000, 1)!
    expect(p1[0]).not.toBeCloseTo(x0, 3)
  })

  it('is the identity twin at pitch 0 — the rung the whole design protects', () => {
    // At pitch 0 the pitch-0 matrix IS the live matrix, so the plane run and the
    // live run are the same floats and the walk is unchanged.
    const cam = new Camera(200_000, 900_000, 12)
    cam.bearing = 40
    cam.pitch = 0
    const flat: FlatGroundView = {
      projType: 0,
      ccx: cam.centerX,
      ccy: cam.centerY,
      centerLon: 1.8,
      centerLat: 8,
    }
    const p0 = new Pitch0Unprojector()
    const live = makeGroundMercProjector(cam.getViewForProjection(0, W, H, DPR).matrix, W, H, flat)
    const plane = makeGroundMercProjector(p0.matrix(cam, W, H, DPR), W, H, flat)
    for (let d = -400_000; d <= 400_000; d += 100_000) {
      const a = live(cam.centerX + d, cam.centerY + d)!
      const ax = a[0],
        ay = a[1]
      const b = plane(cam.centerX + d, cam.centerY + d)!
      expect([b[0], b[1]]).toEqual([ax, ay])
    }
  })
})
