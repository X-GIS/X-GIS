// ADR-0012 D1 / INC-1 — the ground-basis construction, proved over the domain
// rather than sampled.
//
// The claim that carries the whole no-regression story is: an UNPITCHED camera
// yields exactly the identity basis, at every bearing, scale, projection and
// anchor. The construction is designed so that this holds by composition (at
// pitch 0 the live projector IS the pitch-0 projector — same code, same matrix),
// so the sweeps below drive both synthetic projector pairs — exact maps, so the
// property can be checked over a swept domain — and the REAL flat projector over
// projType 0-6, which is the half the predecessor could not satisfy at all.
//
// The second claim is the one INC-1 exists for: the basis must describe the
// ground deformation AT THE LABEL, not at the pitch-0 image of its screen anchor.
// That is asserted against an independent ground truth — a real ground step,
// projected through both cameras — rather than against the construction itself.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import {
  groundBasisAt,
  isIdentityBasis,
  IDENTITY_BASIS,
  BASIS_PROBE_DEG,
  type ScreenPoint,
} from './ground-basis'
import { makeGroundProjector, Pitch0Unprojector } from '../camera/pitch0-unproject'
import { projMercatorCpu } from '../shaders/dsl/cpu-projections'

const W = 1200,
  H = 800,
  DPR = 1

/** A 2×2 screen←world map with scale + bearing, standing in for the unpitched
 *  camera. "lon/lat" here is any world plane; the construction never assumes it
 *  is Mercator. */
function affineCamera(scale: number, bearingRad: number, cx = 0, cy = 0) {
  const c = Math.cos(bearingRad) * scale
  const s = Math.sin(bearingRad) * scale
  return {
    project: (lon: number, lat: number): ScreenPoint => [
      c * lon - s * lat + cx,
      s * lon + c * lat + cy,
    ],
  }
}

/** Compose an unpitched camera with a vertical squash in SCREEN space — the
 *  shape a pitched camera has locally: the ground's screen-vertical axis
 *  foreshortens while the horizontal one does not. */
function pitchedProjector(
  base: ReturnType<typeof affineCamera>,
  squash: number,
  horizonY = 0,
): (lon: number, lat: number) => ScreenPoint {
  return (lon, lat) => {
    const p = base.project(lon, lat)
    return [p[0], horizonY + (p[1] - horizonY) * squash]
  }
}

const BEARINGS = [0, 0.3, 1, Math.PI / 2, 2, Math.PI, 4, 5.7]
const SCALES = [1e-3, 0.5, 1, 7, 1024]
const ANCHORS: [number, number][] = [
  [0, 0],
  [17, -24],
  [-96, 51],
  [1e3, 1e3],
]

/** Exact-identity assertion that tolerates the SIGN of zero. `(x·y − y·x)/det`
 *  is +0 or −0 depending on sign(det); both are exactly zero, `===` says so, and
 *  `toEqual` (Object.is) would not. Nothing downstream can tell them apart —
 *  `Math.abs(-0) === 0` for `isIdentityBasis`, and `d + −0 === d` in the quad. */
function expectExactIdentity(b: readonly number[] | null, where: string): void {
  expect(b, where).not.toBeNull()
  expect(b![0] === 1 && b![1] === 0 && b![2] === 0 && b![3] === 1, `${where}: got [${b}]`).toBe(
    true,
  )
}

/** A finite difference has a conditioning floor: the projections are read at
 *  |screen| and differenced over δ·(dScreen/dDeg), so the relative error is
 *  ~eps·|screen|/step. The REAL cameras below sit at ~1e-11 (screen ~1e3 px,
 *  step ~0.02 px at z14); these synthetic ones are deliberately unit-scale, so
 *  they are pinned about the origin to keep |screen| small and the sweep sharp.
 *  Where an offset is deliberately introduced, the looser bound is named there. */
const ORIGIN_ANCHOR: [number, number] = [0.12, 0.26]

describe('D1 INC-1 — groundBasisAt: identity at pitch 0, by construction', () => {
  it('is EXACTLY the identity — bit-for-bit — for every bearing × scale × anchor', () => {
    for (const bearing of BEARINGS) {
      for (const scale of SCALES) {
        const cam = affineCamera(scale, bearing, 33, -71)
        for (const [ax, ay] of ANCHORS) {
          // NOT toBeCloseTo. The ratio of a Jacobian with itself reduces, term
          // for term, to values IEEE-754 guarantees exactly; the whole
          // byte-identity rung rests on that being a fact and not a tolerance.
          // It holds at EVERY scale and anchor here, including the ill-
          // conditioned ones — the two Jacobians are the same floats, so the
          // conditioning floor cancels with them.
          expectExactIdentity(
            groundBasisAt(ax, ay, cam.project, cam.project),
            `bearing=${bearing} scale=${scale} anchor=${ax},${ay}`,
          )
        }
      }
    }
  })

  it('a bearing alone never rotates the basis (the trap the old plan fell into)', () => {
    // Dividing by |e| would have made this pass too — but it would have failed
    // the pitched case below at bearing 90°. Both are asserted, so neither
    // construction can satisfy one by breaking the other.
    const north = affineCamera(2, 0)
    const east = affineCamera(2, Math.PI / 2)
    expect(isIdentityBasis(groundBasisAt(10, 10, north.project, north.project)!, 0)).toBe(true)
    expect(isIdentityBasis(groundBasisAt(10, 10, east.project, east.project)!, 0)).toBe(true)
  })
})

// The REAL projector, over the projType set the predecessor could not reach.
// `unprojectToLonLat` returns null for the azimuthal discs (3/4/5), so the
// screen-anchor construction had NO basis there at all — the forward-only ratio
// needs no inverse, so they resolve like every other flat projection.
describe('D1 INC-1 — identity at pitch 0 over projType 0-6 × latitude × bearing × zoom', () => {
  for (const projType of [0, 1, 2, 3, 4, 5, 6]) {
    it(`projType ${projType}`, () => {
      for (const zoom of [1, 5, 11, 16]) {
        for (const lat of [0, 33, -47, 71]) {
          for (const bearing of [0, 37, -125]) {
            const cam = new Camera(9, lat, zoom)
            cam.projType = projType
            cam.bearing = bearing
            cam.pitch = 0
            const cm = projMercatorCpu(9, lat)
            const flat = { projType, ccx: cm[0], ccy: cm[1], centerLon: 9, centerLat: lat }
            const live = makeGroundProjector(
              cam.getViewForProjection(projType, W, H, DPR).matrix,
              W,
              H,
              flat,
            )
            const p0 = makeGroundProjector(
              new Pitch0Unprojector().matrix(cam, W, H, DPR),
              W,
              H,
              flat,
            )
            expectExactIdentity(
              groundBasisAt(9.4, lat + 0.3, live, p0),
              `projType=${projType} z=${zoom} lat=${lat} bearing=${bearing}`,
            )
          }
        }
      }
    })
  }
})

describe('D1 INC-1 — groundBasisAt: a pitched camera foreshortens', () => {
  it('reproduces the vertical squash, at every bearing (not just north-up)', () => {
    const squash = 0.4
    for (const bearing of BEARINGS) {
      const cam = affineCamera(3, bearing)
      const b = groundBasisAt(...ORIGIN_ANCHOR, pitchedProjector(cam, squash), cam.project)
      expect(b, `bearing=${bearing}`).not.toBeNull()
      // The squash acts on the screen y of BOTH basis vectors, and on nothing
      // else — that is exactly what a ground-plane tilt does locally. 8 digits,
      // not 9: this camera differences ~3e-8 px out of ~0.8, so its f64
      // cancellation floor is ~7e-10 (measured). See ORIGIN_ANCHOR.
      expect(b![0]).toBeCloseTo(1, 8)
      expect(b![1]).toBeCloseTo(0, 8)
      expect(b![2]).toBeCloseTo(0, 8)
      expect(b![3]).toBeCloseTo(squash, 8)
      // Non-vacuity: it must NOT be the identity, or the "pitch changes the
      // quad" claim is empty.
      expect(isIdentityBasis(b!, 1e-6)).toBe(false)
    }
  })

  it('is independent of where the squash line and the screen origin sit', () => {
    // The basis is a derivative, so a translation of the screen frame (`cx/cy`)
    // and of the squash's fixed line (`horizonY`) must not reach it. Held to 5
    // digits, not 9, and the reason is arithmetic rather than approximate: those
    // offsets put the projections at |screen| ~ 200 while the δ = 1e-8° step
    // spans ~3e-8 px on this unit-scale synthetic camera, so f64 cancellation
    // costs ~1e-6 relative. A real camera differences ~0.02 px out of ~1e3 and
    // lands at ~1e-11 — see the real-projector contract sweep below.
    const squash = 0.4
    const ref = affineCamera(3, 1.1)
    const off = affineCamera(3, 1.1, 100, 200)
    const b0 = groundBasisAt(...ORIGIN_ANCHOR, pitchedProjector(ref, squash), ref.project)!
    const b1 = groundBasisAt(...ORIGIN_ANCHOR, pitchedProjector(off, squash, 50), off.project)!
    for (let i = 0; i < 4; i++) expect(b1[i]).toBeCloseTo(b0[i]!, 5)
  })

  it('det shrinks monotonically as pitch increases', () => {
    const cam = affineCamera(1.5, 0.9)
    let prev = Infinity
    for (const squash of [1, 0.8, 0.5, 0.25, 0.05]) {
      const b = groundBasisAt(...ORIGIN_ANCHOR, pitchedProjector(cam, squash), cam.project)!
      const det = b[0] * b[3] - b[1] * b[2]
      expect(det).toBeLessThan(prev)
      prev = det
    }
  })
})

// THE INC-1 CLAIM. The predecessor linearized about `unproject_pitch0(anchor)` —
// the ground point that WOULD be under that pixel if pitch were 0 — while the
// renderer pivots the quad on the LIVE anchor. The two coincide only at the
// screen centre, and the gap grows with pitch and with distance from it, so the
// far-field labels ground projection is most visible on got the least correct
// basis. The ground truth here is independent of both constructions: take a real
// ground step at the label, project it through BOTH cameras, and require the
// basis to carry the pitch-0 screen delta onto the live one.
describe('D1 INC-1 — the basis is derived at the LABEL, not at its screen anchor', () => {
  const STEP = 1e-5 // degrees — small enough to be locally linear, big enough to read

  function scene(pitch: number) {
    const cam = new Camera(0, 0, 14)
    cam.projType = 0
    cam.pitch = pitch
    const cm = projMercatorCpu(0, 0)
    const flat = { projType: 0, ccx: cm[0], ccy: cm[1], centerLon: 0, centerLat: 0 }
    return {
      cam,
      live: makeGroundProjector(cam.getViewForProjection(0, W, H, DPR).matrix, W, H, flat),
      p0: makeGroundProjector(new Pitch0Unprojector().matrix(cam, W, H, DPR), W, H, flat),
    }
  }

  /** Relative error of `basis · (pitch-0 delta)` against the live delta. */
  function contractError(
    s: ReturnType<typeof scene>,
    lon: number,
    lat: number,
    basis: ArrayLike<number>,
    dLon: number,
    dLat: number,
  ): number {
    const l0 = s.live(lon, lat)!
    const l0x = l0[0],
      l0y = l0[1]
    const l1 = s.live(lon + dLon, lat + dLat)!
    const dlx = l1[0] - l0x,
      dly = l1[1] - l0y
    const z0 = s.p0(lon, lat)!
    const z0x = z0[0],
      z0y = z0[1]
    const z1 = s.p0(lon + dLon, lat + dLat)!
    const dzx = z1[0] - z0x,
      dzy = z1[1] - z0y
    const px = dzx * basis[0]! + dzy * basis[2]!
    const py = dzx * basis[1]! + dzy * basis[3]!
    return Math.hypot(px - dlx, py - dly) / Math.hypot(dlx, dly)
  }

  for (const pitch of [45, 60, 70]) {
    it(`honours the contract at 0-400 px off centre, pitch ${pitch}`, () => {
      const s = scene(pitch)
      for (const offPx of [0, 100, 200, 300, 400]) {
        const ll = s.cam.unprojectToLonLat(W / 2, H / 2 - offPx, W, H, DPR)!
        const b = groundBasisAt(ll[0], ll[1], s.live, s.p0)
        expect(b, `off=${offPx}`).not.toBeNull()
        for (const [dLon, dLat] of [
          [STEP, 0],
          [0, STEP],
        ] as const) {
          // 1e-3 relative is the linearization residual of the 1e-5° ground
          // truth itself (Mercator y is not linear in latitude), not slack: the
          // measured values are ~1e-11 on the east axis and ~1e-4 on the north.
          expect(
            contractError(s, ll[0], ll[1], b!, dLon, dLat),
            `off=${offPx} d=${dLon ? 'E' : 'N'}`,
          ).toBeLessThan(1e-3)
        }
      }
    })
  }

  it('and the screen-anchor basis it replaces does NOT — by 84 % / 240 % at 400 px', () => {
    // Non-vacuity for the sweep above: without this the assertions there would
    // pass for any construction whose error happens to be small at this camera.
    // The predecessor's basis is reconstructed exactly as it was built — the
    // Jacobian of `project_live ∘ unproject_pitch0` at the SCREEN anchor — and
    // measured against the same contract, at the same anchors.
    const s = scene(60)
    const p0u = new Pitch0Unprojector()
    const worst = { east: 0, north: 0 }
    for (const offPx of [100, 200, 300, 400]) {
      const sx = W / 2,
        sy = H / 2 - offPx
      const ll = s.cam.unprojectToLonLat(sx, sy, W, H, DPR)!
      const probe = 16
      const g = p0u.unprojectToLonLat(s.cam, sx, sy, W, H, DPR)!
      const gx = p0u.unprojectToLonLat(s.cam, sx + probe, sy, W, H, DPR)!
      const gy = p0u.unprojectToLonLat(s.cam, sx, sy + probe, W, H, DPR)!
      const a = s.live(g[0], g[1])!
      const ax = a[0],
        ay = a[1]
      const bx = s.live(gx[0], gx[1])!
      const bx0 = bx[0],
        bx1 = bx[1]
      const by = s.live(gy[0], gy[1])!
      const by0 = by[0],
        by1 = by[1]
      const legacy = [
        (bx0 - ax) / probe,
        (bx1 - ay) / probe,
        (by0 - ax) / probe,
        (by1 - ay) / probe,
      ]
      worst.east = Math.max(worst.east, contractError(s, ll[0], ll[1], legacy, STEP, 0))
      worst.north = Math.max(worst.north, contractError(s, ll[0], ll[1], legacy, 0, STEP))
    }
    expect(worst.east, 'the screen-anchor basis was accurate on the east axis').toBeGreaterThan(0.5)
    expect(worst.north, 'the screen-anchor basis was accurate on the north axis').toBeGreaterThan(2)
  })
})

describe('D1 INC-1 — groundBasisAt: degenerate inputs yield NO basis, never a bad one', () => {
  const cam = affineCamera(1, 0)

  it('null from either projector propagates to null, at every probe', () => {
    // Each of the six projections is exercised separately: a construction that
    // only checked the first would place five of the six cases wrong.
    const d = BASIS_PROBE_DEG
    const failAt =
      (fx: number, fy: number) =>
      (lon: number, lat: number): ScreenPoint | null =>
        lon === fx && lat === fy ? null : cam.project(lon, lat)
    for (const [flon, flat_] of [
      [10, 20],
      [10 + d, 20],
      [10, 20 + d],
    ] as const) {
      expect(groundBasisAt(10, 20, failAt(flon, flat_), cam.project)).toBeNull()
      expect(groundBasisAt(10, 20, cam.project, failAt(flon, flat_))).toBeNull()
    }
  })

  it('a collapsed (singular) pitch-0 projection yields null, not an infinite basis', () => {
    // Everything maps to one screen point: the pitch-0 Jacobian is singular, so
    // the solve has no answer. This is also the Mercator pole clamp's shape —
    // the latitude probe truncated to zero length.
    const collapse = (): ScreenPoint => [0, 0]
    expect(groundBasisAt(10, 20, cam.project, collapse)).toBeNull()
  })

  it('a collapsed LIVE projection yields null rather than a flattened label', () => {
    // det(basis) = 0: the glyph quad would draw as a line.
    expect(groundBasisAt(10, 20, () => [0, 0], cam.project)).toBeNull()
  })

  it('a NaN-producing projector yields null', () => {
    expect(groundBasisAt(10, 20, () => [NaN, 0], cam.project)).toBeNull()
    expect(groundBasisAt(10, 20, cam.project, () => [NaN, 0])).toBeNull()
  })

  it('a latitude probe PARTLY truncated by a clamp still yields the right basis', () => {
    // The ratio cancels any per-COLUMN rescale of the step, so a probe the
    // Mercator ±85.051129 clamp shortened (but did not erase) is still exact —
    // the clamp cuts the north column of BOTH Jacobians by the same factor.
    // Without that property such a label would draw through a wildly scaled
    // north axis instead, and no threshold on a dimensionless determinant would
    // catch it. Truncated to a TENTH of δ here, an order of magnitude past what
    // any real anchor would see.
    const squash = 0.4
    const base = affineCamera(3, 0.7)
    const live = pitchedProjector(base, squash)
    const lat0 = ORIGIN_ANCHOR[1]
    const clampLat = (lat: number): number => Math.min(lat, lat0 + BASIS_PROBE_DEG * 0.1)
    const full = groundBasisAt(ORIGIN_ANCHOR[0], lat0, live, base.project)!
    const clipped = groundBasisAt(
      ORIGIN_ANCHOR[0],
      lat0,
      (lon, lat) => live(lon, clampLat(lat)),
      (lon, lat) => base.project(lon, clampLat(lat)),
    )!
    for (let i = 0; i < 4; i++) expect(clipped[i]).toBeCloseTo(full[i]!, 6)
  })
})

describe('D1 INC-1 — isIdentityBasis', () => {
  it('accepts the identity and rejects a foreshortened basis', () => {
    expect(isIdentityBasis(IDENTITY_BASIS)).toBe(true)
    expect(isIdentityBasis([1, 0, 0, 0.5])).toBe(false)
    expect(isIdentityBasis([1, 0.2, 0, 1])).toBe(false)
  })
})

describe('D1 INC-1 — projectors that return a REUSED scratch tuple', () => {
  // The bug that made #1471 + #1492 inert on main. `makeGroundProjector` returns
  // one array reused across calls, and the construction needs SIX projections at
  // once. Holding them as tuples aliases them to the last result → every
  // difference 0 → det 0 → null, for every label, silently. Six probes double
  // the number of places to get this wrong, so it is pinned on both projectors.
  const scratchProjector = (
    inner: (lon: number, lat: number) => [number, number],
  ): ((lon: number, lat: number) => ScreenPoint) => {
    const scratch: [number, number] = [0, 0]
    return (lon, lat) => {
      const v = inner(lon, lat)
      scratch[0] = v[0]
      scratch[1] = v[1]
      return scratch
    }
  }
  const liveFn = (lon: number, lat: number): [number, number] => [lon * 1000, lat * 400]
  const p0Fn = (lon: number, lat: number): [number, number] => [lon * 1000, lat * 1000]
  const AT: [number, number] = [0.1, 0.1]

  it('still yields a usable basis — no scratch may alias another read', () => {
    const b = groundBasisAt(...AT, scratchProjector(liveFn), scratchProjector(p0Fn))
    expect(b, 'a reused-scratch projector collapsed the basis to null').not.toBeNull()
    expect(b!.every(Number.isFinite)).toBe(true)
    const det = b![0] * b![3] - b![1] * b![2]
    expect(Math.abs(det), 'basis is singular — the six projections aliased').toBeGreaterThan(1e-6)
  })

  it('agrees with the same projectors returning fresh tuples', () => {
    const a = groundBasisAt(...AT, scratchProjector(liveFn), scratchProjector(p0Fn))!
    const c = groundBasisAt(...AT, liveFn, p0Fn)!
    expect([...a]).toEqual([...c])
  })

  it('and ONE scratch shared BETWEEN the two projectors is survived too', () => {
    // The failure mode six probes add that three did not have. If the live and
    // the pitch-0 reads aliased one buffer, the two Jacobians would come back
    // EQUAL and the basis would be the identity — a plausible value, not a null,
    // so nothing downstream would object and every label would quietly billboard
    // again. Reading each projection into scalars immediately is what prevents
    // it, and that is asserted here rather than assumed.
    const shared: [number, number] = [0, 0]
    const via =
      (inner: (lon: number, lat: number) => [number, number]) =>
      (lon: number, lat: number): ScreenPoint => {
        const v = inner(lon, lat)
        shared[0] = v[0]
        shared[1] = v[1]
        return shared
      }
    const b = groundBasisAt(...AT, via(liveFn), via(p0Fn))
    expect(b).not.toBeNull()
    expect(isIdentityBasis(b!, 1e-6), 'the shared buffer collapsed the basis to identity').toBe(
      false,
    )
    expect(b![3]).toBeCloseTo(0.4, 6)
  })
})
