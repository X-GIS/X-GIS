// iter-317 — Projection.forward edge-input probe. Feeds every
// projection's forward() the inputs a real camera / tile / label
// path could produce at extremes: poles (±90), antimeridian
// (±180), exact Mercator limit, and (defensively) NaN/Infinity.
//
// Goal: surface SILENT garbage — a forward() that returns a
// non-finite coordinate on a VALID input (pole / antimeridian)
// would place geometry off-planet → blank or smeared render.
// NaN/Infinity inputs are documented (callers pre-clamp), but the
// VALID-input finiteness is a hard render contract.

import { describe, it, expect } from 'vitest'
import {
  mercator,
  equirectangular,
  naturalEarth,
  orthographic,
  azimuthalEquidistant,
  stereographic,
  obliqueMercator,
  MERCATOR_LAT_LIMIT,
} from '@xgis/geo'
import type { Projection } from '@xgis/geo'

const CYLINDRICAL: Array<[string, Projection]> = [
  ['mercator', mercator],
  ['equirectangular', equirectangular(0)],
  ['naturalEarth', naturalEarth(0)],
]
const AZIMUTHAL: Array<[string, Projection]> = [
  ['orthographic', orthographic(0, 0)],
  ['azimuthalEquidistant', azimuthalEquidistant(0, 0)],
  ['stereographic', stereographic(0, 0)],
]

function finite2(p: [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1])
}

describe('iter-317 projection.forward — VALID-input finiteness (render contract)', () => {
  // The Mercator-family projections clamp lat internally, so even
  // ±90 must produce finite output.
  for (const [name, proj] of CYLINDRICAL) {
    it(`${name}: finite at antimeridian + poles + Mercator-limit`, () => {
      const samples: [number, number][] = [
        [0, 0],
        [180, 0],
        [-180, 0],
        [179.999, 0],
        [0, 85],
        [0, -85],
        [0, MERCATOR_LAT_LIMIT],
        [0, -MERCATOR_LAT_LIMIT],
        [0, 90],
        [0, -90], // poles — clamp must keep finite
        [180, 90],
        [-180, -90],
      ]
      for (const [lon, lat] of samples) {
        const out = proj.forward(lon, lat)
        if (!finite2(out)) {
          throw new Error(`${name}.forward(${lon}, ${lat}) = [${out}] non-finite`)
        }
      }
    })
  }

  // Azimuthal family: front-hemisphere points must be finite. Back-
  // hemisphere returns [NaN, NaN] BY DESIGN (cull sentinel) — that's
  // the documented A-3 behaviour, not a bug. Probe front hemisphere
  // only for the finiteness contract.
  for (const [name, proj] of AZIMUTHAL) {
    it(`${name}: finite on the front hemisphere (center 0,0)`, () => {
      const front: [number, number][] = [
        [0, 0],
        [10, 10],
        [-10, -10],
        [45, 0],
        [0, 45],
        [-45, 30],
      ]
      for (const [lon, lat] of front) {
        const out = proj.forward(lon, lat)
        if (!finite2(out)) {
          throw new Error(
            `${name}.forward(${lon}, ${lat}) = [${out}] non-finite on front hemisphere`,
          )
        }
      }
    })

    it(`${name}: back hemisphere returns the [NaN,NaN] cull sentinel (A-3 design)`, () => {
      // Antipodal-ish point — well behind the projection center.
      const out = proj.forward(180, 0)
      // Either NaN sentinel (culled) OR finite. Must NOT be a wild
      // finite garbage value far outside the planet radius.
      if (finite2(out)) {
        const R = 6378137
        expect(Math.hypot(out[0], out[1])).toBeLessThan(R * 4)
      } else {
        expect(Number.isNaN(out[0])).toBe(true)
      }
    })
  }

  it('obliqueMercator: finite on its main strip', () => {
    const obl = obliqueMercator(0, 0)
    for (const [lon, lat] of [
      [0, 0],
      [10, 10],
      [-10, 10],
      [30, -20],
      [0, 45],
    ] as [number, number][]) {
      const out = obl.forward(lon, lat)
      if (!finite2(out)) throw new Error(`obliqueMercator.forward(${lon},${lat}) non-finite`)
    }
  })
})

describe('iter-317 projection.forward → inverse round-trips (cylindrical)', () => {
  for (const [name, proj] of CYLINDRICAL) {
    it(`${name}: forward→inverse recovers lon/lat within the clamp band`, () => {
      for (const [lon, lat] of [
        [0, 0],
        [45, 30],
        [-90, -45],
        [120, 60],
        [179, -70],
      ] as [number, number][]) {
        const [x, y] = proj.forward(lon, lat)
        const [rlon, rlat] = proj.inverse(x, y)
        expect(rlon).toBeCloseTo(lon, 4)
        // lat clamped at the Mercator limit; within band it round-trips.
        if (Math.abs(lat) <= 85) expect(rlat).toBeCloseTo(lat, 4)
      }
    })
  }
})

// Defensive documentation: NaN/Infinity lat. The cylindrical clamp
// (Math.max/min) does NOT catch NaN — forward(lon, NaN) yields a
// NaN y. Callers (tile-select, camera) pre-clamp lat to finite, so
// this is currently a contract not a live bug. Pin the behaviour so
// a future change that starts feeding raw lat surfaces here.
describe('iter-317 projection.forward NaN-lat behaviour (documented contract)', () => {
  it('mercator.forward(lon, NaN) propagates NaN (callers must pre-clamp)', () => {
    const out = mercator.forward(0, NaN)
    expect(Number.isNaN(out[1])).toBe(true)
    // x is independent of lat → still finite.
    expect(Number.isFinite(out[0])).toBe(true)
  })
})
