// ═══ #2564 — the anchor's ellipsoid must be the ACTIVE body's, not Earth's ═══
//
// `tile-camera-anchor.ts` states its own invariant four lines above the bug:
//
//   > The CAMERA term is NOT Mercator-clamped: it must equal lonLatToECEF(cam)
//
// It took its radius from `activeBody()` and its eccentricity from the `EARTH`
// singleton, so the equality held on Earth and only on Earth: every other body
// got that body's radius wearing Earth's flattening. On `MOON` (a perfect
// sphere, `e2 = 0`) the Earth-`e²` kernel put the camera 1261 m out
// horizontally and 5092 m out in z at lat 30 — the same class of tile-vs-camera
// RTC disagreement as #2315, whose fix comment sits directly above it.
//
// Nothing on the default body can see this: `EARTH.sphereR === EARTH.a` and
// `EARTH.e2 === activeBody().e2` make the two expressions bit-identical there,
// which is why every render gate, parity gate and the lane-exact
// `tile-camera-anchor-authority.test.ts` stayed green. The assertion that
// DISTINGUISHES the states is one that switches the body (CLAUDE.md §12), so
// that is what this file is.
//
// Scope note — this is the OUTPUT-lane twin of the authority test, not a
// duplicate of it: that file pins the f64 math lane-for-lane against a
// recomputed reference on Earth; this one pins the cross-module equality with
// `lonLatToECEF` across bodies. Neither can catch what the other does.

import { afterEach, describe, expect, it } from 'vitest'
import {
  configureBody,
  EARTH,
  MARS_IAU2000,
  MOON,
  lonLatToECEF,
  makeBody,
  type Body,
} from '@xgis/shared'
import { clampMercLat, computeTileCameraAnchor } from './tile-camera-anchor'

// The active body is process-global (backed by `globalThis`), so a file that
// leaves it switched poisons every sibling sharing the worker — the leak #2567
// records. Restore the EARTH SINGLETON by identity, not a rebuilt equivalent.
afterEach(() => {
  configureBody(EARTH)
})

// Recombining a DSFUN pair loses at most 2⁻⁴⁸·|v| (the hi/lo residual is exact
// in f64; only the `fround` of it rounds): ≤ 2.3e-8 m at Earth radius. 1e-6 m
// is ~40× that floor and ~1e9× below the kilometre-class divergence the
// Earth-hardcoded e² produced off Earth — the tolerance cannot launder the bug.
const TOL_M = 1e-6

const BODIES: readonly Body[] = [
  EARTH,
  MOON, // f = 0 — Earth's e² is pure error here
  MARS_IAU2000, // f = 1/169.8 — a wrong e², not merely a non-zero one
  // The RADIUS half of the same defect. `makeBody` defaults `sphereR ?? a`, so
  // no shipped body separates the spherical Mercator basis from the ellipsoid's
  // semi-major axis, and the ECEF kernel reading `sphereR` is benign by
  // coincidence (#2564 "Ruled out"). Passing the override makes the two differ,
  // which is the only state that can witness the kernel binding the wrong one.
  makeBody('mars-mean-sphere-basis', 3396190, 1 / 169.8, { sphereR: 3389500 }),
]

interface AnchorCase {
  readonly label: string
  readonly west: number
  readonly south: number
  readonly camLon: number
  readonly camLat: number
}

// Latitudes where the ellipsoid term actually moves (the equator is a null case
// for e²: N·cos0 = a either way, and sin0 = 0 kills the z term), plus the #2315
// pole-ward camera, whose tile corner also exercises `clampMercLat`.
const CASES: readonly AnchorCase[] = [
  { label: 'Tokyo z14', west: 139.74609375, south: 35.68359375, camLon: 139.7671, camLat: 35.6812 },
  { label: 'lat 60', west: 126.98, south: 59.98, camLon: 127, camLat: 60 },
  { label: 'southern hemisphere', west: 18.4, south: -33.95, camLon: 18.4241, camLat: -33.9249 },
  { label: 'pole-ward camera lat 89', west: -180, south: 89.98, camLon: 0, camLat: 89 },
]

const near = (got: number, want: number, what: string): void => {
  expect(
    Math.abs(got - want),
    `${what}: got ${got}, want ${want} (Δ ${got - want} m)`,
  ).toBeLessThan(TOL_M)
}

describe('computeTileCameraAnchor: the ECEF terms follow the ACTIVE body (#2564)', () => {
  for (const body of BODIES) {
    for (const c of CASES) {
      it(`${body.name} — ${c.label}: camera + tile terms equal lonLatToECEF`, () => {
        configureBody(body)
        const a = computeTileCameraAnchor(c.west, c.south, 0, c.camLon, c.camLat)

        // (1) The invariant the source comment states: the camera term IS
        //     `lonLatToECEF(cam)` — unclamped, so it reaches the pole (#2315).
        const cam = lonLatToECEF(c.camLon, c.camLat)
        near(a.camEcefXH + a.camEcefXL, cam[0], `${body.name} cam ECEF x`)
        near(a.camEcefYH + a.camEcefYL, cam[1], `${body.name} cam ECEF y`)
        near(a.camEcefZH + a.camEcefZL, cam[2], `${body.name} cam ECEF z`)

        // (2) The TILE term is the same ellipsoid forward on the Merc-clamped
        //     corner — the point the tiler packs vertices against.
        const tile = lonLatToECEF(c.west, clampMercLat(c.south))
        near(a.tileEcefXH + a.tileEcefXL, tile[0], `${body.name} tile ECEF x`)
        near(a.tileEcefYH + a.tileEcefYL, tile[1], `${body.name} tile ECEF y`)
        near(a.tileEcefZH + a.tileEcefZL, tile[2], `${body.name} tile ECEF z`)

        // (3) …and the RTC offset the shader actually consumes is their f64
        //     difference. Asserting (1) and (2) alone would leave a kernel that
        //     packs the right absolutes and the wrong offset undetected.
        near(a.ecefXH + a.ecefXL, tile[0] - cam[0], `${body.name} RTC offset x`)
        near(a.ecefYH + a.ecefYL, tile[1] - cam[1], `${body.name} RTC offset y`)
        near(a.ecefZH + a.ecefZL, tile[2] - cam[2], `${body.name} RTC offset z`)
      })
    }
  }

  it('the body switch is what carries the information — EARTH and MOON disagree', () => {
    // Non-vacuity. If some future change made every body produce the same
    // anchor, the loop above would pass while testing nothing about the body
    // seam; this pins that its subject actually moves when the body does.
    configureBody(EARTH)
    const e = computeTileCameraAnchor(139.74609375, 35.68359375, 0, 139.7671, 35.6812)
    configureBody(MOON)
    const m = computeTileCameraAnchor(139.74609375, 35.68359375, 0, 139.7671, 35.6812)
    expect(Math.abs(e.camEcefZH - m.camEcefZH)).toBeGreaterThan(1e6)
  })
})
