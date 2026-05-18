// Mapbox-API parity setters (iter 420-421): setCenter / setZoom /
// setBearing / setPitch / jumpTo / getCamera. Each validates input
// (finite + range clamp) before writing camera state. Invalid input
// warns + drops without disturbing the camera.

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { XGISMap } from './map'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface Internals {
  camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number; minZoom: number; maxZoom: number }
  setCenter(lon: number, lat: number): void
  setZoom(zoom: number): void
  setBearing(bearing: number): void
  setPitch(pitch: number): void
  jumpTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void
  getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number }
  getCenter(): [number, number]
  getZoom(): number
  getBearing(): number
  getPitch(): number
  setMinZoom(z: number): void
  setMaxZoom(z: number): void
  getMinZoom(): number
  getMaxZoom(): number
  zoomIn(): void
  zoomOut(): void
  panBy(offset: [number, number]): void
  setMaxBounds(bounds: [[number, number], [number, number]] | null): void
  getMaxBounds(): [[number, number], [number, number]] | null
  easeTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): void
  flyTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): void
  resize(): void
  loaded(): boolean
}

describe('XGISMap Mapbox-API camera setters', () => {
  let map: Internals
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    map = new XGISMap(mockCanvas()) as unknown as Internals
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  describe('setCenter', () => {
    it('writes valid lon/lat as Mercator meters', () => {
      map.setCenter(0, 0)
      expect(map.camera.centerX).toBeCloseTo(0, 4)
      expect(map.camera.centerY).toBeCloseTo(0, 4)
    })

    it('clamps lat past MERCATOR_LAT_LIMIT before projection', () => {
      map.setCenter(0, 89.5)
      // Lat 89.5° gets clamped to 85.0511..., y stays finite
      expect(Number.isFinite(map.camera.centerY)).toBe(true)
      expect(map.camera.centerY).toBeLessThan(2.1e7)
    })

    it('rejects non-finite without changing camera state', () => {
      map.camera.centerX = 42
      map.setCenter(NaN, 0)
      expect(map.camera.centerX).toBe(42)
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('setZoom', () => {
    it('clamps to [0, 22]', () => {
      map.setZoom(-5)
      expect(map.camera.zoom).toBe(0)
      map.setZoom(99)
      expect(map.camera.zoom).toBe(22)
      map.setZoom(10.5)
      expect(map.camera.zoom).toBe(10.5)
    })

    it('rejects non-finite', () => {
      map.camera.zoom = 5
      map.setZoom(NaN)
      expect(map.camera.zoom).toBe(5)
    })
  })

  describe('setBearing', () => {
    it('wraps to [0, 360)', () => {
      map.setBearing(370)
      expect(map.camera.bearing).toBe(10)
      map.setBearing(-90)
      expect(map.camera.bearing).toBe(270)
      map.setBearing(0)
      expect(map.camera.bearing).toBe(0)
    })

    it('rejects non-finite', () => {
      map.camera.bearing = 45
      map.setBearing(Infinity)
      expect(map.camera.bearing).toBe(45)
    })
  })

  describe('setPitch', () => {
    it('clamps to [0, 85]', () => {
      map.setPitch(-10)
      expect(map.camera.pitch).toBe(0)
      map.setPitch(90)
      expect(map.camera.pitch).toBe(85)
      map.setPitch(45)
      expect(map.camera.pitch).toBe(45)
    })
  })

  describe('jumpTo', () => {
    it('applies all four fields in one call', () => {
      map.jumpTo({ center: [127, 37], zoom: 10, bearing: 45, pitch: 30 })
      expect(map.camera.zoom).toBe(10)
      expect(map.camera.bearing).toBe(45)
      expect(map.camera.pitch).toBe(30)
    })

    it('partial-success: invalid pitch doesn\'t block valid bearing', () => {
      map.camera.pitch = 20
      map.jumpTo({ bearing: 90, pitch: NaN })
      expect(map.camera.bearing).toBe(90)
      expect(map.camera.pitch).toBe(20)
    })

    it('omitted fields leave camera state untouched', () => {
      map.camera.zoom = 5
      map.camera.pitch = 30
      map.jumpTo({ bearing: 90 })
      expect(map.camera.zoom).toBe(5)
      expect(map.camera.pitch).toBe(30)
      expect(map.camera.bearing).toBe(90)
    })
  })

  describe('getCameraState', () => {
    it('round-trips through jumpTo', () => {
      map.jumpTo({ center: [127.5, 37.5], zoom: 12, bearing: 60, pitch: 40 })
      const state = map.getCameraState()
      expect(state.center[0]).toBeCloseTo(127.5, 5)
      expect(state.center[1]).toBeCloseTo(37.5, 5)
      expect(state.zoom).toBe(12)
      expect(state.bearing).toBe(60)
      expect(state.pitch).toBe(40)
    })
  })

  describe('per-axis getters', () => {
    it('getCenter / getZoom / getBearing / getPitch match camera state', () => {
      map.jumpTo({ center: [10, 20], zoom: 5, bearing: 30, pitch: 25 })
      const center = map.getCenter()
      expect(center[0]).toBeCloseTo(10, 5)
      expect(center[1]).toBeCloseTo(20, 5)
      expect(map.getZoom()).toBe(5)
      expect(map.getBearing()).toBe(30)
      expect(map.getPitch()).toBe(25)
    })
  })

  describe('setMinZoom / setMaxZoom', () => {
    it('setZoom clamps to active bounds', () => {
      map.setMinZoom(8)
      map.setMaxZoom(15)
      map.setZoom(5)
      expect(map.camera.zoom).toBe(8)
      map.setZoom(20)
      expect(map.camera.zoom).toBe(15)
      map.setZoom(12)
      expect(map.camera.zoom).toBe(12)
    })

    it('setMinZoom auto-bumps current zoom if it falls below new floor', () => {
      map.setZoom(5)
      map.setMinZoom(10)
      expect(map.camera.zoom).toBe(10)
    })

    it('setMaxZoom auto-trims current zoom if it sits above new ceiling', () => {
      map.setZoom(18)
      map.setMaxZoom(12)
      expect(map.camera.zoom).toBe(12)
    })

    it('bounds clamp themselves to [0, 22]', () => {
      map.setMinZoom(-5)
      expect(map.getMinZoom()).toBe(0)
      map.setMaxZoom(50)
      expect(map.getMaxZoom()).toBe(22)
    })

    it('jumpTo zoom honors bounds', () => {
      map.setMinZoom(5)
      map.setMaxZoom(10)
      map.jumpTo({ zoom: 100 })
      expect(map.camera.zoom).toBe(10)
      map.jumpTo({ zoom: 0 })
      expect(map.camera.zoom).toBe(5)
    })

    it('non-finite input rejected', () => {
      map.setMinZoom(3)
      map.setMinZoom(NaN)
      expect(map.getMinZoom()).toBe(3)
    })
  })

  describe('zoomIn / zoomOut', () => {
    it('zoomIn increments by 1', () => {
      map.setZoom(5)
      map.zoomIn()
      expect(map.getZoom()).toBe(6)
    })

    it('zoomOut decrements by 1', () => {
      map.setZoom(5)
      map.zoomOut()
      expect(map.getZoom()).toBe(4)
    })

    it('zoomIn clamps to maxZoom', () => {
      map.setMaxZoom(10)
      map.setZoom(10)
      map.zoomIn()
      expect(map.getZoom()).toBe(10)
    })

    it('zoomOut clamps to minZoom', () => {
      map.setMinZoom(2)
      map.setZoom(2)
      map.zoomOut()
      expect(map.getZoom()).toBe(2)
    })
  })

  describe('panBy', () => {
    it('positive dx moves camera east (with bearing=0)', () => {
      map.setCenter(0, 0)
      const startX = map.camera.centerX
      map.panBy([100, 0])
      expect(map.camera.centerX).toBeGreaterThan(startX)
    })

    it('positive dy moves camera south (with bearing=0)', () => {
      map.setCenter(0, 0)
      const startY = map.camera.centerY
      map.panBy([0, 100])
      // Screen-y down = Mercator-y down (negative direction)
      expect(map.camera.centerY).toBeLessThan(startY)
    })

    it('rejects non-finite without changing camera state', () => {
      map.setCenter(0, 0)
      const startX = map.camera.centerX
      map.panBy([NaN, 0])
      expect(map.camera.centerX).toBe(startX)
    })

    it('zero offset is a no-op', () => {
      map.setCenter(127, 37)
      const startX = map.camera.centerX
      const startY = map.camera.centerY
      map.panBy([0, 0])
      expect(map.camera.centerX).toBe(startX)
      expect(map.camera.centerY).toBe(startY)
    })
  })

  describe('setMaxBounds', () => {
    it('clamps setCenter to bbox', () => {
      // Korea bbox: roughly [125, 33] to [131, 39]
      map.setMaxBounds([[125, 33], [131, 39]])
      map.setCenter(0, 0) // outside bbox
      const state = map.getCameraState()
      expect(state.center[0]).toBeGreaterThanOrEqual(125)
      expect(state.center[0]).toBeLessThanOrEqual(131)
      expect(state.center[1]).toBeGreaterThanOrEqual(33)
      expect(state.center[1]).toBeLessThanOrEqual(39)
    })

    it('clamps jumpTo center to bbox', () => {
      map.setMaxBounds([[125, 33], [131, 39]])
      map.jumpTo({ center: [180, 80], zoom: 5 })
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(131)
      expect(state.center[1]).toBeLessThanOrEqual(39)
    })

    it('null clears bounds', () => {
      map.setMaxBounds([[0, 0], [10, 10]])
      map.setMaxBounds(null)
      expect(map.getMaxBounds()).toBeNull()
      map.setCenter(180, 80) // should not be clamped
      const state = map.getCameraState()
      // Bounds cleared — center should reach roughly 180/80 (with lat
      // clamped to MERCATOR_LAT_LIMIT)
      expect(state.center[0]).toBeCloseTo(180, 0)
    })

    it('rejects malformed bbox (south > north)', () => {
      map.setMaxBounds([[0, 50], [10, 10]]) // south=50 > north=10
      expect(map.getMaxBounds()).toBeNull()
    })

    it('rejects out-of-range lat', () => {
      map.setMaxBounds([[0, -95], [10, 10]])
      expect(map.getMaxBounds()).toBeNull()
      map.setMaxBounds([[0, 0], [10, 100]])
      expect(map.getMaxBounds()).toBeNull()
    })

    it('immediately clamps current center when bounds shrink', () => {
      map.setCenter(180, 0)
      map.setMaxBounds([[0, -10], [20, 10]]) // current center 180 is outside
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(20)
    })

    it('getMaxBounds returns the active bbox', () => {
      map.setMaxBounds([[1, 2], [3, 4]])
      expect(map.getMaxBounds()).toEqual([[1, 2], [3, 4]])
    })

    it('panBy honors bounds (iter 435)', () => {
      // Tight bbox around Korea + small zoom so panBy resolves to a
      // measurable lon delta.
      map.setMaxBounds([[125, 33], [131, 39]])
      map.setZoom(0)
      map.setCenter(128, 36) // inside bbox
      // Pan east aggressively (1000 px); at zoom=0 with DPR=1 this is a
      // huge lon delta that would escape the bbox without the clamp.
      map.panBy([10000, 0])
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(131)
    })
  })

  describe('easeTo / flyTo (iter 437)', () => {
    it('easeTo applies center/zoom/bearing/pitch (alias of jumpTo)', () => {
      map.easeTo({ center: [10, 20], zoom: 5, bearing: 30, pitch: 25, duration: 1000 })
      expect(map.getCameraState().zoom).toBe(5)
      expect(map.getCameraState().bearing).toBe(30)
      expect(map.getCameraState().pitch).toBe(25)
    })

    it('flyTo applies center/zoom/bearing/pitch (alias of jumpTo)', () => {
      map.flyTo({ center: [50, 30], zoom: 8, bearing: 90, pitch: 45, duration: 2000, speed: 1.2 })
      expect(map.getCameraState().zoom).toBe(8)
      expect(map.getCameraState().bearing).toBe(90)
      expect(map.getCameraState().pitch).toBe(45)
    })

    it('easeTo with partial opts still applies what is given', () => {
      map.setBearing(0)
      map.setPitch(0)
      map.easeTo({ bearing: 60 })
      expect(map.getBearing()).toBe(60)
      expect(map.getPitch()).toBe(0) // untouched
    })
  })

  describe('resize (iter 438)', () => {
    it('is idempotent — no throw, no state change', () => {
      map.setZoom(10)
      map.setBearing(45)
      map.resize()
      expect(map.getZoom()).toBe(10)
      expect(map.getBearing()).toBe(45)
      // Repeat shouldn't bump anything.
      map.resize()
      map.resize()
      expect(map.getZoom()).toBe(10)
    })
  })

  describe('loaded (iter 439)', () => {
    it('returns false before init completes', () => {
      // mockCanvas() doesn't trigger GPU init, so the flag stays false
      // until the renderFrame ready-signal point is reached.
      expect(map.loaded()).toBe(false)
    })
  })
})
