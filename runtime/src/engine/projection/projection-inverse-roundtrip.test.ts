// iter-323 — Projection INVERSE correctness gate. iter-311 found a
// real bug (reprojector equirect inverse MISSING → blank map). The CPU
// projection.ts inverse functions are the canonical reference the WGSL
// mirrors, yet only equirect had a dedicated inverse test. Forward was
// finiteness-gated at iter-317; inverse never was.
//
// Render-error contracts an inverse must hold:
//   1. ROUND-TRIP: for a point the forward projects to a finite (x,y),
//      inverse(x,y) ≈ the original (lon,lat). A sign error / wrong
//      constant / Newton divergence breaks this → tile selection (which
//      inverts screen→geo) picks the wrong tiles → mispositioned map.
//   2. RANGE: inverse output lon ∈ [-180,180], lat ∈ [-90,90] OR a
//      NaN sentinel. NEVER a finite-but-out-of-range value (lat=200)
//      and NEVER ±Infinity — those silently corrupt downstream math.
//   3. CENTRE: the azimuthal family inverts the origin (0,0) back to
//      the projection centre (the rho→0 singularity guard).

import { describe, it, expect } from 'vitest'
import {
  mercator,
  equirectangular,
  naturalEarth,
  orthographic,
  azimuthalEquidistant,
  stereographic,
  obliqueMercator,
  type Projection,
} from '@xgis/geo'

// Round-trip tolerance in degrees. Points are chosen well inside each
// projection's well-conditioned domain (away from rim / pole / clamp),
// so the only error source is float + (for NE) the 5-iter Newton solve.
const TOL_DEG = 1e-3

function assertInverseInRange(lon: number, lat: number, ctx: string): void {
  // NaN is an allowed sentinel (culled / out-of-domain). What's NOT
  // allowed: a finite value outside the geographic range, or Infinity.
  if (Number.isNaN(lon) && Number.isNaN(lat)) return
  expect(Number.isFinite(lon), `${ctx} lon non-finite ${lon}`).toBe(true)
  expect(Number.isFinite(lat), `${ctx} lat non-finite ${lat}`).toBe(true)
  expect(lon >= -180.001 && lon <= 180.001, `${ctx} lon ${lon} out of range`).toBe(true)
  expect(lat >= -90.001 && lat <= 90.001, `${ctx} lat ${lat} out of range`).toBe(true)
}

/** For every (lon,lat) the forward maps to a FINITE point, the inverse
 *  must return to the original within tolerance + be in-range. Points
 *  the forward culls (NaN) are skipped — that's a domain boundary, not
 *  an inverse failure. */
function assertRoundTrip(proj: Projection, lonLats: [number, number][], ctx: string): void {
  let tested = 0
  for (const [lon, lat] of lonLats) {
    const [x, y] = proj.forward(lon, lat)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue // culled — skip
    const [lon2, lat2] = proj.inverse(x, y)
    assertInverseInRange(lon2, lat2, `${ctx} fwd(${lon},${lat})→inv`)
    expect(
      Math.abs(lat2 - lat),
      `${ctx} lat round-trip drift @(${lon},${lat}): ${lat}→${lat2}`,
    ).toBeLessThan(TOL_DEG)
    // Longitude is DEGENERATE at the poles — every meridian collapses to
    // one point, so a recovered lon there carries no information. Only
    // check lon round-trip away from the poles.
    if (Math.abs(lat) < 89.5) {
      let dLon = lon2 - lon
      if (dLon > 180) dLon -= 360
      if (dLon < -180) dLon += 360
      expect(
        Math.abs(dLon),
        `${ctx} lon round-trip drift @(${lon},${lat}): ${lon}→${lon2}`,
      ).toBeLessThan(TOL_DEG)
    }
    tested++
  }
  // Guard the guard: a domain that culls EVERY point would make the
  // round-trip vacuously pass.
  expect(tested, `${ctx} no point survived forward — test is vacuous`).toBeGreaterThan(0)
}

// Well-conditioned sample points per domain class.
const CYLINDRICAL_PTS: [number, number][] = [
  [0, 0],
  [45, 30],
  [-90, -45],
  [120, 60],
  [-150, -60],
  [179, 10],
  [-179, -10],
  [30, 80],
  [30, -80],
]
// Mercator must stay inside ±85.05 (forward clamps beyond → round-trip
// would fail at the clamp, which is correct behaviour not a bug).
const MERCATOR_PTS: [number, number][] = [
  [0, 0],
  [45, 30],
  [-90, -45],
  [120, 60],
  [-150, -60],
  [179, 84],
  [-179, -84],
]

describe('iter-323 cylindrical projection inverse round-trip', () => {
  it('mercator: inverse(forward(p)) ≈ p inside ±85.05', () => {
    assertRoundTrip(mercator, MERCATOR_PTS, 'mercator')
  })

  it('equirectangular (centralLon=0): round-trip', () => {
    assertRoundTrip(equirectangular(0), CYLINDRICAL_PTS, 'equirect-0')
  })

  it('equirectangular (centralLon=140): recentred round-trip', () => {
    // The iter-311 class: recentred inverse must undo the centralLon shift.
    assertRoundTrip(equirectangular(140), CYLINDRICAL_PTS, 'equirect-140')
  })

  it('natural_earth (centralLon=0): Newton-solve round-trip', () => {
    // NE inverse is a 5-iter Newton solve — the loosest of the set.
    // Stay below ±80 where the polynomial Jacobian is well-behaved.
    const nePts: [number, number][] = CYLINDRICAL_PTS.filter(([, lat]) => Math.abs(lat) <= 75)
    assertRoundTrip(naturalEarth(0), nePts, 'ne-0')
  })

  it('natural_earth (centralLon=-60): recentred round-trip', () => {
    const nePts: [number, number][] = CYLINDRICAL_PTS.filter(([, lat]) => Math.abs(lat) <= 75)
    assertRoundTrip(naturalEarth(-60), nePts, 'ne--60')
  })
})

describe('iter-323 azimuthal-family inverse round-trip + centre singularity', () => {
  // Hemispherical projections: only the visible hemisphere round-trips.
  // Sample points near each centre (well inside the visible disc).
  function nearCentre(clon: number, clat: number): [number, number][] {
    const out: [number, number][] = [[clon, clat]]
    for (const dLon of [-30, -10, 10, 30]) {
      for (const dLat of [-30, -10, 10, 30]) {
        out.push([clon + dLon, clat + dLat])
      }
    }
    return out
  }

  it('orthographic (centre 0,20): visible-hemisphere round-trip', () => {
    assertRoundTrip(orthographic(0, 20), nearCentre(0, 20), 'ortho')
  })

  it('orthographic (centre 135,-40): off-equator centre round-trip', () => {
    assertRoundTrip(orthographic(135, -40), nearCentre(135, -40), 'ortho-se')
  })

  it('azimuthal_equidistant (centre 0,20): round-trip', () => {
    assertRoundTrip(azimuthalEquidistant(0, 20), nearCentre(0, 20), 'azi')
  })

  it('azimuthal_equidistant (centre -100,60): polar-ish centre round-trip', () => {
    assertRoundTrip(azimuthalEquidistant(-100, 60), nearCentre(-100, 60), 'azi-north')
  })

  it('stereographic (centre 0,20): round-trip', () => {
    assertRoundTrip(stereographic(0, 20), nearCentre(0, 20), 'stereo')
  })

  it('centre singularity: inverse(0,0) returns the projection centre', () => {
    // The rho→0 guard. Each azimuthal inverse must map the origin back
    // to its centre, not divide-by-zero into NaN.
    for (const [clon, clat] of [
      [0, 20],
      [135, -40],
      [-100, 60],
    ] as [number, number][]) {
      for (const make of [orthographic, azimuthalEquidistant, stereographic]) {
        const [lon, lat] = make(clon, clat).inverse(0, 0)
        expect(lon, `${make.name}(${clon},${clat}).inverse(0,0) lon`).toBeCloseTo(clon, 6)
        expect(lat, `${make.name}(${clon},${clat}).inverse(0,0) lat`).toBeCloseTo(clat, 6)
      }
    }
  })
})

describe('iter-323 oblique mercator inverse round-trip', () => {
  it('oblique (centre 0,20): rotated-frame round-trip', () => {
    // Oblique tilts (centre→equator); near the rotated equator it is
    // well-conditioned. Sample around the centre.
    const pts: [number, number][] = [[0, 20]]
    for (const dLon of [-40, -15, 15, 40]) {
      for (const dLat of [-30, -10, 10, 30]) pts.push([dLon, 20 + dLat])
    }
    assertRoundTrip(obliqueMercator(0, 20), pts, 'oblique')
  })

  it('oblique (centre 130,35): Korea-ish centre round-trip', () => {
    const pts: [number, number][] = [[130, 35]]
    for (const dLon of [-30, -10, 10, 30]) {
      for (const dLat of [-25, 25]) pts.push([130 + dLon, 35 + dLat])
    }
    assertRoundTrip(obliqueMercator(130, 35), pts, 'oblique-korea')
  })
})

describe('iter-323 inverse never emits Infinity / out-of-range (random projected input)', () => {
  // Feed plausible projected coordinates (a disc of radius 2R) and
  // assert the inverse output is in-range-or-NaN — never Infinity, never
  // a finite-but-impossible lat/lon. This catches an inverse that
  // returns garbage on out-of-domain input (the silent-corruption class).
  const R = 6378137
  let s = 0x5eed1
  const rng = () => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }

  const projs: [string, Projection][] = [
    ['mercator', mercator],
    ['equirect', equirectangular(0)],
    ['ne', naturalEarth(0)],
    ['ortho', orthographic(0, 20)],
    ['azi', azimuthalEquidistant(0, 20)],
    ['stereo', stereographic(0, 20)],
    ['oblique', obliqueMercator(0, 20)],
  ]

  for (const [name, proj] of projs) {
    it(`${name}: 300 random projected points → in-range or NaN`, () => {
      for (let i = 0; i < 300; i++) {
        const x = (rng() * 4 - 2) * R
        const y = (rng() * 4 - 2) * R
        const [lon, lat] = proj.inverse(x, y)
        assertInverseInRange(lon, lat, `${name} inverse(${x.toFixed(0)},${y.toFixed(0)})`)
      }
    })
  }
})
