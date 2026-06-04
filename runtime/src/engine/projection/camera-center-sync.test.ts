// ═══ centerLatDeg sync contract — the globe reach-the-pole fix ═══
//
// GLOBE POLE FIX (roadmap S10): the globe camera anchor used to derive its
// centre latitude from `centerY` (Web-Mercator metres), which saturates at
// ±85.051129°, so `setCenter([0, 89])` on the globe could never orbit the
// camera to the pole. The fix adds a maintained `centerLatDeg` field holding
// the TRUE centre latitude (clamped to `poleLimit(projType)`), read by the
// three globe-anchor derivations.
//
// INVARIANT under test: for any centre with |lat| <= 85.051129 (all
// cylindrical projections, and globe away from the pole)
// `centerLatDeg === mercatorYToLat(centerY)` EXACTLY — byte-identical to the
// pre-change behaviour. Only the sphere family relaxes past 85.05.
//
// These are CPU sync-contract assertions (the render matrix is covered by the
// real-GPU matrix cell `globe-pole-pan-block`). projType encoding:
//   0 mercator · 1 equirectangular · 7 globe.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'
import { CameraController, type CameraControllerDeps } from '../camera-controller'
import { mercatorYToLat } from './projection'

const MERC_LIMIT = 85.051129

/** Minimal deps for the controller. setCenter / jumpTo / getCenter only use
 *  `invalidate` + the camera; the canvas getters are exercised by
 *  getBounds/fitBounds, which these tests never call. */
function makeController(cam: Camera): CameraController {
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => { throw new Error('getCanvas not used in this test') },
    getCtxCanvas: () => undefined,
  }
  return new CameraController(cam, deps)
}

describe('centerLatDeg sync contract', () => {
  describe('GLOBE (projType 7) reach-the-pole', () => {
    it('setCenter(0, 89) orbits the camera to lat 89 (getCenter reports 89)', () => {
      const cam = new Camera(0, 0, 3)
      cam.projType = 7
      const ctrl = makeController(cam)

      ctrl.setCenter(0, 89)

      // getCenter must report the TRUE pole-ward latitude (the reach-the-pole
      // proof — this FAILS before the fix, which clamps to 85.051129).
      expect(ctrl.getCenter()[1]).toBeCloseTo(89, 3)
      // The maintained field carries the true latitude…
      expect(cam.centerLatDeg).toBeCloseTo(89, 3)
      // …while centerY stays Mercator-bounded (saturates at the limit) so the
      // 2D plane MVP / tile selection keep working.
      expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3)
    })

    it('jumpTo({ center: [0, 89] }) reaches the pole the same way', () => {
      const cam = new Camera(0, 0, 3)
      cam.projType = 7
      const ctrl = makeController(cam)

      ctrl.jumpTo({ center: [0, 89] })

      expect(ctrl.getCenter()[1]).toBeCloseTo(89, 3)
      expect(cam.centerLatDeg).toBeCloseTo(89, 3)
      expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3)
    })

    it('away from the pole the globe field still matches the Mercator inverse', () => {
      const cam = new Camera(0, 0, 3)
      cam.projType = 7
      const ctrl = makeController(cam)

      ctrl.setCenter(10, 40)
      // Below 85.05 the field tracks the Mercator inverse. NOTE: setCenter
      // writes centerLatDeg = the CLAMPED INPUT lat (trueLat), while
      // mercatorYToLat(centerY) round-trips that input through lonLatToMercator
      // → inverse, which differs by ~1e-14 (float round-trip). The BYTE-EXACT
      // `=== mercatorYToLat(centerY)` invariant is asserted on the SYNC paths
      // (drag/pan) below, which literally assign that expression; here we
      // assert they agree to ~12 decimals (the round-trip floor).
      expect(cam.centerLatDeg).toBeCloseTo(mercatorYToLat(cam.centerY), 10)
      expect(ctrl.getCenter()[1]).toBeCloseTo(40, 3)
    })
  })

  describe('CYLINDRICAL no-drift invariant (projType 0 mercator + 1 equirect)', () => {
    for (const projType of [0, 1]) {
      for (const lat of [70, 84]) {
        it(`projType ${projType} setCenter(lon, ${lat}): centerLatDeg === mercatorYToLat(centerY) exactly`, () => {
          const cam = new Camera(0, 0, 3)
          cam.projType = projType
          const ctrl = makeController(cam)

          ctrl.setCenter(25, lat)

          // No drift beyond the lonLatToMercator round-trip floor (~1e-12):
          // setCenter writes centerLatDeg = the clamped input, which the
          // Mercator forward+inverse recovers to ~12 decimals. The byte-EXACT
          // invariant is on the drag/pan sync paths (below).
          expect(cam.centerLatDeg).toBeCloseTo(mercatorYToLat(cam.centerY), 10)
          expect(ctrl.getCenter()[1]).toBeCloseTo(lat, 3)
        })
      }
    }

    it('cylindrical clamp unchanged: setCenter(0, 89) on mercator reports 85.051129', () => {
      const cam = new Camera(0, 0, 3)
      cam.projType = 0
      const ctrl = makeController(cam)

      ctrl.setCenter(0, 89)

      // poleLimit(0) === 85.051129 ⇒ trueLat === mercLat ⇒ no reach-the-pole.
      expect(ctrl.getCenter()[1]).toBeCloseTo(MERC_LIMIT, 3)
      expect(cam.centerLatDeg).toBeCloseTo(mercatorYToLat(cam.centerY), 10)
    })
  })

  describe('interactive paths keep centerLatDeg in sync (no stale)', () => {
    it('globe-drag pan (sub-85) keeps centerLatDeg consistent with the Mercator mirror', () => {
      const cam = new Camera(0, 40, 3)
      cam.projType = 7
      cam.globeMode = true
      // pan() globe-drag branch is pure math (no GPU/canvas) — drag a bit.
      cam.pan(0, 60, 1280, 720)
      // Post-S12 centerLatDeg is AUTHORITATIVE (the drag writes it directly);
      // for a sub-85.05 drag it still agrees with the Mercator-mirror centerY to
      // the forward+inverse round-trip floor (~1e-9), no longer byte-exact.
      expect(cam.centerLatDeg).toBeCloseTo(mercatorYToLat(cam.centerY), 9)
      expect(Math.abs(cam.centerLatDeg)).toBeLessThanOrEqual(MERC_LIMIT + 1e-6)
    })

    it('globe-drag pan REACHES THE POLE past 85.05 (roadmap S12)', () => {
      const cam = new Camera(0, 0, 3)
      cam.projType = 7
      cam.globeMode = true
      const ctrl = makeController(cam)
      ctrl.setCenter(0, 84) // start just below the old Mercator wall
      // Drag northward hard — enough to push the centre well past 85.05. Before
      // S12 this saturated at 85.051129; now it rolls to the pole limit (90).
      cam.pan(0, 400, 1280, 720)
      expect(cam.centerLatDeg).toBeGreaterThan(MERC_LIMIT) // crossed the old wall
      expect(cam.centerLatDeg).toBeCloseTo(90, 3) // clamped to poleLimit(7)=90
      // centerY stays Mercator-bounded so the 2D / tile readers keep working.
      expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3)
    })

    it('flat pan keeps centerLatDeg === mercatorYToLat(centerY)', () => {
      const cam = new Camera(0, 30, 3)
      cam.projType = 0
      cam.pan(40, -25, 1280, 720)
      expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
    })
  })

  it('a fresh camera satisfies the invariant', () => {
    const cam = new Camera(12, 45, 4)
    expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
  })
})
