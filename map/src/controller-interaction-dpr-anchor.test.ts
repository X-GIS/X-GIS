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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** How far the world point under (CX, CY) moves during one `zoomAt`, in CSS px.
 *  `dpr === undefined` takes `Camera.zoomAt`'s DEFAULT — the quality-policy dpr. */
function anchorSlipCssPx(
  CX: number,
  CY: number,
  W: number,
  H: number,
  dpr: number | undefined,
): { x: number; y: number } {
  const cam = makeMercatorCamera()
  // Measure through the canvas's OWN scale in both arms: the oracle is where
  // the pixel under the cursor lands, which the canvas geometry decides.
  const dprReal = W / CSS_W
  const before = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
  const worldX0 = cam.centerX + before[0],
    worldY0 = cam.centerY + before[1]
  if (dpr === undefined) cam.zoomAt(1, CX, CY, W, H)
  else cam.zoomAt(1, CX, CY, W, H, dpr)
  const after = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
  const mpp = 40075016.68557849 / 512 / Math.pow(2, cam.zoom)
  return {
    x: (cam.centerX + after[0] - worldX0) / mpp,
    y: (cam.centerY + after[1] - worldY0) / mpp,
  }
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

  // TEETH for the case above (CLAUDE.md §12: an assertion carries information
  // only if it DISTINGUISHES the two states). The case above passes `dprReal`
  // explicitly, so on its own it cannot tell a canvas-read dpr from the policy
  // dpr — it would stay green if every caller went back to
  // `min(devicePixelRatio, getMaxDpr())`. This is the same call in the
  // 5-argument form, i.e. `Camera.zoomAt`'s DEFAULT `dpr = effectiveDpr()`:
  // the point under the cursor runs away by ~1/8 of the viewport, which is
  // exactly the defect the interaction-dpr fix exists to remove.
  it('the DEFAULT dpr (the quality policy) anchors the wrong point — the two dprs are distinguishable', () => {
    g.window = { devicePixelRatio: 2 }
    updateQuality({ maxDpr: 2, interactionDpr: 1.5 })
    const W = CSS_W * 1.5,
      H = CSS_H * 1.5
    const CX = 600,
      CY = 450
    const withCanvasDpr = anchorSlipCssPx(CX, CY, W, H, W / CSS_W)
    const withPolicyDpr = anchorSlipCssPx(CX, CY, W, H, undefined)
    expect(withCanvasDpr.x, `canvas-read dpr slipped ${withCanvasDpr.x} CSS px in X`).toBeLessThan(
      1,
    )
    expect(
      Math.hypot(withPolicyDpr.x, withPolicyDpr.y),
      `the policy dpr must move the anchor far enough to be unmistakable, ` +
        `got ${Math.hypot(withPolicyDpr.x, withPolicyDpr.y)} CSS px`,
    ).toBeGreaterThan(50)
  })

  // The controller half of the same contract. The two cases above drive
  // `Camera` directly, so they say nothing about whether the CONTROLLER hands
  // it the canvas-read dpr; this one goes through a real double-tap
  // (controller.ts pointerdown path) with the canvas at the interaction scale,
  // so replacing `canvasEffectiveDpr(canvas)` there with the policy dpr reds it.
  it('a double tap through the controller keeps the point under the finger at interactionDpr', () => {
    g.window = { devicePixelRatio: 2 }
    updateQuality({ maxDpr: 2, interactionDpr: 1.5 })
    const cam = makeMercatorCamera()
    const { canvas, fire } = makeStubCanvas(1.5) // already resized for the interaction
    const dprReal = canvasEffectiveDpr(canvas)
    expect(dprReal).toBe(1.5)
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      const CX = 600,
        CY = 450
      const W = canvas.width,
        H = canvas.height
      const before = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
      const worldX0 = cam.centerX + before[0],
        worldY0 = cam.centerY + before[1]
      const zoom0 = cam.zoom
      const tap = (id: number): Record<string, unknown> => ({
        ...ptr(id, CX, CY),
        pointerType: 'touch',
      })
      fire('pointerdown', tap(1))
      fire('pointerup', tap(1))
      fire('pointerdown', tap(2)) // within 300 ms and 30 px → double-tap zoom
      expect(cam.zoom, 'the double tap must have zoomed').toBeGreaterThan(zoom0)
      const after = cam.unprojectToZ0(CX * dprReal, CY * dprReal, W, H, dprReal)!
      const worldX1 = cam.centerX + after[0],
        worldY1 = cam.centerY + after[1]
      const mpp1 = 40075016.68557849 / 512 / Math.pow(2, cam.zoom)
      expect(
        Math.hypot(worldX1 - worldX0, worldY1 - worldY0) / mpp1,
        `double-tap anchor slipped by ${Math.hypot(worldX1 - worldX0, worldY1 - worldY0) / mpp1} CSS px`,
      ).toBeLessThan(1)
    } finally {
      ctrl.detach()
    }
  })

  // The APPLICATION half. `Camera.zoomAt`'s `dpr` defaults to the policy dpr
  // for the many callers that own no canvas (tests, headless camera math), so
  // an app that DOES own one and omits the argument silently gets the defect
  // the two cases above measure — which is what the site's three wheel
  // handlers did. Keyed on a directory WALK, not a path list, so moving or
  // adding a file cannot make it vacuously green (§12: a path-keyed gate dies
  // silently when the files move).
  it('no application caller of zoomAt / panToScreenAnchor omits the dpr argument', () => {
    const roots = ['site/src', 'playground/src'].map((r) => join(REPO_ROOT, r))
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
          files.push(full)
      }
    }
    for (const r of roots) walk(r)
    expect(files.length, 'the walk must find application sources').toBeGreaterThan(10)

    // (method, arity WITHOUT dpr) — a call with that many top-level arguments
    // is taking the default.
    const METHODS: Array<[string, number]> = [
      ['zoomAt', 5],
      ['panToScreenAnchor', 6],
    ]
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [method, bare] of METHODS) {
        const needle = `.${method}(`
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
          let depth = 0,
            j = i + needle.length - 1
          for (; j < text.length; j++) {
            if ('([{'.includes(text[j]!)) depth++
            else if (')]}'.includes(text[j]!)) {
              depth--
              if (depth === 0) break
            }
          }
          // Count NON-EMPTY top-level segments, not commas: prettier writes a
          // trailing comma on every multi-line call, and counting commas read
          // a 5-argument call as 6 — an instrument blind to exactly the calls
          // it exists to find, which reported a clean corpus (§12).
          const args = text.slice(i + needle.length, j)
          let d = 0,
            cur = ''
          const segments: string[] = []
          for (const ch of args) {
            if ('([{'.includes(ch)) d++
            else if (')]}'.includes(ch)) d--
            if (ch === ',' && d === 0) {
              segments.push(cur)
              cur = ''
            } else cur += ch
          }
          segments.push(cur)
          const count = segments.filter((s) => s.trim() !== '').length
          if (count <= bare) {
            const line = text.slice(0, i).split('\n').length
            offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${line} .${method}(${count} args)`)
          }
        }
      }
    }
    expect(
      offenders,
      'these callers own a canvas and let `dpr` default to the quality policy — ' +
        'pass the scale the canvas is sized at (`XGISMap.getCanvasDpr()`)',
    ).toEqual([])
  })
})
