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
  camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
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
})
