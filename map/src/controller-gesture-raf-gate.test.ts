// ═══ GATE — PanZoomController two-finger pitch disambiguation + RAF teardown ═══
//
// TEST-ONLY. Two surgical controller.ts fixes, each with a fail-before /
// pass-after oracle driven through the SAME stub-canvas harness GATE 2 uses
// (real listeners, synthetic plain-object PointerEvents, real Camera).
//
// FIX 1 — dead two-finger pitch-vs-pinch disambiguation.
//   The two-finger branch (controller.ts) computed
//     distChange = Math.abs(dist - lastPinchDist)
//   AFTER `lastPinchDist = dist` already overwrote lastPinchDist with the
//   current frame's distance — so distChange was STRUCTURALLY 0 every frame,
//   and the guard `centerMove > 2 && centerMove > distChange * 2` degenerated
//   to `centerMove > 2`. Result: an asymmetric PINCH (fingers change distance
//   AND the pinch centre drifts vertically) wrongly tilted the map, because the
//   "distance change dominates → this is a zoom, suppress pitch" arm never
//   fired. The fix snapshots the PREVIOUS frame's distance (`prevDist`) before
//   the zoom block overwrites lastPinchDist and uses it for distChange.
//
//   ORACLE (asymmetric pinch must NOT pitch): fingers on a HORIZONTAL axis,
//   one finger dragged out + down so the separation grows a lot (big
//   distChange) while the centre drifts vertically a little (small centerMove).
//   Real distChange >> centerMove, so the genuine guard suppresses pitch.
//   Fail-before: distChange read as 0 → guard passes → camera.pitch moves.
//   Pass-after: distChange is the true (large) delta → guard fails → pitch
//   stays 0. Companion control (vertical drag of a wide horizontal pair) keeps
//   the separation ~constant while the centre drifts → pitch SHOULD apply, and
//   does in both versions (proves the fix did not just disable pitch).
//
// FIX 2 — inertia + smooth-zoom RAFs never cancelled on detach().
//   applyInertia + animateZoom self-reschedule via requestAnimationFrame and
//   both mutate the shared camera, but neither stored the handle and the
//   cleanup closure only removeEventListener'd. detach() (switchController
//   reload / map.stop() / map.destroy()) left an in-flight loop writing a
//   camera the map no longer owns. The fix stores the handles, flips a
//   `detached` guard, and cancelAnimationFrame's both on cleanup; a frame
//   already queued at cancel time bails on the guard.
//
//   ORACLE: a recording rAF stub (captures handle + callback, never auto-fires)
//   + a recording cancelAnimationFrame stub. Start a loop (pointerup flick →
//   inertia; wheel → smooth zoom), detach(), then assert cancelAnimationFrame
//   was called with the scheduled handle AND that manually firing the
//   still-queued stale callback does NOT mutate the camera (the bail).
//   Fail-before: cancelAnimationFrame never called; stale callback still pans /
//   zooms the camera.

import { describe, it, expect, afterEach } from 'vitest'
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
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false }
}

// ════════════════════════════════════════════════════════════════════════
// FIX 1 — two-finger pitch-vs-pinch disambiguation (distChange must be the
//          frame-over-frame delta, not the structurally-0 self-difference).
// ════════════════════════════════════════════════════════════════════════
describe('FIX 1 — two-finger asymmetric pinch must NOT pitch (distChange disambiguation)', () => {
  // Asymmetric pinch: two fingers on a HORIZONTAL axis; one finger is dragged
  // OUT and slightly DOWN. The separation grows a lot (large real distChange)
  // while the pinch centre drifts down only a little (small centerMove). The
  // genuine guard (centerMove > distChange*2) must SUPPRESS pitch — this is a
  // zoom, not a tilt. Pre-fix, distChange was 0 so the guard collapsed to
  // centerMove>2 and the map wrongly tilted ~12°.
  it('asymmetric pinch (distance grows, centre drifts down a little): camera.pitch stays 0', () => {
    const cam = makeFlatCamera()
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      // Horizontal pair: P1=(400,400), P2=(600,400) → dist=200, centre=(500,400).
      fire('pointerdown', ptr(1, 400, 400))
      fire('pointerdown', ptr(2, 600, 400))
      expect(cam.pitch, 'precondition: pitch starts at 0').toBe(0)

      // Drag P2 OUT to x=760 and DOWN to y=480.
      //   new dist = hypot(360, 80) ≈ 368.8 → distChange ≈ 168.8
      //   new centre.y = (400+480)/2 = 440 → centerMove = 40
      // Genuine guard: 40 > 2 (yes) AND 40 > 168.8*2=337.6 (NO) → no pitch.
      // Buggy guard: distChange=0 → 40 > 2 AND 40 > 0 → pitch -= 40*0.3 = -12°
      //   → clamped to 0 by Math.max(0,...). So a DOWNWARD centre drift on the
      //   buggy path lands pitch at 0 too (clamp floor) — to make the bug
      //   OBSERVABLE we drift the centre UP instead (negative dy → +pitch).
      // Drift P2 UP: y=320 instead. new centre.y=(400+320)/2=360 → dy=-40 →
      //   buggy: pitch -= (-40)*0.3 = +12°, observable; genuine: still suppressed.
      fire('pointermove', ptr(2, 760, 320))

      // Genuine guard suppresses the tilt — distChange (≈168.8) dominates the
      // small (40px) vertical centre drift. Pre-fix this asserted pitch ≈ 12°.
      expect(
        cam.pitch,
        `asymmetric pinch wrongly tilted the map to ${cam.pitch}° (dead distChange guard)`,
      ).toBe(0)
    } finally {
      ctrl.detach()
    }
  })

  // CONTROL — a genuine two-finger PITCH gesture must STILL pitch after the
  // fix (proves the fix narrowed the guard correctly, not disabled pitch).
  // Fingers on a WIDE horizontal axis dragged vertically: the separation is
  // dominated by the (unchanged) horizontal gap, so moving one finger up
  // barely changes distance while the centre drifts noticeably → guard passes.
  it('control: wide horizontal pair, vertical centre drift with ~constant separation DOES pitch', () => {
    const cam = makeFlatCamera()
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      // Wide horizontal pair: P1=(200,400), P2=(600,400) → dist=400, centre.y=400.
      fire('pointerdown', ptr(1, 200, 400))
      fire('pointerdown', ptr(2, 600, 400))
      expect(cam.pitch, 'precondition: pitch starts at 0').toBe(0)

      // Drag P1 UP to y=360 (x unchanged):
      //   new dist = hypot(400, 40) ≈ 402.0 → distChange ≈ 2.0
      //   new centre.y = (360+400)/2 = 380 → dy = -20, centerMove = 20
      // Guard: 20 > 2 (yes) AND 20 > 2.0*2=4.0 (yes) → pitch -= (-20)*0.3 = +6°.
      fire('pointermove', ptr(1, 200, 360))

      expect(
        cam.pitch,
        `genuine vertical two-finger drag failed to pitch (got ${cam.pitch}°)`,
      ).toBeGreaterThan(0)
    } finally {
      ctrl.detach()
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
// FIX 2 — detach() cancels in-flight inertia + smooth-zoom RAF loops; a stale
//          queued frame bails instead of mutating the orphaned camera.
// ════════════════════════════════════════════════════════════════════════
describe('FIX 2 — detach() cancels inertia + smooth-zoom RAFs (no post-teardown camera mutation)', () => {
  type RafGlobal = {
    requestAnimationFrame?: unknown
    cancelAnimationFrame?: unknown
  }
  const g = globalThis as RafGlobal
  const prevRAF = g.requestAnimationFrame
  const prevCAF = g.cancelAnimationFrame

  afterEach(() => {
    if (prevRAF === undefined) delete g.requestAnimationFrame
    else g.requestAnimationFrame = prevRAF
    if (prevCAF === undefined) delete g.cancelAnimationFrame
    else g.cancelAnimationFrame = prevCAF
  })

  // Recording rAF: stores (handle, callback) but NEVER auto-fires — the test
  // drives the stale frame manually. cancelAnimationFrame records the cancelled
  // handle. jsdom/node lack both, so we stub on globalThis and restore above.
  function installRecordingRaf() {
    let next = 1
    const queued = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      const h = next++
      queued.set(h, cb)
      return h
    }
    g.cancelAnimationFrame = (h: number): void => {
      cancelled.push(h)
      queued.delete(h)
    }
    return {
      cancelled,
      // The handle of the LAST still-queued (uncancelled) frame, and its cb.
      lastQueued(): { handle: number; cb: FrameRequestCallback } | null {
        let last: { handle: number; cb: FrameRequestCallback } | null = null
        for (const [handle, cb] of queued) last = { handle, cb }
        return last
      },
      allQueuedHandles(): number[] {
        return [...queued.keys()]
      },
    }
  }

  it('inertia loop: detach() cancels the scheduled frame AND a stale frame does not pan the camera', () => {
    const raf = installRecordingRaf()
    const cam = makeFlatCamera()
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))

    // Flick: a fast drag builds pan velocity, pointerup (size→0) starts inertia.
    // applyInertia runs ONE synchronous body (camera.pan + schedules rAF) — the
    // recording stub captures that pending handle without firing it.
    fire('pointerdown', ptr(1, 400, 400))
    fire('pointermove', ptr(1, 460, 400)) // dx=60 → large velocity (capped 15)
    fire('pointermove', ptr(1, 520, 400)) // keep velocity above the >2 flick gate
    fire('pointerup', ptr(1, 520, 400))

    // An inertia frame must be in flight (one queued handle, not yet cancelled).
    const pending = raf.lastQueued()
    expect(
      pending,
      'inertia did not schedule a RAF (flick velocity too low to start the loop)',
    ).not.toBeNull()

    const cxBefore = cam.centerX
    const cyBefore = cam.centerY

    // Teardown.
    ctrl.detach()

    // The scheduled inertia handle was cancelled.
    expect(
      raf.cancelled,
      `detach() did not cancelAnimationFrame the inertia handle ${pending!.handle}`,
    ).toContain(pending!.handle)

    // A frame that was ALREADY queued before cancel still fires in the browser
    // (cancel only prevents FUTURE delivery of an un-run callback; a frame the
    // engine already dequeued runs). Fire the stale callback: the `detached`
    // guard must make it bail WITHOUT panning the orphaned camera.
    pending!.cb(0)
    expect(cam.centerX, 'stale inertia frame mutated camera.centerX after detach()').toBe(cxBefore)
    expect(cam.centerY, 'stale inertia frame mutated camera.centerY after detach()').toBe(cyBefore)
  })

  it('smooth-zoom loop: detach() cancels the scheduled frame AND a stale frame does not zoom the camera', () => {
    const raf = installRecordingRaf()
    const cam = makeFlatCamera()
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))

    // Wheel up → animateZoom() runs one synchronous zoomAt + schedules the
    // easing-tail rAF (diff 0.36 >> 0.005, so it reschedules rather than
    // settling). The recording stub captures that pending handle.
    fire('wheel', { clientX: 400, clientY: 400, deltaY: -120, deltaMode: 0, preventDefault() {} })

    const pending = raf.lastQueued()
    expect(pending, 'wheel did not schedule a smooth-zoom RAF').not.toBeNull()

    const zoomBefore = cam.zoom

    ctrl.detach()

    expect(
      raf.cancelled,
      `detach() did not cancelAnimationFrame the zoom handle ${pending!.handle}`,
    ).toContain(pending!.handle)

    // Stale queued frame must bail on the `detached` guard, not zoom.
    pending!.cb(0)
    expect(cam.zoom, 'stale smooth-zoom frame mutated camera.zoom after detach()').toBe(zoomBefore)
  })
})
