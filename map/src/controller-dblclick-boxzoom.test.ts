// ═══ #1265 — double-click zoom + Shift+drag box zoom contract gates ═══
//
// TEST-ONLY. Fail-before authored against the target contract (acceptance
// list in issue #1265): dblclick zooms in one level about the cursor (the
// point under the cursor stays put), Shift+dblclick zooms out, Shift+drag
// box-zoom fits the dragged rect (eased fitBounds via the new `onBoxZoom`
// callback), Escape cancels a mid-drag box without touching the camera, and
// both gestures are individually disableable via `ControllerState`
// (MapLibre `doubleClickZoom`/`boxZoom` handler-option parity).
//
// Idiom matches controller-interaction-gate.test.ts (GATE 2): a stub canvas
// that REALLY registers listeners so synthetic events reach the controller's
// own handlers, a real Camera + PanZoomController, node env (no
// window/PointerEvent — plain-object synthetic events satisfy the fields the
// handlers read). GATE 2B's bounded-synchronous-rAF shim is reused so the
// dblclick smooth-zoom ease actually converges inside the test instead of
// only asserting the first frame.
//
// Regression pins (must stay green, unchanged behaviour):
//   - plain drag (no shift) still pans — box zoom must not intercept it.
//   - the pre-existing touch/pen pointerdown-timing double-tap zoom-in is
//     untouched; only mouse is now excluded from it (the #1265 fix that
//     stops it double-firing alongside the new native `dblclick` handler).
//
// Out of scope here (see the #1265 fixer report): the map.ts-level
// `onBoxZoom` -> `fitBounds({duration})` wiring (glue, exercised indirectly
// by constructing XGISMap — heavier, not this file's job) and the
// feature-listener `preventDefault()`-suppresses-dblclick-zoom detail from
// the issue's "Proposed approach" (not in its official Acceptance list).

import { describe, it, expect, afterEach } from 'vitest'
import { Camera } from './camera'
import { PanZoomController, type ControllerState } from './controller'

const W = 800,
  H = 800

// ── Stub canvas that REALLY registers listeners (mirrors GATE 2's
//    makeStubCanvas) so synthetic pointerdown/pointermove/pointerup/
//    dblclick/keydown events reach the controller's own handlers. ──
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
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev)
  }
  return { canvas, fire }
}

function makeMercCamera(zoom = 6): Camera {
  const cam = new Camera(20, 30, zoom)
  cam.projType = 0
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

function ptr(
  pointerId: number,
  clientX: number,
  clientY: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false, ...extra }
}

function dbl(clientX: number, clientY: number, shiftKey = false): Record<string, unknown> {
  return { clientX, clientY, shiftKey, preventDefault() {} }
}

function state(overrides: Partial<ControllerState> = {}): () => ControllerState {
  return () => ({ projectionName: 'mercator', ...overrides })
}

// GATE 2B's bounded-synchronous-rAF shim: runs each scheduled frame INLINE
// (with a hard cap so a non-converging loop can't hang the test) so the
// dblclick smooth-zoom ease actually converges within the test instead of
// only asserting the first frame's delta.
function installBoundedRAF(): void {
  let frames = 0
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: FrameRequestCallback,
  ) => {
    if (frames++ < 2000) cb(0)
    return 0
  }
}

describe('#1265 — double-click zoom (native dblclick, MapLibre ClickZoomHandler parity)', () => {
  const prevRAF = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  afterEach(() => {
    if (prevRAF === undefined)
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prevRAF
  })

  it('zooms in by 1 level and keeps the point under the cursor fixed', () => {
    installBoundedRAF()
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state())
    try {
      const cx = 480,
        cy = 420
      const z0 = cam.zoom
      const g0 = cam.unprojectToLonLat(cx, cy, W, H, 1)
      expect(g0, 'geo under cursor before dblclick is null').not.toBeNull()

      fire('dblclick', dbl(cx, cy))

      expect(cam.zoom, `zoom did not converge to +1 (z0=${z0}, now=${cam.zoom})`).toBeCloseTo(
        z0 + 1,
        2,
      )
      const gEnd = cam.unprojectToLonLat(cx, cy, W, H, 1)
      expect(gEnd, 'geo under cursor after dblclick is null').not.toBeNull()
      expect(Math.abs(g0![0] - gEnd![0]), 'lon under cursor drifted').toBeLessThan(1e-4)
      expect(Math.abs(g0![1] - gEnd![1]), 'lat under cursor drifted').toBeLessThan(1e-4)
    } finally {
      ctrl.detach()
    }
  })

  it('Shift+dblclick zooms OUT by 1 level (MapLibre parity: shiftKey ⇒ -1)', () => {
    installBoundedRAF()
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state())
    try {
      const z0 = cam.zoom
      fire('dblclick', dbl(480, 420, true))
      expect(cam.zoom, `zoom did not converge to -1 (z0=${z0}, now=${cam.zoom})`).toBeCloseTo(
        z0 - 1,
        2,
      )
    } finally {
      ctrl.detach()
    }
  })

  it('doubleClickZoomEnabled: false disables the gesture (MapLibre handler-option parity)', () => {
    installBoundedRAF()
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ doubleClickZoomEnabled: false }))
    try {
      const z0 = cam.zoom
      fire('dblclick', dbl(480, 420))
      expect(cam.zoom, 'zoom changed despite doubleClickZoomEnabled: false').toBe(z0)
    } finally {
      ctrl.detach()
    }
  })

  // Regression pin for the #1265 fix: a mouse PointerEvent satisfies the SAME
  // pointerdown-timing window the pre-existing touch/pen double-tap zoom
  // used (dt<300ms, dist<30px) — without excluding pointerType==='mouse'
  // there, a real mouse double-click would fire BOTH that instant zoomAt(1)
  // AND the new native dblclick handler above (a double zoom-in).
  it('pointerType "mouse" does NOT trigger the legacy pointerdown-timing double-tap (only native dblclick zooms)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state())
    try {
      const z0 = cam.zoom
      fire('pointerdown', ptr(1, 400, 400, { pointerType: 'mouse' }))
      fire('pointerup', ptr(1, 400, 400, { pointerType: 'mouse' }))
      fire('pointerdown', ptr(1, 400, 400, { pointerType: 'mouse' }))
      fire('pointerup', ptr(1, 400, 400, { pointerType: 'mouse' }))
      expect(
        cam.zoom,
        'a rapid mouse pointerdown pair triggered the legacy instant double-tap zoom',
      ).toBe(z0)
    } finally {
      ctrl.detach()
    }
  })

  // Control: the touch/pen path this timing window was written for is
  // UNCHANGED — still an instant (non-eased) +1 zoomAt, no dblclick needed.
  it('pointerType "touch" still gets the legacy instant double-tap zoom-in (unchanged existing behaviour)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state())
    try {
      const z0 = cam.zoom
      fire('pointerdown', ptr(1, 400, 400, { pointerType: 'touch' }))
      fire('pointerdown', ptr(1, 400, 400, { pointerType: 'touch' }))
      expect(cam.zoom, 'touch double-tap did not zoom in instantly').toBeCloseTo(z0 + 1, 6)
    } finally {
      ctrl.detach()
    }
  })
})

describe('#1265 — box zoom (Shift+drag, MapLibre BoxZoomHandler parity)', () => {
  it("Shift+drag release calls onBoxZoom with the dragged rect's geo bounds (mercator oracle)", () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    const calls: Array<[[number, number], [number, number]]> = []
    ctrl.attach(canvas, cam, state(), { onBoxZoom: (b) => calls.push(b) })
    try {
      const x0 = 300,
        y0 = 250,
        x1 = 500,
        y1 = 420
      fire('pointerdown', ptr(1, x0, y0, { shiftKey: true }))
      fire('pointermove', ptr(1, x1, y1, { shiftKey: true }))
      fire('pointerup', ptr(1, x1, y1, { shiftKey: true }))

      expect(calls.length, 'onBoxZoom was not called after a real Shift+drag').toBe(1)

      // Oracle: unproject all 4 screen corners independently and take the
      // AABB — the same composition the controller performs.
      const corners: Array<[number, number]> = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]
      const lonLats = corners.map((c) => cam.unprojectToLonLat(c[0], c[1], W, H, 1))
      expect(lonLats.every((p) => p !== null), 'oracle corner unprojection was null').toBe(true)
      const lons = lonLats.map((p) => p![0])
      const lats = lonLats.map((p) => p![1])
      const expected: [[number, number], [number, number]] = [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ]

      const [got] = calls
      expect(got[0][0]).toBeCloseTo(expected[0][0], 6)
      expect(got[0][1]).toBeCloseTo(expected[0][1], 6)
      expect(got[1][0]).toBeCloseTo(expected[1][0], 6)
      expect(got[1][1]).toBeCloseTo(expected[1][1], 6)
    } finally {
      ctrl.detach()
    }
  })

  it('a Shift+drag never pans the camera itself — only onBoxZoom carries the fit', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state(), { onBoxZoom: () => {} })
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY,
        z0 = cam.zoom
      fire('pointerdown', ptr(1, 300, 250, { shiftKey: true }))
      fire('pointermove', ptr(1, 500, 420, { shiftKey: true }))
      fire('pointerup', ptr(1, 500, 420, { shiftKey: true }))
      expect(cam.centerX, 'box-zoom drag panned the camera (centerX)').toBe(cx0)
      expect(cam.centerY, 'box-zoom drag panned the camera (centerY)').toBe(cy0)
      expect(cam.zoom, 'box-zoom drag changed zoom directly').toBe(z0)
    } finally {
      ctrl.detach()
    }
  })

  it('a near-zero-travel Shift-click cancels without calling onBoxZoom (MapLibre p0===p1 parity)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    const calls: unknown[] = []
    ctrl.attach(canvas, cam, state(), { onBoxZoom: (b) => calls.push(b) })
    try {
      fire('pointerdown', ptr(1, 400, 400, { shiftKey: true }))
      fire('pointerup', ptr(1, 400, 400, { shiftKey: true }))
      expect(calls.length, 'a zero-travel shift-click still fired onBoxZoom').toBe(0)
    } finally {
      ctrl.detach()
    }
  })

  it('Escape mid-box cancels: onBoxZoom is not called and the camera is unchanged', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    const calls: unknown[] = []
    ctrl.attach(canvas, cam, state(), { onBoxZoom: (b) => calls.push(b) })
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY,
        z0 = cam.zoom
      fire('pointerdown', ptr(1, 300, 250, { shiftKey: true }))
      fire('pointermove', ptr(1, 500, 420, { shiftKey: true })) // arms the box
      fire('keydown', { key: 'Escape', keyCode: 27 })
      fire('pointerup', ptr(1, 500, 420, { shiftKey: true }))

      expect(calls.length, 'onBoxZoom fired despite an Escape cancel').toBe(0)
      expect(cam.centerX, 'camera moved after an Escape-cancelled box zoom').toBe(cx0)
      expect(cam.centerY, 'camera moved after an Escape-cancelled box zoom').toBe(cy0)
      expect(cam.zoom, 'zoom changed after an Escape-cancelled box zoom').toBe(z0)
    } finally {
      ctrl.detach()
    }
  })

  it('boxZoomEnabled: false falls back to a normal pan (MapLibre handler-option parity)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    const calls: unknown[] = []
    ctrl.attach(canvas, cam, state({ boxZoomEnabled: false }), { onBoxZoom: (b) => calls.push(b) })
    try {
      const cx0 = cam.centerX
      fire('pointerdown', ptr(1, 300, 250, { shiftKey: true }))
      fire('pointermove', ptr(1, 500, 420, { shiftKey: true }))
      fire('pointerup', ptr(1, 500, 420, { shiftKey: true }))
      expect(calls.length, 'onBoxZoom fired despite boxZoomEnabled: false').toBe(0)
      expect(cam.centerX, 'boxZoomEnabled:false did not fall back to a normal pan').not.toBe(cx0)
    } finally {
      ctrl.detach()
    }
  })

  // Regression pin: box zoom must not intercept an ordinary (non-shift) drag.
  it('regression pin: a plain drag (no shift) still pans', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    const calls: unknown[] = []
    ctrl.attach(canvas, cam, state(), { onBoxZoom: (b) => calls.push(b) })
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY
      fire('pointerdown', ptr(1, 300, 250))
      fire('pointermove', ptr(1, 500, 420))
      const moved = Math.hypot(cam.centerX - cx0, cam.centerY - cy0)
      expect(moved, 'plain drag did not pan the camera').toBeGreaterThan(1000)
      expect(calls.length, 'a plain drag incorrectly fired onBoxZoom').toBe(0)
    } finally {
      ctrl.detach()
    }
  })
})
