// ═══ #1256 easeTo / flyTo animation — behaviour contract ═══
//
// Drives the real CameraAnimator through CameraController (the SAME jumpTo
// mutation authority the gesture / programmatic paths use) with a stepped clock
// + manual rAF pump, so every assertion is deterministic:
//
//   - terminal-state equivalence: easeTo(T) / flyTo(T) settle byte-identical to
//     jumpTo(T) (center/zoom/bearing/pitch, incl. the raw camera fields).
//   - cancellation: a mid-flight abort leaves the camera at the interrupted
//     position (not snapped); a superseding easeTo/flyTo redirects to the new
//     target.
//   - van Wijk trajectory: a long flyTo dips zoom BELOW both endpoints (the
//     zoom-out-in arc) then rises back to the target.
//   - reduced-motion: the transition collapses to a single-tick jump (no frames).

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { CameraController, type CameraControllerDeps } from './camera-controller'

/** Stepped clock + deterministic rAF. Callbacks a frame reschedules run on the
 *  NEXT tick — matching real requestAnimationFrame — so pumping advances the
 *  self-rescheduling animation loop one frame at a time. */
class FakeRaf {
  t = 0
  private nextId = 1
  private cbs = new Map<number, (t: number) => void>()
  now = (): number => this.t
  raf = (cb: (t: number) => void): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  }
  cancelRaf = (id: number): void => {
    this.cbs.delete(id)
  }
  /** Advance the clock by `dt` ms then flush the frames pending at flush time. */
  tick(dt: number): void {
    this.t += dt
    const pending = [...this.cbs.values()]
    this.cbs.clear()
    for (const cb of pending) cb(this.t)
  }
  get pending(): number {
    return this.cbs.size
  }
}

function makeController(
  cam: Camera,
  raf: FakeRaf,
  opts: { reducedMotion?: boolean } = {},
): CameraController {
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
  } as unknown as HTMLCanvasElement
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => canvas,
    getCtxCanvas: () => canvas,
    now: raf.now,
    raf: raf.raf,
    cancelRaf: raf.cancelRaf,
    prefersReducedMotion: () => opts.reducedMotion ?? false,
  }
  return new CameraController(cam, deps)
}

/** Pump frames until the transition settles (bounded so a bug can't hang). */
function runToCompletion(ctrl: CameraController, raf: FakeRaf, dt = 16): void {
  let guard = 0
  while (ctrl.isAnimating()) {
    raf.tick(dt)
    if (++guard > 5000) throw new Error('animation did not settle')
  }
}

interface Snap {
  cx: number
  cy: number
  latDeg: number
  zoom: number
  bearing: number
  pitch: number
}
function snap(cam: Camera): Snap {
  return {
    cx: cam.centerX,
    cy: cam.centerY,
    latDeg: cam.centerLatDeg,
    zoom: cam.zoom,
    bearing: cam.bearing,
    pitch: cam.pitch,
  }
}

describe('#1256 easeTo — terminal-state equivalence', () => {
  it('easeTo(T) settles byte-identical to jumpTo(T)', () => {
    const raf = new FakeRaf()
    const target = { center: [10, 20] as [number, number], zoom: 6, bearing: 45, pitch: 30 }

    const animated = new Camera(0, 0, 3)
    const ctrl = makeController(animated, raf)
    ctrl.easeTo({ ...target, duration: 600 })
    // Mid-flight it must NOT already be at the target (proves it interpolated).
    raf.tick(16)
    expect(animated.zoom).not.toBe(target.zoom)
    runToCompletion(ctrl, raf)

    const jumped = new Camera(0, 0, 3)
    const ctrl2 = makeController(jumped, new FakeRaf())
    ctrl2.jumpTo(target)

    expect(snap(animated)).toEqual(snap(jumped))
  })

  it('easeTo with partial opts settles identical to the same partial jumpTo', () => {
    const raf = new FakeRaf()
    const animated = new Camera(30, 10, 4)
    const ctrl = makeController(animated, raf)
    ctrl.easeTo({ bearing: 60, duration: 400 })
    runToCompletion(ctrl, raf)

    const jumped = new Camera(30, 10, 4)
    makeController(jumped, new FakeRaf()).jumpTo({ bearing: 60 })

    expect(snap(animated)).toEqual(snap(jumped))
  })
})

describe('#1256 flyTo — terminal-state equivalence', () => {
  it('flyTo(T) across continents settles byte-identical to jumpTo(T)', () => {
    const raf = new FakeRaf()
    const target = { center: [139.69, 35.68] as [number, number], zoom: 5, bearing: 20, pitch: 15 }

    const animated = new Camera(-74, 40.7, 4) // New York → Tokyo
    const ctrl = makeController(animated, raf)
    ctrl.flyTo(target)
    runToCompletion(ctrl, raf)

    const jumped = new Camera(-74, 40.7, 4)
    makeController(jumped, new FakeRaf()).jumpTo(target)

    expect(snap(animated)).toEqual(snap(jumped))
  })

  it('degenerate near-equal-center flyTo falls back to an eased zoom (no NaN)', () => {
    const raf = new FakeRaf()
    const cam = new Camera(2.35, 48.85, 4)
    const ctrl = makeController(cam, raf)
    // Same center, only a zoom change ⇒ van Wijk pan path is undefined ⇒ easeTo.
    ctrl.flyTo({ center: [2.35, 48.85], zoom: 9, duration: 500 })
    runToCompletion(ctrl, raf)
    expect(cam.zoom).toBe(9)
    expect(Number.isFinite(cam.centerX)).toBe(true)
  })
})

describe('#1256 cancellation', () => {
  it('a gesture mid-animation aborts and leaves the camera at the interrupted position', () => {
    const raf = new FakeRaf()
    const cam = new Camera(0, 0, 2)
    const ctrl = makeController(cam, raf)
    ctrl.easeTo({ center: [80, 40], zoom: 10, duration: 2000 })

    // Advance to roughly mid-flight.
    while (raf.t < 1000) raf.tick(16)
    const midZoom = cam.zoom
    expect(midZoom).toBeGreaterThan(2)
    expect(midZoom).toBeLessThan(10)

    ctrl.cancelAnimation() // simulate the controller's onPointerDown abort
    expect(ctrl.isAnimating()).toBe(false)
    expect(raf.pending).toBe(0)

    // No further frame moves the camera — it stays where it was interrupted.
    raf.tick(16)
    expect(cam.zoom).toBe(midZoom)
    expect(cam.zoom).not.toBe(10)
  })

  it('a superseding easeTo redirects to the new target', () => {
    const raf = new FakeRaf()
    const cam = new Camera(0, 0, 2)
    const ctrl = makeController(cam, raf)

    ctrl.easeTo({ center: [80, 40], zoom: 10, duration: 2000 })
    while (raf.t < 800) raf.tick(16) // partway toward the first target

    ctrl.easeTo({ center: [-30, -10], zoom: 5, duration: 600 }) // supersede
    runToCompletion(ctrl, raf)

    const expected = new Camera(0, 0, 2)
    makeController(expected, new FakeRaf()).jumpTo({ center: [-30, -10], zoom: 5 })
    expect(cam.zoom).toBe(5)
    expect(cam.centerX).toBe(expected.centerX)
    expect(cam.centerY).toBe(expected.centerY)
  })
})

describe('#1256 flyTo — van Wijk zoom-out-in trajectory', () => {
  it('a long flyTo dips zoom below both endpoints then rises to the target', () => {
    const raf = new FakeRaf()
    const z0 = 4
    const cam = new Camera(-100, 40, z0) // North America
    const ctrl = makeController(cam, raf)
    const targetZoom = 4
    ctrl.flyTo({ center: [120, 35], zoom: targetZoom }) // → Asia

    const zooms: number[] = []
    let guard = 0
    while (ctrl.isAnimating()) {
      raf.tick(16)
      zooms.push(cam.zoom)
      if (++guard > 5000) throw new Error('flyTo did not settle')
    }

    const minZoom = Math.min(...zooms)
    // The optimal path zooms OUT below both endpoints (the arc, not a min-zoom
    // clamp: it stays well above 0) then returns to the target.
    expect(minZoom).toBeLessThan(Math.min(z0, targetZoom) - 1)
    expect(minZoom).toBeGreaterThan(0.5)
    expect(cam.zoom).toBe(targetZoom) // settled exactly on target
  })
})

describe('#1256 reduced-motion', () => {
  it('easeTo collapses to a single-tick jump — no intermediate frames', () => {
    const raf = new FakeRaf()
    const cam = new Camera(0, 0, 3)
    const ctrl = makeController(cam, raf, { reducedMotion: true })
    ctrl.easeTo({ center: [10, 20], zoom: 8, bearing: 30, pitch: 20, duration: 1000 })

    // Instantly at target, no frame scheduled, nothing animating.
    expect(ctrl.isAnimating()).toBe(false)
    expect(raf.pending).toBe(0)

    const jumped = new Camera(0, 0, 3)
    makeController(jumped, new FakeRaf()).jumpTo({
      center: [10, 20],
      zoom: 8,
      bearing: 30,
      pitch: 20,
    })
    expect(snap(cam)).toEqual(snap(jumped))
  })

  it('flyTo collapses to a single-tick jump — no intermediate frames', () => {
    const raf = new FakeRaf()
    const cam = new Camera(-74, 40.7, 4)
    const ctrl = makeController(cam, raf, { reducedMotion: true })
    ctrl.flyTo({ center: [139.69, 35.68], zoom: 6 })

    expect(ctrl.isAnimating()).toBe(false)
    expect(raf.pending).toBe(0)

    const jumped = new Camera(-74, 40.7, 4)
    makeController(jumped, new FakeRaf()).jumpTo({ center: [139.69, 35.68], zoom: 6 })
    expect(snap(cam)).toEqual(snap(jumped))
  })
})
