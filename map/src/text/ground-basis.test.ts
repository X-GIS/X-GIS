// #777 IV3 — the ground-basis construction, proved over the domain rather than sampled.
//
// The claim that carries the whole no-regression story is: an UNPITCHED camera
// yields exactly the identity basis, at every bearing, scale and anchor. The
// construction is designed so that this holds by composition (the projector is
// the unprojector's inverse at pitch 0), so the test drives synthetic camera
// pairs — exact affine maps — and checks the property over a swept domain, not
// at one convenient camera.
//
// Synthetic rather than the real Camera on purpose: the real one would test the
// projection code, not the construction, and could not be swept exhaustively.
// The construction's contract is only "project is the inverse of
// unprojectPitch0 when pitch is 0", which an affine pair models exactly.

import { describe, it, expect } from 'vitest'
import {
  groundBasisAt,
  isIdentityBasis,
  IDENTITY_BASIS,
  type LonLat,
  type ScreenPoint,
} from './ground-basis'

/** A 2×2 screen←world map with scale + bearing, standing in for the unpitched
 *  camera. "lon/lat" here is any world plane the pair round-trips; the
 *  construction never assumes it is Mercator. */
function affineCamera(scale: number, bearingRad: number, cx = 0, cy = 0) {
  const c = Math.cos(bearingRad) * scale
  const s = Math.sin(bearingRad) * scale
  const det = c * c + s * s
  return {
    project: (lon: number, lat: number): ScreenPoint => [
      c * lon - s * lat + cx,
      s * lon + c * lat + cy,
    ],
    unproject: (x: number, y: number): LonLat => {
      const dx = x - cx
      const dy = y - cy
      return [(c * dx + s * dy) / det, (-s * dx + c * dy) / det]
    },
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
  [17, -240],
  [-960, 512],
  [1e4, 1e4],
]
const PROBES = [0.5, 1, 8, 64]

describe('#777 IV3 — groundBasisAt: identity at pitch 0, by construction', () => {
  it('is EXACTLY the identity for every bearing × scale × anchor × probe', () => {
    for (const bearing of BEARINGS) {
      for (const scale of SCALES) {
        const cam = affineCamera(scale, bearing, 33, -71)
        for (const [ax, ay] of ANCHORS) {
          for (const probe of PROBES) {
            const b = groundBasisAt(ax, ay, probe, cam.unproject, cam.project)
            expect(
              b,
              `bearing=${bearing} scale=${scale} anchor=${ax},${ay} probe=${probe}`,
            ).not.toBeNull()
            // Tolerance is float round-trip noise only — the construction is
            // algebraically exact here, so this is not a "close enough" claim.
            expect(b![0]).toBeCloseTo(1, 9)
            expect(b![1]).toBeCloseTo(0, 9)
            expect(b![2]).toBeCloseTo(0, 9)
            expect(b![3]).toBeCloseTo(1, 9)
            expect(isIdentityBasis(b!, 1e-6)).toBe(true)
          }
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
    const bn = groundBasisAt(10, 10, 4, north.unproject, north.project)!
    const be = groundBasisAt(10, 10, 4, east.unproject, east.project)!
    expect(isIdentityBasis(bn, 1e-9)).toBe(true)
    expect(isIdentityBasis(be, 1e-9)).toBe(true)
  })
})

describe('#777 IV3 — groundBasisAt: a pitched camera foreshortens', () => {
  it('reproduces the vertical squash, at every bearing (not just north-up)', () => {
    const squash = 0.4
    for (const bearing of BEARINGS) {
      const cam = affineCamera(3, bearing, 100, 200)
      const project = pitchedProjector(cam, squash, 50)
      const b = groundBasisAt(120, 260, 8, cam.unproject, project)
      expect(b, `bearing=${bearing}`).not.toBeNull()
      // The squash acts on the screen y of BOTH basis vectors, and on nothing
      // else — that is exactly what a ground-plane tilt does locally.
      expect(b![0]).toBeCloseTo(1, 9)
      expect(b![1]).toBeCloseTo(0, 9)
      expect(b![2]).toBeCloseTo(0, 9)
      expect(b![3]).toBeCloseTo(squash, 9)
      // Non-vacuity: it must NOT be the identity, or the "pitch changes the
      // quad" claim is empty.
      expect(isIdentityBasis(b!, 1e-6)).toBe(false)
    }
  })

  it('det shrinks monotonically as pitch increases', () => {
    const cam = affineCamera(1.5, 0.9)
    let prev = Infinity
    for (const squash of [1, 0.8, 0.5, 0.25, 0.05]) {
      const b = groundBasisAt(40, 90, 6, cam.unproject, pitchedProjector(cam, squash))!
      const det = b[0] * b[3] - b[1] * b[2]
      expect(det).toBeLessThan(prev)
      prev = det
    }
  })

  it('is independent of the probe radius for a locally-affine camera', () => {
    // The basis is a Jacobian; for an affine map it cannot depend on the step.
    // A construction with a hidden probe-dependent factor fails here even though
    // it might match at one convenient radius.
    const cam = affineCamera(2.5, 1.1)
    const project = pitchedProjector(cam, 0.3, -80)
    const ref = groundBasisAt(300, 400, 1, cam.unproject, project)!
    for (const probe of [0.5, 4, 64, 512]) {
      const b = groundBasisAt(300, 400, probe, cam.unproject, project)!
      for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(ref[i], 9)
    }
  })
})

describe('#777 IV3 — groundBasisAt: degenerate inputs yield NO basis, never a bad one', () => {
  const cam = affineCamera(1, 0)

  it('null from the unprojector (azimuthal / globe) propagates to null', () => {
    // Each of the three probes is exercised separately: a construction that
    // only checked the first would place two of the three cases wrong.
    const failAt = (fx: number, fy: number) => (x: number, y: number) =>
      x === fx && y === fy ? null : cam.unproject(x, y)
    expect(groundBasisAt(10, 20, 5, failAt(10, 20), cam.project)).toBeNull()
    expect(groundBasisAt(10, 20, 5, failAt(15, 20), cam.project)).toBeNull()
    expect(groundBasisAt(10, 20, 5, failAt(10, 25), cam.project)).toBeNull()
  })

  it('null from the projector propagates to null', () => {
    expect(groundBasisAt(10, 20, 5, cam.unproject, () => null)).toBeNull()
  })

  it('a collapsed (singular) projection yields null rather than a flattened label', () => {
    // Everything maps to one screen row: det = 0. Drawing through that basis
    // would collapse the glyph quad to a line.
    const collapse = (): ScreenPoint => [0, 0]
    expect(groundBasisAt(10, 20, 5, cam.unproject, collapse)).toBeNull()
  })

  it('a non-finite or non-positive probe yields null, not NaN vertices', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(groundBasisAt(10, 20, bad, cam.unproject, cam.project)).toBeNull()
    }
  })

  it('a NaN-producing projector yields null', () => {
    expect(groundBasisAt(10, 20, 5, cam.unproject, () => [NaN, 0])).toBeNull()
  })
})

describe('#777 IV3 — isIdentityBasis', () => {
  it('accepts the identity and rejects a foreshortened basis', () => {
    expect(isIdentityBasis(IDENTITY_BASIS)).toBe(true)
    expect(isIdentityBasis([1, 0, 0, 0.5])).toBe(false)
    expect(isIdentityBasis([1, 0.2, 0, 1])).toBe(false)
  })
})

describe('#777 IV3 — a projector that returns a REUSED scratch tuple', () => {
  // The bug that made #1471 + #1492 inert on main. `makeLabelProjectors`'
  // `projectLonLat` returns `_projScratch`, one array reused across calls, and
  // `groundBasisAt` needs THREE projections at once. Holding them as tuples
  // aliases all three to the last result → every difference 0 → det 0 → null,
  // for every label, silently.
  //
  // Every pre-existing test here passes a projector that allocates a fresh tuple
  // per call, which no production caller does — so they were green throughout.
  // This one models the real contract.
  const scratchProjector = (
    inner: (lon: number, lat: number) => [number, number],
  ): ((lon: number, lat: number) => readonly [number, number]) => {
    const scratch: [number, number] = [0, 0]
    return (lon, lat) => {
      const v = inner(lon, lat)
      scratch[0] = v[0]
      scratch[1] = v[1]
      return scratch
    }
  }

  /** A pitched-ish projector: east compresses, north compresses more. */
  const pitched = scratchProjector((lon, lat) => [lon * 1000, lat * 400])
  const unproject = (x: number, y: number): [number, number] => [x / 1000, y / 1000]

  it('still yields a usable basis — the scratch must not alias the result', () => {
    const b = groundBasisAt(100, 100, 8, unproject, pitched)
    expect(b, 'a reused-scratch projector collapsed the basis to null').not.toBeNull()
    expect(b!.every(Number.isFinite)).toBe(true)
    const det = b![0] * b![3] - b![1] * b![2]
    expect(Math.abs(det), 'basis is singular — the three projections aliased').toBeGreaterThan(1e-6)
  })

  it('agrees with the same projector returning fresh tuples', () => {
    const fresh = (lon: number, lat: number): [number, number] => [lon * 1000, lat * 400]
    const a = groundBasisAt(100, 100, 8, unproject, pitched)!
    const c = groundBasisAt(100, 100, 8, unproject, fresh)!
    expect([...a]).toEqual([...c])
  })
})
