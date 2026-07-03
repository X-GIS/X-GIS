// ═══════════════════════════════════════════════════════════════════
// XGISMapOptions initial-view construction options (#795 P2)
// ═══════════════════════════════════════════════════════════════════
//
// The constructor seeds the camera from center / zoom / bearing / pitch /
// projection so the FIRST frame is already framed (no default-then-jump).
// The seed routes through the SAME setters as the runtime API, so a
// ctor-seeded view must be byte-identical to the equivalent post-construction
// setter calls — the CPU half of the DC=0 gate (identical camera state before
// the first render ⇒ identical render by construction). GPU-free: the ctor
// builds only CPU objects (initGPU runs in run()).

import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface CameraLike {
  centerX: number
  centerY: number
  centerLatDeg: number
  zoom: number
  bearing: number
  pitch: number
  projType: number
}
function cam(map: XGISMap): CameraLike {
  return (map as unknown as { camera: CameraLike }).camera
}
function positioned(map: XGISMap): boolean {
  return (map as unknown as { _cameraPositionedFlag: boolean })._cameraPositionedFlag
}

describe('XGISMapOptions initial view (#795 P2)', () => {
  it('no options ⇒ engine default camera, positioned flag false', () => {
    const map = new XGISMap(mockCanvas())
    const c = cam(map)
    expect(c.zoom).toBe(2)
    expect(c.centerLatDeg).toBeCloseTo(20, 6)
    expect(c.bearing).toBe(0)
    expect(c.pitch).toBe(0)
    expect(map.getProjectionName()).toBe('mercator')
    // Default view must NOT latch — bounds-auto-fit still frames to data.
    expect(positioned(map)).toBe(false)
  })

  it('seeds each field + latches the positioned flag', () => {
    const map = new XGISMap(mockCanvas(), {
      center: [126.978, 37.566],
      zoom: 11,
      bearing: 30,
      pitch: 45,
      projection: 'globe',
    })
    const c = cam(map)
    expect(c.zoom).toBe(11)
    expect(c.centerLatDeg).toBeCloseTo(37.566, 3)
    expect(c.bearing).toBe(30)
    expect(c.pitch).toBe(45)
    expect(map.getProjectionName()).toBe('globe')
    expect(positioned(map)).toBe(true)
  })

  // The load-bearing invariant: a ctor-seeded view === the same view applied
  // via post-construction setters. Same camera state before the first frame ⇒
  // byte-identical render (DC=0 by construction).
  it('ctor seed is byte-identical to post-construction setter calls', () => {
    const opts = {
      center: [126.978, 37.566] as [number, number],
      zoom: 11,
      bearing: 30,
      pitch: 45,
      projection: 'globe',
    }
    const ctorSeeded = new XGISMap(mockCanvas(), opts)

    const viaSetters = new XGISMap(mockCanvas())
    viaSetters.setProjection(opts.projection)
    viaSetters.setCenter(opts.center[0], opts.center[1])
    viaSetters.setZoom(opts.zoom)
    viaSetters.setBearing(opts.bearing)
    viaSetters.setPitch(opts.pitch)
    viaSetters.markCameraPositioned()

    const a = cam(ctorSeeded)
    const b = cam(viaSetters)
    expect(a.centerX).toBe(b.centerX)
    expect(a.centerY).toBe(b.centerY)
    expect(a.centerLatDeg).toBe(b.centerLatDeg)
    expect(a.zoom).toBe(b.zoom)
    expect(a.bearing).toBe(b.bearing)
    expect(a.pitch).toBe(b.pitch)
    expect(a.projType).toBe(b.projType)
    expect(ctorSeeded.getProjectionName()).toBe(viaSetters.getProjectionName())
    expect(positioned(ctorSeeded)).toBe(positioned(viaSetters))
  })

  it('a bearing/pitch-only seed still latches (the setters that do not self-latch)', () => {
    const map = new XGISMap(mockCanvas(), { bearing: 90, pitch: 20 })
    expect(cam(map).bearing).toBe(90)
    expect(cam(map).pitch).toBe(20)
    expect(positioned(map)).toBe(true)
  })

  it('projection-only does NOT latch (orthogonal to data-bounds framing)', () => {
    const map = new XGISMap(mockCanvas(), { projection: 'natural_earth' })
    expect(map.getProjectionName()).toBe('natural_earth')
    expect(positioned(map)).toBe(false)
  })

  it('partial seed: omitted fields keep the engine default', () => {
    const map = new XGISMap(mockCanvas(), { zoom: 7 })
    const c = cam(map)
    expect(c.zoom).toBe(7)
    expect(c.centerLatDeg).toBeCloseTo(20, 6) // untouched default
    expect(c.bearing).toBe(0)
    expect(c.pitch).toBe(0)
    expect(positioned(map)).toBe(true) // zoom latches
  })
})
