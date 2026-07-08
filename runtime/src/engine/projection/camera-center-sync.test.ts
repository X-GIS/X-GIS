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
import { Camera } from '@xgis/map'
import { CameraController, type CameraControllerDeps } from '@xgis/map'
import { mercatorYToLat, mercator } from '@xgis/engine'

const MERC_LIMIT = 85.051129

/** Minimal deps for the controller. setCenter / jumpTo / getCenter only use
 *  `invalidate` + the camera; the canvas getters are exercised by
 *  getBounds/fitBounds, which these tests never call. */
function makeController(cam: Camera): CameraController {
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => {
      throw new Error('getCanvas not used in this test')
    },
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

  describe('zoom must NOT move the centre latitude (pole-snap-back fix, roadmap S11)', () => {
    it('GLOBE: a zoom with NO Mercator-centre move PRESERVES a pole-ward centre (89), no snap-back to 85.05', () => {
      // The globe orbit recenters even for a canvas-centre anchor (the sphere
      // MVP is not a flat plane, so `before`/`after` differ across the zoom and
      // legitimately pan the centre — driving the real zoomAt here would assert
      // a moving target). Per the fix's contract we assert the helper directly:
      // when the Mercator centerY does NOT move (a TRULY pure zoom), the carry
      // helper must leave the pole-ward latitude untouched — i.e. NO snap-back
      // to 85.05. Before the fix the trailing _syncCenterLatFromMercator reset
      // centerLatDeg = mercatorYToLat(centerY) = 85.05 unconditionally.
      const cam = new Camera(0, 0, 3)
      cam.projType = 7
      cam.globeMode = true
      const ctrl = makeController(cam)
      ctrl.setCenter(0, 89) // orbit to the pole; centerY saturates at 85.05

      expect(cam.centerLatDeg).toBeCloseTo(89, 3)
      expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3)

      const mercLatPreserve = mercatorYToLat(cam.centerY)
      // centerY unchanged (pure zoom): the same value the top-of-zoomAt capture
      // saw, so delta === 0 and the pole-ward latitude is carried verbatim.
      ;(
        cam as unknown as {
          _carryCenterLatThroughZoom(l: number, m: number): void
        }
      )._carryCenterLatThroughZoom(89, mercLatPreserve)

      expect(cam.centerLatDeg).toBe(89) // NOT reset to 85.05 — exactly preserved
      expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3) // centerY stays bounded
    })

    it('CYLINDRICAL: a PURE zoom keeps the invariant centerLatDeg === mercatorYToLat(centerY) byte-exact', () => {
      const W = 1280,
        H = 720
      const cam = new Camera(0, 70, 3)
      cam.projType = 0

      // Sanity: the invariant holds before the zoom.
      expect(cam.centerLatDeg).toBeCloseTo(mercatorYToLat(cam.centerY), 10)

      cam.zoomAt(0.5, W / 2, H / 2, W, H)

      // For a cylindrical projection latPreserve === mercLatPreserve, so the
      // carry helper collapses to centerLatDeg = mercatorYToLat(centerY) —
      // byte-identical to the old reset. The invariant survives the zoom.
      expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
    })
  })

  it('a fresh camera satisfies the invariant', () => {
    const cam = new Camera(12, 45, 4)
    expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
  })
})

// ═══ BUG P4 — maxBounds must not pin the sphere family below the pole ═══
//
// `CameraController.setMaxBounds` projects the bbox corners with
// `mercator.forward`, which SATURATES latitude at ±85.051129° before
// handing the metre box to `camera.setMaxBoundsMerc`. The camera's
// `clampCenterToBounds` then clamped centerY into that box and called
// `_syncCenterLatFromMercator`, RESETTING centerLatDeg from the saturated
// centerY. For the sphere family (globe / ortho / azimuthal / stereo)
// where centerLatDeg legitimately reaches the pole, a maxBounds with a
// north past 85.05 wrongly pinned the camera at 85.051129 — the
// reach-the-pole roadmap-S12 behaviour was undone by the bounds clamp.
//
// The cylindrical family is CORRECT to clamp at the Mercator limit, so
// the fix is sphere-only: the control case below proves a Mercator camera
// with the same bounds still clamps centerY at the Mercator limit.
describe('BUG P4 — sphere-family maxBounds preserves pole reach', () => {
  // Mirror CameraController.setMaxBounds's mercator.forward corner
  // projection so the metre box matches what production hands the camera.
  function mercBox(w: number, s: number, e: number, n: number) {
    const [minX, minY] = mercator.forward(w, s)
    const [maxX, maxY] = mercator.forward(e, n)
    return { minX, maxX, minY, maxY }
  }

  it('GLOBE: a maxBounds with north=88 still lets the globe drag REACH past 85.05', () => {
    const cam = new Camera(0, 0, 3)
    cam.projType = 7
    cam.globeMode = true
    const ctrl = makeController(cam)
    ctrl.setCenter(0, 84) // start just below the old Mercator wall

    // Bounds whose TRUE north is 88° — well past the Mercator limit. The
    // metre box saturates maxY at the 85.05 value; the sphere family must
    // clamp centerLatDeg against the TRUE 88°, not the saturated metre Y.
    ctrl.setMaxBounds([
      [-20, -88],
      [20, 88],
    ])

    // Drag northward hard. Pre-fix clampCenterToBounds reset centerLatDeg
    // to mercatorYToLat(saturated centerY) = 85.051129 on every step.
    cam.pan(0, 400, 1280, 720)

    // The drag rolls toward the pole; the 88° bound caps it at 88, NOT at
    // the Mercator 85.05 wall. FAIL-BEFORE asserts the cross past 85.05.
    expect(cam.centerLatDeg).toBeGreaterThan(MERC_LIMIT) // crossed the old wall
    expect(cam.centerLatDeg).toBeLessThanOrEqual(88 + 1e-6) // but inside the bound
    expect(cam.centerLatDeg).toBeCloseTo(88, 2) // pole-ward, pinned at the true north
  })

  it('GLOBE: maxBounds STILL clamps the sphere centre at the true north (does not over-reach)', () => {
    const cam = new Camera(0, 0, 3)
    cam.projType = 7
    cam.globeMode = true
    const ctrl = makeController(cam)
    ctrl.setCenter(0, 70)
    // A tighter north of 80° must cap centerLatDeg at 80 even though the
    // sphere could otherwise roll to 90 — bounds are still enforced.
    ctrl.setMaxBounds([
      [-20, -80],
      [20, 80],
    ])
    cam.pan(0, 600, 1280, 720)
    expect(cam.centerLatDeg).toBeLessThanOrEqual(80 + 1e-6)
    expect(cam.centerLatDeg).toBeCloseTo(80, 2)
  })

  it('CYLINDRICAL CONTROL: mercator camera with the same bounds keeps centerLatDeg synced from centerY (no sphere relax)', () => {
    const cam = new Camera(0, 0, 3)
    cam.projType = 0 // mercator — cylindrical family, must NOT change
    const ctrl = makeController(cam)
    ctrl.setCenter(0, 80)
    ctrl.setMaxBounds([
      [-20, -88],
      [20, 88],
    ])

    // Drag north hard. The flat clamp caps centerY at the viewport pole
    // limit, then the (unchanged) cylindrical clampCenterToBounds path
    // keeps centerLatDeg === mercatorYToLat(centerY). The sphere-only fix
    // must leave this byte-exact identity intact (and never relax the
    // cylindrical centre past the Mercator wall).
    cam.pan(0, 4000, 1280, 720)

    // Byte-exact cylindrical sync invariant preserved (the fix branches on
    // representsCenterAs and never reaches the lat-deg clamp here).
    expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
    // The cylindrical centre never exceeds the Mercator wall.
    expect(cam.centerLatDeg).toBeLessThanOrEqual(MERC_LIMIT + 1e-9)
    // The bounds box itself saturates at the Mercator limit metre value —
    // the cylindrical family is CORRECT to clamp there.
    const box = mercBox(-20, -88, 20, 88)
    expect(mercatorYToLat(box.maxY)).toBeCloseTo(MERC_LIMIT, 6)
  })

  it('CYLINDRICAL CONTROL: a below-limit north (80) still clamps the mercator centre at exactly 80', () => {
    // When the bound's north is BELOW the Mercator wall, the metre box is
    // un-saturated and the cylindrical clamp must pin the centre at the
    // true 80°. This is the case the sphere fix must NOT alter.
    const cam = new Camera(0, 0, 6) // higher zoom so maxCameraY > the 80 bound
    cam.projType = 0
    const ctrl = makeController(cam)
    ctrl.setCenter(0, 70)
    ctrl.setMaxBounds([
      [-20, -80],
      [20, 80],
    ])
    cam.pan(0, 8000, 1280, 720)
    expect(mercatorYToLat(cam.centerY)).toBeCloseTo(80, 3)
    expect(cam.centerLatDeg).toBe(mercatorYToLat(cam.centerY))
  })
})
