// ═══ GATE — PanZoomController drag/pinch anchor DPR must match the canvas
//          device scale (getMaxDpr), not a hardcoded cap of 8 ═══
//
// TEST-ONLY. Drives the real PanZoomController through the same stub-canvas
// harness controller-gesture-raf-gate.test.ts uses (real listeners, synthetic
// plain-object PointerEvents, real Camera).
//
// BUG: the drag-start (pointerdown) and pinch→single-finger handoff anchor
// capture computed its device-pixel scale as
//   Math.min(window.devicePixelRatio || 1, 8)
// — a hardcoded cap of 8. Every OTHER dpr site (gpu.ts canvas sizing,
// camera.panToScreenAnchor replay, camera-controller, render-loop) uses
// getMaxDpr() = QUALITY.maxDpr (default 3; 1/1.5/2 for the
// performance/battery/balanced presets). The canvas is sized at
//   canvas.width = clientWidth * min(devicePixelRatio, getMaxDpr())
// so when devicePixelRatio > maxDpr (e.g. a retina DPR=4 phone at the default
// maxDpr=3, or any DPR>=2 device under ?quality=performance maxDpr=1) the
// captured anchor's NDC is computed against a LARGER dpr than the canvas's
// real device scale. The replay (panToScreenAnchor → unprojectToZ0) uses
// getMaxDpr(), so capture and replay disagree → on the FIRST pointermove at
// the UNCHANGED cursor position the camera jumps by a delta ∝
// (dprCaptured/getMaxDpr() − 1).
//
// ORACLE: window.devicePixelRatio=4, QUALITY.maxDpr pinned to 3. Mercator
// camera, pitch 0, bearing 0. Fire pointerdown at an OFF-CENTRE cursor, then
// pointermove at the SAME client coords. A correct anchor makes that an exact
// no-op (the grabbed world point is already under the cursor). Fail-before:
// captured dpr=min(4,8)=4 ≠ replay dpr=getMaxDpr()=3 → centerX/centerY shift.
// Pass-after: captured dpr=getMaxDpr()=3 = replay dpr → exact no-op.
//
// Same class as the already-fixed camera-controller DPR bug
// (camera-dpr-units.test.ts), different file.

import { describe, it, expect, afterEach } from 'vitest'
import { Camera } from '@xgis/engine'
import { PanZoomController } from './controller'
import { QUALITY, updateQuality } from '@xgis/engine'

// CSS viewport. canvas.width/height are DEVICE pixels = CSS * device scale,
// where the device scale is min(devicePixelRatio, getMaxDpr()) exactly as
// gpu.ts resizeCanvas computes them. With devicePixelRatio=4 and maxDpr=3 the
// device scale is the CLAMPED 3 — so the buggy capture dpr (min(4,8)=4)
// exceeds the canvas's real device scale and the replay's getMaxDpr()=3.
const CSS_W = 600
const CSS_H = 400

type WinShim = { devicePixelRatio?: number } | undefined
const g = globalThis as unknown as { window: WinShim }
const HAD_WINDOW = 'window' in globalThis

function makeStubCanvas(deviceScale: number): {
  canvas: HTMLCanvasElement
  fire: (type: string, ev: Record<string, unknown>) => void
} {
  const W = CSS_W * deviceScale
  const H = CSS_H * deviceScale
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const canvas = {
    width: W,
    height: H,
    clientWidth: CSS_W,
    clientHeight: CSS_H,
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
      return { left: 0, top: 0, right: CSS_W, bottom: CSS_H, width: CSS_W, height: CSS_H }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  const fire = (type: string, ev: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(ev)
  }
  return { canvas, fire }
}

function makeMercatorCamera(zoom = 4): Camera {
  const cam = new Camera(0, 0, zoom)
  cam.projType = 0
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

function ptr(pointerId: number, clientX: number, clientY: number): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false }
}

describe('PanZoomController drag anchor DPR = getMaxDpr (not hardcoded 8)', () => {
  const prevMaxDpr = QUALITY.maxDpr

  afterEach(() => {
    updateQuality({ maxDpr: prevMaxDpr })
    if (HAD_WINDOW) g.window = undefined
    else delete (globalThis as unknown as Record<string, unknown>).window
  })

  it('drag-start anchor + a no-move pointermove is a NO-OP when devicePixelRatio (4) exceeds maxDpr (3)', () => {
    g.window = { devicePixelRatio: 4 }
    updateQuality({ maxDpr: 3 })

    const cam = makeMercatorCamera()
    // Off-centre cursor so the NDC (and thus the per-dpr anchor delta) is
    // non-zero — a centred cursor maps to NDC 0 for any dpr and would mask
    // the bug. With CSS 600×400 / maxDpr 3 → device 1800×1200:
    //   capture (buggy dpr=4): ndcX = (360*4/1800)*2-1 = 0.6
    //   replay  (dpr=3):       ndcX = (360*3/1800)*2-1 = 0.2
    // The 0.4-NDC mismatch shifts centerX by a large fraction of the view
    // half-width on the very first move.
    const CX = 360, CY = 240
    const { canvas, fire } = makeStubCanvas(3)
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      const cxBefore = cam.centerX
      const cyBefore = cam.centerY

      // pointerdown captures the world anchor under the cursor.
      fire('pointerdown', ptr(1, CX, CY))
      // pointermove at the SAME client coords: panToScreenAnchor must place
      // the grabbed world point right back under the (unmoved) cursor → no-op.
      fire('pointermove', ptr(1, CX, CY))

      // A correct anchor (capture dpr == replay dpr == getMaxDpr()) leaves the
      // centre exactly where it was. Pre-fix the dpr mismatch shifts it by
      // hundreds of km. Tight epsilon so a real jump can never sneak under it.
      expect(
        Math.abs(cam.centerX - cxBefore),
        `first drag move jumped centerX by ${cam.centerX - cxBefore} m (capture dpr != getMaxDpr())`,
      ).toBeLessThan(1)
      expect(
        Math.abs(cam.centerY - cyBefore),
        `first drag move jumped centerY by ${cam.centerY - cyBefore} m (capture dpr != getMaxDpr())`,
      ).toBeLessThan(1)
    } finally {
      ctrl.detach()
    }
  })

  it('?quality=performance (maxDpr=1) on a DPR=2 device: no-move pointermove is still a NO-OP', () => {
    g.window = { devicePixelRatio: 2 }
    updateQuality({ maxDpr: 1 })

    const cam = makeMercatorCamera()
    // device scale = min(2, 1) = 1 → canvas 600×400. Buggy capture dpr =
    // min(2,8)=2, replay dpr = getMaxDpr()=1 → mismatch.
    const CX = 420, CY = 150
    const { canvas, fire } = makeStubCanvas(1)
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      const cxBefore = cam.centerX
      const cyBefore = cam.centerY

      fire('pointerdown', ptr(1, CX, CY))
      fire('pointermove', ptr(1, CX, CY))

      expect(Math.abs(cam.centerX - cxBefore)).toBeLessThan(1)
      expect(Math.abs(cam.centerY - cyBefore)).toBeLessThan(1)
    } finally {
      ctrl.detach()
    }
  })
})
