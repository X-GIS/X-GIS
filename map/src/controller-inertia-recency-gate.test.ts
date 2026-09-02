// ═══ GATE — pan inertia is launched only from a RECENT velocity sample ═══
//
// hunt 2026-09-02: drag → hold (pointer stationary, still down) → release flung
// the map, because the pointerup inertia gate read panVelX/Y — sampled only on
// pointermove — without ever comparing performance.now() against lastMoveTime.
// #2294: a release more than INERTIA_MAX_IDLE_MS after the last move must not
// glide; a genuine flick (release right after a move) still must.
//
// Same stub-canvas harness as controller-gesture-raf-gate.test.ts (real
// listeners, synthetic plain-object PointerEvents, real Camera), with
// performance.now() mocked so the hold is wall-clock, not sleep.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Camera } from './camera'
import { PanZoomController } from './controller'

const W = 800,
  H = 800

function makeStubCanvas(): {
  canvas: HTMLCanvasElement
  fire: (type: string, ev: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const canvas = {
    width: W,
    height: H,
    clientWidth: W,
    clientHeight: H,
    style: {} as CSSStyleDeclaration,
    addEventListener(type: string, fn: (e: unknown) => void) {
      const arr = listeners.get(type) ?? []
      arr.push(fn)
      listeners.set(type, arr)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const arr = listeners.get(type)
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: W, bottom: H, width: W, height: H }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  const fire = (type: string, ev: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(ev)
  }
  return { canvas, fire }
}

function makeFlatCamera(zoom = 6): Camera {
  const cam = new Camera(20, 30, zoom)
  cam.projType = 0
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

function ptr(pointerId: number, clientX: number, clientY: number): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false, pointerType: 'mouse' }
}

type RafGlobal = { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
const g = globalThis as RafGlobal
const prevRAF = g.requestAnimationFrame
const prevCAF = g.cancelAnimationFrame

afterEach(() => {
  vi.restoreAllMocks()
  if (prevRAF === undefined) delete g.requestAnimationFrame
  else g.requestAnimationFrame = prevRAF
  if (prevCAF === undefined) delete g.cancelAnimationFrame
  else g.cancelAnimationFrame = prevCAF
})

// One eastward drag at 20 px / 16 ms (velocity 20 px/frame, well over the >2
// flick gate and the ±15 cap), then a `holdMs` pause with the button still
// down, then release.
function dragHoldRelease(holdMs: number) {
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const rafSpy = vi.fn((_cb: FrameRequestCallback) => 1)
  g.requestAnimationFrame = rafSpy
  g.cancelAnimationFrame = vi.fn()

  const cam = makeFlatCamera()
  const { canvas, fire } = makeStubCanvas()
  const ctrl = new PanZoomController()
  ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))

  fire('pointerdown', ptr(1, 400, 300))
  now = 1016
  fire('pointermove', ptr(1, 420, 300))
  now = 1032
  fire('pointermove', ptr(1, 440, 300))
  now = 1048
  fire('pointermove', ptr(1, 460, 300))

  const cxBeforeUp = cam.centerX
  const cyBeforeUp = cam.centerY
  now = 1048 + holdMs
  fire('pointerup', ptr(1, 460, 300))
  return { cam, ctrl, rafSpy, cxBeforeUp, cyBeforeUp }
}

describe('pan inertia recency gate (drag → hold → release)', () => {
  it('releasing after a 1500 ms hold does NOT launch inertia from the stale velocity', () => {
    const { cam, ctrl, rafSpy, cxBeforeUp, cyBeforeUp } = dragHoldRelease(1500)
    try {
      expect(
        rafSpy,
        'inertia rAF was scheduled after a 1.5 s hold (stale last-move velocity used)',
      ).not.toHaveBeenCalled()
      expect(cam.centerX, 'camera.centerX moved on release after a 1.5 s hold').toBe(cxBeforeUp)
      expect(cam.centerY, 'camera.centerY moved on release after a 1.5 s hold').toBe(cyBeforeUp)
    } finally {
      ctrl.detach()
    }
  })

  it('a hold just past the 160 ms window also does NOT launch inertia', () => {
    const { cam, ctrl, rafSpy, cxBeforeUp } = dragHoldRelease(200)
    try {
      expect(rafSpy, 'inertia rAF was scheduled after a 200 ms hold').not.toHaveBeenCalled()
      expect(cam.centerX, 'camera.centerX moved on release after a 200 ms hold').toBe(cxBeforeUp)
    } finally {
      ctrl.detach()
    }
  })

  it('CONTROL: releasing 16 ms after the last move DOES launch inertia', () => {
    const { cam, ctrl, rafSpy, cxBeforeUp } = dragHoldRelease(16)
    try {
      expect(rafSpy, 'flick release did not schedule inertia').toHaveBeenCalled()
      expect(cam.centerX, 'flick release did not pan on the first inertia frame').not.toBe(
        cxBeforeUp,
      )
    } finally {
      ctrl.detach()
    }
  })
})
