// ═══ GATE — drag anchor / zoomAt must use the dpr the CANVAS is sized at,
//          not a re-derived min(devicePixelRatio, getMaxDpr()) ═══
//
// hunt 2026-09-02: [map/interaction] Drag anchor and zoomAt jump by 1/8
// viewport under balanced/battery/?adaptiveDpr — controller.ts and camera.ts
// re-derived dpr as min(devicePixelRatio, getMaxDpr()) while the swapchain
// sits at QUALITY.interactionDpr.
//
// TEST-ONLY. Same stub-canvas harness as controller-dpr-anchor.test.ts (real
// listeners, synthetic plain-object PointerEvents, real Camera) — that file
// pins capture==replay while the canvas stays at the REST scale; this one
// crosses the interaction resize, which is the case neither it nor
// render-loop-interaction-dpr.test.ts covered.
//
// BUG: map.ts flips `_interacting` on pointerdown/wheel whenever
// QUALITY.interactionDpr !== null (balanced 1.5 / battery 1.0 / ?adaptiveDpr=N),
// and render-loop.ts then resizes the swapchain to
// min(devicePixelRatio, interactionDpr) on the very next frame. The controller
// and camera kept deriving their device scale from
// min(devicePixelRatio, getMaxDpr()), so from that frame on their scale
// disagreed with the canvas: a pointermove at the UNCHANGED cursor jumped the
// camera by (1 − interactionDpr/maxDpr)·(cursor offset from centre) — 100 CSS
// px = viewport/8 for the `balanced` preset on a 2× display — and every
// zoom anchored the wrong world point.
//
// ORACLE: the canvas's own scale (canvasEffectiveDpr = width/clientWidth) is
// the single geometric authority. A no-move pointermove is an exact no-op and
// zoomAt keeps the point under the cursor, at ANY canvas scale.
import { describe, it, expect, afterEach } from 'vitest'
import { Camera } from './camera'
import { PanZoomController } from './controller'
import { QUALITY, updateQuality, canvasEffectiveDpr } from '@xgis/engine'

const CSS_W = 800
const CSS_H = 600

type WinShim = { devicePixelRatio?: number } | undefined
const g = globalThis as unknown as { window: WinShim }
const HAD_WINDOW = 'window' in globalThis

function makeStubCanvas(deviceScale: number): {
  canvas: HTMLCanvasElement
  fire: (type: string, ev: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const canvas = {
    width: CSS_W * deviceScale,
    height: CSS_H * deviceScale,
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

describe('drag anchor / zoomAt across the interactionDpr swapchain resize', () => {
  const prevMaxDpr = QUALITY.maxDpr
  const prevInteraction = QUALITY.interactionDpr

  afterEach(() => {
    updateQuality({ maxDpr: prevMaxDpr, interactionDpr: prevInteraction })
    if (HAD_WINDOW) g.window = undefined
    else delete (globalThis as unknown as Record<string, unknown>).window
  })

  it('no-move pointermove after the canvas drops to interactionDpr is a NO-OP', () => {
    g.window = { devicePixelRatio: 2 }
    updateQuality({ maxDpr: 2, interactionDpr: 1.5 }) // `balanced` preset

    const cam = makeMercatorCamera()
    const CX = 600,
      CY = 450
    const { canvas, fire } = makeStubCanvas(2) // at rest: 1600×1200
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY
      fire('pointerdown', ptr(1, CX, CY))
      // What render-loop.ts does on the next frame once map.ts flipped
      // `_interacting`: resizeCanvas(ctx, effectiveDpr(true)) →
      // floor(css × min(2, 1.5)) = 1200×900.
      canvas.width = CSS_W * 1.5
      canvas.height = CSS_H * 1.5
      expect(canvasEffectiveDpr(canvas)).toBe(1.5)
      fire('pointermove', ptr(1, CX, CY))
      const mpp = 40075016.68557849 / 512 / Math.pow(2, 4)
      expect(
        Math.abs(cam.centerX - cx0) / mpp,
        `first move after interaction resize jumped centerX by ${(cam.centerX - cx0) / mpp} CSS px`,
      ).toBeLessThan(1)
      expect(
        Math.abs(cam.centerY - cy0) / mpp,
        `first move after interaction resize jumped centerY by ${(cam.centerY - cy0) / mpp} CSS px`,
      ).toBeLessThan(1)
    } finally {
      ctrl.detach()
    }
  })

  it('camera.zoomAt keeps the point under the cursor when the canvas is at interactionDpr', () => {
    g.window = { devicePixelRatio: 2 }
    updateQuality({ maxDpr: 2, interactionDpr: 1.5 })
    const cam = makeMercatorCamera()
    const W = CSS_W * 1.5,
      H = CSS_H * 1.5 // canvas sized at the interaction scale
    const CX = 600,
      CY = 450
    const dprReal = W / CSS_W
    const before = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
    const worldX0 = cam.centerX + before[0],
      worldY0 = cam.centerY + before[1]
    cam.zoomAt(1, CX, CY, W, H, dprReal)
    const after = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
    const worldX1 = cam.centerX + after[0],
      worldY1 = cam.centerY + after[1]
    const mpp1 = 40075016.68557849 / 512 / Math.pow(2, cam.zoom)
    expect(
      Math.abs(worldX1 - worldX0) / mpp1,
      `zoomAt anchor slipped by ${(worldX1 - worldX0) / mpp1} CSS px in X`,
    ).toBeLessThan(1)
    expect(
      Math.abs(worldY1 - worldY0) / mpp1,
      `zoomAt anchor slipped by ${(worldY1 - worldY0) / mpp1} CSS px in Y`,
    ).toBeLessThan(1)
  })
})
