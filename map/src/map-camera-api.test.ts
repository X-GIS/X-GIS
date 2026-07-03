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
  camera: {
    centerX: number
    centerY: number
    zoom: number
    bearing: number
    pitch: number
    minZoom: number
    maxZoom: number
  }
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
  easeTo(opts: {
    center?: [number, number]
    zoom?: number
    bearing?: number
    pitch?: number
    duration?: number
    easing?: unknown
  }): void
  flyTo(opts: {
    center?: [number, number]
    zoom?: number
    bearing?: number
    pitch?: number
    duration?: number
    speed?: number
    curve?: number
  }): void
  resize(): void
  loaded(): boolean
  fitBounds(
    bounds: [[number, number], [number, number]],
    opts?: { padding?: number; bearing?: number; pitch?: number },
  ): void
  on(type: string, listener: unknown): void
  off(type: string, listener: unknown): void
  once(type: string, listener: unknown): void
  mapListeners: { has(type: string): boolean }
  mapEventListeners: { has(type: string): boolean }
  _processCameraEvents(): void
  _fireLoadEvent(): void
  getCanvas(): HTMLCanvasElement
  getContainer(): HTMLElement | null
  getBounds(): [[number, number], [number, number]]
  setStyle(s: unknown): void
  addLayer(l: unknown): void
  removeLayer(id: string): void
  addSource(id: string, s: unknown): void
  removeSource(id: string): void
  addImage(id: string, img: ImageBitmap | ImageData): void
  hasImage(id: string): boolean
  removeImage(id: string): void
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

    it("partial-success: invalid pitch doesn't block valid bearing", () => {
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

    it('readback is NaN-safe on every axis (iter 449)', () => {
      // Force NaN into all four camera fields (simulates a host bypass
      // that wrote camera.* directly without going through setters).
      map.camera.centerX = NaN
      map.camera.centerY = NaN
      map.camera.zoom = NaN
      map.camera.bearing = NaN
      map.camera.pitch = NaN
      const state = map.getCameraState()
      expect(Number.isFinite(state.center[0])).toBe(true)
      expect(Number.isFinite(state.center[1])).toBe(true)
      expect(state.zoom).toBe(0)
      expect(state.bearing).toBe(0)
      expect(state.pitch).toBe(0)
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
      map.setMaxBounds([
        [125, 33],
        [131, 39],
      ])
      map.setCenter(0, 0) // outside bbox
      const state = map.getCameraState()
      expect(state.center[0]).toBeGreaterThanOrEqual(125)
      expect(state.center[0]).toBeLessThanOrEqual(131)
      expect(state.center[1]).toBeGreaterThanOrEqual(33)
      expect(state.center[1]).toBeLessThanOrEqual(39)
    })

    it('clamps jumpTo center to bbox', () => {
      map.setMaxBounds([
        [125, 33],
        [131, 39],
      ])
      map.jumpTo({ center: [180, 80], zoom: 5 })
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(131)
      expect(state.center[1]).toBeLessThanOrEqual(39)
    })

    it('null clears bounds', () => {
      map.setMaxBounds([
        [0, 0],
        [10, 10],
      ])
      map.setMaxBounds(null)
      expect(map.getMaxBounds()).toBeNull()
      map.setCenter(180, 80) // should not be clamped
      const state = map.getCameraState()
      // Bounds cleared — center should reach roughly 180/80 (with lat
      // clamped to MERCATOR_LAT_LIMIT)
      expect(state.center[0]).toBeCloseTo(180, 0)
    })

    it('rejects malformed bbox (south > north)', () => {
      map.setMaxBounds([
        [0, 50],
        [10, 10],
      ]) // south=50 > north=10
      expect(map.getMaxBounds()).toBeNull()
    })

    it('rejects out-of-range lat', () => {
      map.setMaxBounds([
        [0, -95],
        [10, 10],
      ])
      expect(map.getMaxBounds()).toBeNull()
      map.setMaxBounds([
        [0, 0],
        [10, 100],
      ])
      expect(map.getMaxBounds()).toBeNull()
    })

    it('rejects antimeridian-crossing bbox (west > east, iter 448)', () => {
      // Pacific-rim bbox: 170°E to -170°E (wraps through 180°/dateline)
      map.setMaxBounds([
        [170, -50],
        [-170, 50],
      ])
      expect(map.getMaxBounds()).toBeNull()
    })

    it('immediately clamps current center when bounds shrink', () => {
      map.setCenter(180, 0)
      map.setMaxBounds([
        [0, -10],
        [20, 10],
      ]) // current center 180 is outside
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(20)
    })

    it('getMaxBounds returns the active bbox', () => {
      map.setMaxBounds([
        [1, 2],
        [3, 4],
      ])
      expect(map.getMaxBounds()).toEqual([
        [1, 2],
        [3, 4],
      ])
    })

    it('panBy honors bounds (iter 435)', () => {
      // Tight bbox around Korea + small zoom so panBy resolves to a
      // measurable lon delta.
      map.setMaxBounds([
        [125, 33],
        [131, 39],
      ])
      map.setZoom(0)
      map.setCenter(128, 36) // inside bbox
      // Pan east aggressively (1000 px); at zoom=0 with DPR=1 this is a
      // huge lon delta that would escape the bbox without the clamp.
      map.panBy([10000, 0])
      const state = map.getCameraState()
      expect(state.center[0]).toBeLessThanOrEqual(131)
    })

    it('interactive pan gesture honors bounds (shared Camera, not just programmatic)', () => {
      // setMaxBounds is documented to clamp USER PAN GESTURES too, but the
      // interactive seam (PanZoomController) drives camera.pan() directly on
      // the SHARED Camera, bypassing the controller's lon/lat clamp. Drive
      // that exact seam: set bounds via the controller, then call the raw
      // gesture mutator on the same shared camera.
      const cam = map.camera as unknown as {
        zoom: number
        pan(dx: number, dy: number, w: number, h: number): void
      }
      map.setMaxBounds([
        [125, 33],
        [131, 39],
      ])
      map.setCenter(128, 36) // inside bbox
      cam.zoom = 0
      // Pan east aggressively — a huge dx that would escape the bbox.
      cam.pan(100000, 0, 1200, 800)
      const state = map.getCameraState()
      expect(state.center[0]).toBeGreaterThanOrEqual(125)
      expect(state.center[0]).toBeLessThanOrEqual(131)
    })

    it('interactive zoom gesture honors bounds (shared Camera, not just programmatic)', () => {
      const cam = map.camera as unknown as {
        zoom: number
        zoomAt(d: number, sx: number, sy: number, w: number, h: number): void
      }
      map.setMaxBounds([
        [125, 33],
        [131, 39],
      ])
      map.setCenter(131, 39) // pinned at the NE corner
      cam.zoom = 0
      // Zoom in anchored far off the bbox corner — the anchor shift would
      // drift the center outside without the gesture clamp.
      cam.zoomAt(2, 1199, 0, 1200, 800)
      const state = map.getCameraState()
      expect(state.center[0]).toBeGreaterThanOrEqual(125)
      expect(state.center[0]).toBeLessThanOrEqual(131)
      expect(state.center[1]).toBeGreaterThanOrEqual(33)
      expect(state.center[1]).toBeLessThanOrEqual(39)
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

  describe('fitBounds (iter 440)', () => {
    it('centers on bbox midpoint', () => {
      map.fitBounds([
        [120, 30],
        [130, 40],
      ])
      const state = map.getCameraState()
      expect(state.center[0]).toBeCloseTo(125, 4)
      expect(state.center[1]).toBeCloseTo(35, 4)
    })

    it('applies optional bearing + pitch', () => {
      map.fitBounds(
        [
          [0, 0],
          [10, 10],
        ],
        { bearing: 45, pitch: 30 },
      )
      expect(map.getBearing()).toBe(45)
      expect(map.getPitch()).toBe(30)
    })

    it('rejects malformed bbox (south > north)', () => {
      map.setZoom(7)
      map.fitBounds([
        [0, 50],
        [10, 10],
      ])
      expect(map.getZoom()).toBe(7) // untouched
    })
  })

  describe('on / off / once (iter 442)', () => {
    it('on registers listener; off removes it', () => {
      const fn = () => {}
      map.on('click', fn)
      expect(map.mapListeners.has('click')).toBe(true)
      map.off('click', fn)
      expect(map.mapListeners.has('click')).toBe(false)
    })

    it('once registers a one-shot listener', () => {
      const fn = () => {}
      map.once('mousemove', fn)
      expect(map.mapListeners.has('mousemove')).toBe(true)
    })
  })

  describe('map lifecycle / camera events (P0-8)', () => {
    it('routes lifecycle event names to the map-event registry, not the feature one', () => {
      const fn = () => {}
      map.on('moveend', fn)
      expect(map.mapEventListeners.has('moveend')).toBe(true)
      expect(map.mapListeners.has('moveend')).toBe(false)
      map.off('moveend', fn)
      expect(map.mapEventListeners.has('moveend')).toBe(false)
    })

    it('still routes feature event names to the feature registry', () => {
      const fn = () => {}
      map.on('click', fn)
      expect(map.mapListeners.has('click')).toBe(true)
      expect(map.mapEventListeners.has('click')).toBe(false)
    })

    it('jumpTo fires movestart + move + moveend (one move cycle)', () => {
      const seen: string[] = []
      map.on('movestart', () => seen.push('movestart'))
      map.on('move', () => seen.push('move'))
      map.on('moveend', () => seen.push('moveend'))
      // Seed the event signature (first tick never fires — NaN warmup).
      map._processCameraEvents()
      expect(seen).toEqual([])
      // Real camera change.
      map.jumpTo({ center: [10, 20], zoom: 5 })
      // Tick 1: camera changed → movestart + move.
      map._processCameraEvents()
      // Tick 2: camera at rest → moveend.
      map._processCameraEvents()
      expect(seen).toEqual(['movestart', 'move', 'moveend'])
    })

    it('jumpTo with a zoom change fires zoomstart + zoom + zoomend', () => {
      const seen: string[] = []
      map.on('zoomstart', () => seen.push('zoomstart'))
      map.on('zoom', () => seen.push('zoom'))
      map.on('zoomend', () => seen.push('zoomend'))
      map._processCameraEvents() // seed
      map.jumpTo({ zoom: 7 })
      map._processCameraEvents() // zoomstart + zoom
      map._processCameraEvents() // zoomend
      expect(seen).toEqual(['zoomstart', 'zoom', 'zoomend'])
    })

    it('a pure pan (no zoom change) does NOT fire zoom events', () => {
      const seen: string[] = []
      map.on('zoom', () => seen.push('zoom'))
      map.on('move', () => seen.push('move'))
      map._processCameraEvents() // seed
      map.jumpTo({ center: [30, 0] }) // pan only
      map._processCameraEvents()
      map._processCameraEvents()
      expect(seen).toContain('move')
      expect(seen).not.toContain('zoom')
    })

    it('move payload carries the current center + zoom', () => {
      let payload: { center: [number, number]; zoom: number } | null = null
      map.on('move', (e: unknown) => {
        payload = e as { center: [number, number]; zoom: number }
      })
      map._processCameraEvents() // seed
      map.jumpTo({ center: [12, 34], zoom: 6 })
      map._processCameraEvents()
      expect(payload).not.toBeNull()
      const p = payload as unknown as { center: [number, number]; zoom: number }
      expect(p.center[0]).toBeCloseTo(12, 4)
      expect(p.center[1]).toBeCloseTo(34, 4)
      expect(p.zoom).toBeCloseTo(6, 4)
    })

    it('load fires once, even if the load hook runs twice', () => {
      let count = 0
      map.on('load', () => {
        count++
      })
      map._fireLoadEvent()
      map._fireLoadEvent()
      expect(count).toBe(1)
    })

    it('idle fires once when the camera is at rest with no pending work', () => {
      let idleCount = 0
      map.on('idle', () => {
        idleCount++
      })
      // Simulate the post-render quiesced state: a real frame would have
      // cleared _needsRender and stored the camera signature into
      // _lastSig*. Mirror that here (no GPU in the unit env) so
      // shouldRenderThisFrame() reports "nothing to draw".
      const internal = map as unknown as {
        _needsRender: boolean
        camera: { zoom: number; centerX: number; centerY: number; bearing: number; pitch: number }
        _lastSigZoom: number
        _lastSigCX: number
        _lastSigCY: number
        _lastSigBearing: number
        _lastSigPitch: number
      }
      internal._needsRender = false
      internal._lastSigZoom = internal.camera.zoom
      internal._lastSigCX = internal.camera.centerX
      internal._lastSigCY = internal.camera.centerY
      internal._lastSigBearing = internal.camera.bearing
      internal._lastSigPitch = internal.camera.pitch
      map._processCameraEvents() // seed (camera unchanged) → idle transition
      map._processCameraEvents() // stays idle → no second fire
      expect(idleCount).toBe(1)
    })
  })

  describe('getCanvas / getContainer (iter 444)', () => {
    it('getCanvas returns the canvas element', () => {
      const canvas = map.getCanvas()
      expect(canvas).toBeDefined()
      expect((canvas as unknown as { width: number }).width).toBe(1200)
    })

    it('getContainer returns null for a detached canvas (mockCanvas)', () => {
      // mockCanvas() returns an HTMLCanvasElement-like object with no
      // parentElement, so getContainer should resolve to null.
      expect(map.getContainer()).toBeNull()
    })
  })

  describe('getBounds (iter 445)', () => {
    it('returns a sensible bbox around the camera center at low zoom', () => {
      map.setCenter(0, 0)
      map.setZoom(2)
      const [[w, s], [e, n]] = map.getBounds()
      expect(w).toBeLessThan(0)
      expect(e).toBeGreaterThan(0)
      expect(s).toBeLessThan(0)
      expect(n).toBeGreaterThan(0)
    })

    it('higher zoom → narrower bbox', () => {
      map.setCenter(0, 0)
      map.setZoom(2)
      const wide = map.getBounds()
      map.setZoom(10)
      const tight = map.getBounds()
      const wideSpan = wide[1][0] - wide[0][0]
      const tightSpan = tight[1][0] - tight[0][0]
      expect(tightSpan).toBeLessThan(wideSpan)
    })

    it('clamps lat to [-90, 90]', () => {
      map.setCenter(0, 89)
      map.setZoom(0)
      const [[, s], [, n]] = map.getBounds()
      expect(s).toBeGreaterThanOrEqual(-90)
      expect(n).toBeLessThanOrEqual(90)
    })
  })

  describe('unsupported Mapbox style mutation stubs (iter 446)', () => {
    it('setStyle warns + returns (no throw)', () => {
      map.setStyle({})
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/setStyle.*not supported/))
    })

    it('addLayer warns + returns', () => {
      map.addLayer({})
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/addLayer.*not supported/))
    })

    it('removeLayer warns + returns', () => {
      map.removeLayer('foo')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/removeLayer.*not supported/))
    })

    it('addSource warns + returns', () => {
      map.addSource('s', {})
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/addSource.*not supported/))
    })

    it('removeSource warns + returns', () => {
      map.removeSource('s')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/removeSource.*not supported/))
    })

    it('addImage registers a host image (now supported, #797 P0)', () => {
      warnSpy.mockClear()
      const img = { width: 4, height: 4 } as unknown as ImageBitmap
      expect(map.hasImage('icon')).toBe(false)
      map.addImage('icon', img)
      expect(map.hasImage('icon')).toBe(true)
      map.removeImage('icon')
      expect(map.hasImage('icon')).toBe(false)
      // addImage is a real API now — no "unsupported" warning.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/addImage.*not supported/))
    })

    it('warn-once: second call to same method does not re-warn', () => {
      warnSpy.mockClear()
      map.setStyle({})
      const firstCallCount = warnSpy.mock.calls.length
      map.setStyle({})
      // No additional warning on the repeat — _warnedStyleAPI set dedupes.
      expect(warnSpy.mock.calls.length).toBe(firstCallCount)
    })
  })
})
