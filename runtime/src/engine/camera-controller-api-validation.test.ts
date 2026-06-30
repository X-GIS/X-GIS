// ═══ CameraController public-API validation contract ═══
//
// Three input-validation bugs in the Mapbox-parity camera API, all on
// untrusted host-supplied input that previously produced a SILENTLY-wrong
// or LOCKED camera (or a thrown TypeError):
//
//   B1 setMinZoom/setMaxZoom each clamped only to [0,22] and never
//      reconciled against each other. minZoom > maxZoom makes the shared
//      clamp Math.max(min, Math.min(max, z)) collapse to `min`, pinning the
//      camera ABOVE maxZoom and locking it. (MapLibre invariant min<=max.)
//   B2 fitBounds accepted an antimeridian-crossing bbox (west > east):
//      lonSpan = Math.max(1e-9, e-w) collapsed (e-w negative) → fallback
//      zoom + centerLon = (w+e)/2 = the ANTIPODE of the intended centre.
//      setMaxBounds already rejects west>east; fitBounds now mirrors it.
//   B3 jumpTo destructured `const [lon,lat] = opts.center` with no
//      Array.isArray guard, so a non-iterable center (`{}`) threw a
//      TypeError that propagated through the easeTo/flyTo aliases. Every
//      other validator here warns-and-ignores.
//
// Harness mirrors camera-center-sync.test.ts: a real Camera wrapped in a
// minimal CameraController. No GPU/canvas needed — B1 touches only zoom,
// B2 rejects before any canvas read, B3 rejects before any camera write.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Camera } from '@xgis/engine'
import { CameraController, type CameraControllerDeps } from './camera-controller'
import { setLogSink } from './log'

/** Minimal deps. B1/B2/B3 never reach getBounds/fitBounds's canvas read
 *  (B2 rejects the antimeridian bbox first), so the canvas getters throw
 *  if anything unexpectedly calls them. */
function makeController(cam: Camera): CameraController {
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => { throw new Error('getCanvas not used in this test') },
    getCtxCanvas: () => undefined,
  }
  return new CameraController(cam, deps)
}

// Capture engine warns so B2/B3 can assert the loud-reject path fired.
let warnings: string[]
beforeEach(() => {
  warnings = []
  setLogSink((level, message) => { if (level === 'warn') warnings.push(message) })
})
afterEach(() => { setLogSink(null) })

describe('CameraController public-API validation', () => {
  describe('B1: setMinZoom / setMaxZoom reconcile (min <= max)', () => {
    it('setMinZoom(10) then setMaxZoom(5) keeps min <= max and does not lock the camera above max', () => {
      const cam = new Camera(0, 0, 8)
      const ctrl = makeController(cam)

      ctrl.setMinZoom(10)
      ctrl.setMaxZoom(5)

      // The reconciled invariant: minZoom must never exceed maxZoom.
      // (Before the fix: minZoom=10, maxZoom=5 → min > max.)
      expect(ctrl.getMinZoom()).toBeLessThanOrEqual(ctrl.getMaxZoom())

      // And the camera is not pinned ABOVE its own maxZoom. Before the fix
      // setZoom(anything) collapsed to Math.max(10, Math.min(5, z)) = 10,
      // i.e. zoom locked at 10 > maxZoom 5.
      ctrl.setZoom(7)
      expect(cam.zoom).toBeLessThanOrEqual(ctrl.getMaxZoom())
    })

    it('setMinZoom raises maxZoom-floored min; setZoom can still reach a usable zoom', () => {
      const cam = new Camera(0, 0, 3)
      const ctrl = makeController(cam)

      ctrl.setMinZoom(10)
      ctrl.setMaxZoom(5)

      // setMinZoom(10) clamped to maxZoom(22)=10; setMaxZoom(5) floored to
      // minZoom(10)=10 → both pin at 10. A subsequent setZoom is not stuck
      // above the (reconciled) ceiling.
      ctrl.setZoom(20)
      expect(cam.zoom).toBe(ctrl.getMaxZoom())
      expect(cam.zoom).toBe(ctrl.getMinZoom())
    })
  })

  describe('B2: fitBounds rejects an antimeridian-crossing bbox', () => {
    it('an antimeridian bbox (west > east) does not silently jump to the antipode (0)', () => {
      const cam = new Camera(20, 10, 6)
      const ctrl = makeController(cam)
      const before = ctrl.getCameraState()

      // west=170, east=-170 crosses the antimeridian. Intended centre ≈ ±180.
      // Before the fix lonSpan collapsed to 1e-9 → fallback zoom 4, and
      // centerLon = (170 + -170)/2 = 0 (the antipode).
      ctrl.fitBounds([[170, 30], [-170, 40]])

      const after = ctrl.getCameraState()
      // Loud reject: a warn fired AND the camera is unchanged (no silent
      // wrong jump to lon 0 / zoom 4).
      expect(warnings.some((w) => w.includes('fitBounds') && w.includes('antimeridian'))).toBe(true)
      expect(after.center[0]).toBeCloseTo(before.center[0], 6)
      expect(after.zoom).toBeCloseTo(before.zoom, 6)
    })

    it('a normal (west < east) bbox is still accepted (no false rejection)', () => {
      const cam = new Camera(0, 0, 3)
      const ctrl = makeController(cam)

      // getCtxCanvas() returns undefined → fitBounds uses the 800 CSS default,
      // never touching getCanvas. A normal bbox must NOT be rejected.
      ctrl.fitBounds([[120, 30], [130, 40]])

      expect(warnings.some((w) => w.includes('antimeridian'))).toBe(false)
      expect(ctrl.getCenter()[0]).toBeCloseTo(125, 6) // centred on the bbox
    })
  })

  describe('B3: jumpTo guards a non-array center', () => {
    it('jumpTo({ center: {} }) does NOT throw and warns instead', () => {
      const cam = new Camera(10, 20, 5)
      const ctrl = makeController(cam)
      const before = ctrl.getCameraState()

      // Non-iterable center. Before the fix `const [lon,lat] = opts.center`
      // threw `TypeError: opts.center is not iterable`.
      expect(() => ctrl.jumpTo({ center: {} as unknown as [number, number] })).not.toThrow()

      // Warns-and-ignores like every other validator; camera unchanged.
      expect(warnings.some((w) => w.includes('jumpTo') && w.includes('center'))).toBe(true)
      const after = ctrl.getCameraState()
      expect(after.center[0]).toBeCloseTo(before.center[0], 6)
      expect(after.center[1]).toBeCloseTo(before.center[1], 6)
    })

    it('the throw also propagated through the easeTo/flyTo aliases — now they are safe too', () => {
      const cam = new Camera(0, 0, 4)
      const ctrl = makeController(cam)

      expect(() => ctrl.easeTo({ center: {} as unknown as [number, number] })).not.toThrow()
      expect(() => ctrl.flyTo({ center: {} as unknown as [number, number] })).not.toThrow()
    })

    it('a valid [lon, lat] center still applies', () => {
      const cam = new Camera(0, 0, 4)
      const ctrl = makeController(cam)

      ctrl.jumpTo({ center: [33, 12] })

      expect(ctrl.getCenter()[0]).toBeCloseTo(33, 6)
      expect(ctrl.getCenter()[1]).toBeCloseTo(12, 6)
    })
  })
})
