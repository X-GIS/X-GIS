import { describe, expect, it } from 'vitest'

import { horizonBoundedFar } from './view-matrix'
import { Camera } from './camera'

// ═══════════════════════════════════════════════════════════════════
// Far plane bounded at the simulated horizon (#1427).
// ═══════════════════════════════════════════════════════════════════
//
// A flat Mercator plane has no horizon — its vanishing line is at infinity —
// so the old formula
//
//   far = altitude / cos(min(pitch + halfFov, 90deg - 0.01)) * 1.5
//
// had no finite answer to give and degenerated: past pitch ~71.5 the clamp
// pins cos() at 0.01 and `far` is a flat 150x altitude regardless of pitch.
// Every tile selector derives its reach from this number, which is why a
// street-level view was enumerating planet-scale tiles.
//
// The replacement is MapLibre 5.24's bound (`_calculateNearFarZIfNeeded`),
// pinned below by transcribing MapLibre's arithmetic independently and
// asserting the two agree. That is the point: the value must be MapLibre's,
// not merely "smaller than before", because X-GIS is benchmarked against it.
//
// NOTE ON UNITS. `altitude` in this engine is the ORBIT distance — the camera
// sits that far from the map centre along the view axis at every pitch, so
// `mvp[15] === altitude` regardless of tilt and it maps directly onto
// MapLibre's `cameraToCenterDistance` with NO cos(pitch) correction. The
// camera's HEIGHT above the plane is `altitude * cos(pitch)`, a different
// number; conflating the two inflates the bound by 1/cos(pitch) (3.3x at the
// reported camera) and this file's MapLibre-parity case is what catches it.
//
// MEASURED far / altitude at Camera.FOV (36.87 deg), alongside the deepest
// ground the frustum can actually see (axis depth, i.e. clip w — NOT the ray
// distance the legacy formula confused it with):
//
//   pitch   legacy      new   visible-ground depth   covers it?
//       0    1.581    1.010                  1.000   yes
//      15    1.797    1.109                  1.098   yes
//      30    2.261    1.251                  1.238   yes
//      45    3.354    1.515                  1.500   yes
//      60    7.482    2.390                  2.366   yes
//      65   13.120    3.542                  3.507   yes
//      70   54.921    6.733                 11.880   no   <- cut begins
//    72.4  150.003    6.733          288216116.68   no   <- reported camera
//      80  150.003    6.733          171010047.07   no
//      85  150.003    6.706           86824076.34   no
//
// Past ~66 deg `pitch + halfFov` approaches 90, so the frustum's top edge
// grazes the plane and the ground it "sees" runs to hundreds of millions of
// orbit distances. NOTHING covers that; the legacy 150x did not either. The
// change is WHERE the cut falls — 22x nearer at the reported camera, at the
// simulated horizon — so the band above it draws background, the same as
// MapLibre, rather than smearing the rest of the world into a few pixels of
// horizon strip. That is a visual change and is verified by render diff, not
// by this file.

const FOV_RAD = (Camera.FOV * Math.PI) / 180
const HALF_FOV = FOV_RAD / 2
const DEG = Math.PI / 180

/** MapLibre 5.24 `_calculateNearFarZIfNeeded`, transcribed independently from
 *  `maplibre-gl-dev.js` for elevation 0 / roll 0 / centerOffset 0 — the only
 *  configuration this engine's flat path has. Expressed as a multiple of
 *  `cameraToCenterDistance` so it can be checked without a Transform. */
function maplibreFarOverCentreDistance(pitchDeg: number, fovRad: number): number {
  const maxHorizonAngleDeg = 89.25
  const limitedPitch = Math.min(pitchDeg, maxHorizonAngleDeg) * DEG
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  const groundAngle = Math.PI / 2 + limitedPitch
  const fovAboveCenter = fovRad * 0.5
  const topHalfSurfaceDistance =
    Math.sin(fovAboveCenter) /
    Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01))

  // getMercatorHorizon(t) / cameraToCenterDistance
  const horizon = Math.min(
    Math.tan((90 - pitchDeg) * DEG) * 0.85,
    Math.tan((maxHorizonAngleDeg - pitchDeg) * DEG),
  )
  const horizonAngle = Math.atan(horizon)
  const minFovCenterToHorizon = (90 - maxHorizonAngleDeg) * DEG
  const fovCenterToHorizon =
    horizonAngle > minFovCenterToHorizon ? horizonAngle : minFovCenterToHorizon
  const topHalfSurfaceDistanceHorizon =
    Math.sin(fovCenterToHorizon) /
    Math.sin(clamp(Math.PI - groundAngle - fovCenterToHorizon, 0.01, Math.PI - 0.01))

  const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon)
  return (Math.cos(Math.PI / 2 - limitedPitch) * topHalfMinDistance + 1) * 1.01
}

/** The formula this replaces, kept so the "before" column is measured rather
 *  than remembered. */
function legacyFar(altitude: number, pitchRad: number, halfFovRad: number): number {
  const maxViewAngle = Math.min(pitchRad + halfFovRad, Math.PI / 2 - 0.01)
  return (altitude / Math.cos(maxViewAngle)) * 1.5
}

/** Clip-space `w` — view-AXIS depth, which is what a far plane compares
 *  against — of the deepest ground point the frustum's top edge reaches.
 *  With orbit distance A the camera's height is `A*cos(pitch)`, so a ground
 *  point at nadir angle `phi` sits `A*cos(pitch)/cos(phi)` along the ray and
 *  `A*cos(pitch)*cos(phi - pitch)/cos(phi)` along the view axis. The legacy
 *  formula used a RAY distance as a far plane, which is part of why it was so
 *  loose. */
function visibleGroundAxisDepth(orbitDist: number, pitchRad: number, halfFovRad: number): number {
  const phi = Math.min(pitchRad + halfFovRad, Math.PI / 2 - 1e-9)
  return (orbitDist * Math.cos(pitchRad) * Math.cos(phi - pitchRad)) / Math.cos(phi)
}

/** The pitch band the engine is documented to operate in (`camera.ts:67` —
 *  "0 = top-down, 85 = nearly horizontal"). */
const PITCHES = [0, 15, 30, 45, 60, 65, 70, 72.4, 75, 80, 85]
/** Below this the frustum's top edge still meets the plane at a finite,
 *  coverable depth, so the bound must not clip any visible ground. */
const FULLY_COVERED_PITCHES = [0, 15, 30, 45, 60, 65]

const ALT = 2523 // metres — the #1427 camera's altitude

describe('horizonBoundedFar — MapLibre parity (#1427)', () => {
  it('matches MapLibre 5.24 far-plane arithmetic at every pitch', () => {
    for (const pitchDeg of [...PITCHES, 89, 89.25, 89.5]) {
      // ALT IS the centre distance — see the units note in the header.
      const expected = maplibreFarOverCentreDistance(pitchDeg, FOV_RAD) * ALT
      const actual = horizonBoundedFar(ALT, pitchDeg * DEG, HALF_FOV)
      // Same closed form, so agreement is to floating-point noise, not a
      // tolerance band. 1e-9 relative would pass; 1e-6 leaves room for a
      // different association order without admitting a real divergence.
      expect(Math.abs(actual - expected) / expected, `pitch ${pitchDeg}`).toBeLessThan(1e-6)
    }
  })

  it('scales linearly with altitude — it is a pure ratio of it', () => {
    const at1 = horizonBoundedFar(1000, 72.4 * DEG, HALF_FOV)
    const at7 = horizonBoundedFar(7000, 72.4 * DEG, HALF_FOV)
    expect(at7 / at1).toBeCloseTo(7, 9)
  })

  it('tightens the bound across the whole operating pitch range', () => {
    // Direction guarantee. A looser far would mean MORE ground enumerated and
    // drawn, which is the opposite of the fix.
    for (const pitchDeg of PITCHES) {
      const pitchRad = pitchDeg * DEG
      expect(horizonBoundedFar(ALT, pitchRad, HALF_FOV), `pitch ${pitchDeg}`).toBeLessThan(
        legacyFar(ALT, pitchRad, HALF_FOV),
      )
    }
  })

  it('never clips ground the frustum can actually reach, below 60 degrees', () => {
    // At pitch 0 the plane is perpendicular to the view axis, so every ground
    // point sits at axis depth == altitude; the bound must clear it or the map
    // vanishes. The same must hold wherever the top edge still meets the plane
    // at a coverable depth.
    for (const pitchDeg of FULLY_COVERED_PITCHES) {
      const pitchRad = pitchDeg * DEG
      expect(
        horizonBoundedFar(ALT, pitchRad, HALF_FOV),
        `pitch ${pitchDeg} must still cover its visible ground`,
      ).toBeGreaterThanOrEqual(visibleGroundAxisDepth(ALT, pitchRad, HALF_FOV))
    }
  })

  it('kills the degenerate high-pitch blow-up', () => {
    // The defect: past ~71.5 deg the legacy clamp pinned far at 150x altitude
    // and stopped responding to pitch at all.
    expect(legacyFar(ALT, 72.4 * DEG, HALF_FOV) / ALT).toBeCloseTo(150, 1)
    expect(legacyFar(ALT, 85 * DEG, HALF_FOV) / ALT).toBeCloseTo(150, 1)
    // The replacement saturates at MapLibre's ~6.73x — 22x tighter at the
    // reported camera — instead of at 150x.
    const at72 = horizonBoundedFar(ALT, 72.4 * DEG, HALF_FOV) / ALT
    expect(at72).toBeCloseTo(6.733, 2)
    expect(
      legacyFar(ALT, 72.4 * DEG, HALF_FOV) / horizonBoundedFar(ALT, 72.4 * DEG, HALF_FOV),
    ).toBeGreaterThan(20)
  })

  it('climbs to its ceiling instead of jumping to it', () => {
    // The old formula reached its ceiling the instant pitch + halfFov crossed
    // the clamp: 7.5x at 60 -> 150x at 72.4, a 20x step across 12 degrees.
    // This one approaches ~6.73x smoothly, so no pitch nudge can multiply the
    // world the selectors are asked to cover.
    const ratios = PITCHES.map((p) => horizonBoundedFar(ALT, p * DEG, HALF_FOV) / ALT)
    for (let i = 1; i < ratios.length; i++) {
      expect(
        ratios[i]! / ratios[i - 1]!,
        `pitch ${PITCHES[i - 1]} -> ${PITCHES[i]} must not be a cliff`,
      ).toBeLessThan(2)
    }
    // Saturation: the top of the range sits within 1% of its own ceiling.
    const tail = ratios.slice(-4)
    expect(Math.max(...tail) / Math.min(...tail)).toBeLessThan(1.01)
    // Witness that the legacy formula DID step harder, so the bound above is
    // testing something the old code would have failed. Compared against the
    // new worst step rather than an absolute number, so the claim survives a
    // change to which pitches this list samples.
    const legacyRatios = PITCHES.map((p) => legacyFar(ALT, p * DEG, HALF_FOV) / ALT)
    const worstStep = (rs: number[]) => Math.max(...rs.slice(1).map((r, i) => r / rs[i]!))
    expect(worstStep(legacyRatios)).toBeGreaterThan(worstStep(ratios) * 2)
  })
})

describe('Camera.getFrameView — the bound reaches the production matrix', () => {
  it('reports the horizon-bounded far at the reported #1427 camera', () => {
    const cam = new Camera(-0.11813, 51.50466, 16)
    cam.bearing = 60
    cam.pitch = 72.4
    cam.syncCenterLat()
    const { far } = cam.getFrameView(1280, 800, 1)

    // Altitude the builder derives for this viewport, recomputed here so the
    // assertion is against the formula rather than against a copied constant.
    const mpp = 40075016.685578488 / 512 / 2 ** 16
    const altitude = (800 * mpp) / 2 / Math.tan(HALF_FOV)
    expect(far).toBeCloseTo(horizonBoundedFar(altitude, 72.4 * DEG, HALF_FOV), 6)
    // And it is the tighter number, not the legacy 150x one.
    expect(far).toBeLessThan(legacyFar(altitude, 72.4 * DEG, HALF_FOV) * 0.05)
  })
})

describe('horizonBoundedFar — anchored to a LIVE MapLibre transform', () => {
  it('reproduces the farZ maplibre-gl 5.24 actually computed at pitch 60', () => {
    // Read out of the running library rather than re-derived: the compare
    // harness at #16.00/51.50466/-0.11813/60.0/72.4, viewport 1280x800, pane
    // 640x704. MapLibre CLAMPS that camera to its own maxPitch of 60, and its
    // transform then reported
    //
    //   cameraToCenterDistance = 1056        (px, == 0.5 * 704 / tan(fov/2))
    //   farZ                   = 2523.5081   (px)
    //
    // A transcription of MapLibre's arithmetic can drift from MapLibre; this
    // number cannot. (It is also why the render diff for this change is taken
    // at pitch 60 — past that the two engines are not holding the same camera,
    // so an X-GIS-vs-MapLibre pixel comparison measures the clamp, not the
    // far plane.)
    const D = 1056
    const observedFarZ = 2523.5080546603285
    expect(horizonBoundedFar(D, 60 * DEG, HALF_FOV)).toBeCloseTo(observedFarZ, 3)
    // Stated as a ratio too, since that is the pitch-only quantity the header
    // table tabulates.
    expect(horizonBoundedFar(1, 60 * DEG, HALF_FOV)).toBeCloseTo(observedFarZ / D, 6)
  })
})
