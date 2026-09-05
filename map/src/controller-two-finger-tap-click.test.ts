// ═══ GATE — a multi-touch gesture never resolves as a `click` ═══
//
// hunt 2026-09-02: a clean two-finger TOUCH tap fired onClick, because the
// `activePointers.size === 2` pointerdown branch reset the rotate/pinch state
// but never cleared `pressEligible` — the latch armed by the FIRST finger's
// single-pointer pointerdown survived into multi-touch, so the first pointerup
// passed the click gate (zero travel, rotateActivated already reset).
// #2296: controller.ts documents multi-touch as click-ineligible, and
// MapLibre/Mapbox emit no `click` for a two-finger tap.
//
// Same stub-canvas harness as controller-gesture-raf-gate.test.ts (real
// listeners, synthetic plain-object PointerEvents, real Camera).

import { describe, it, expect, vi } from 'vitest'
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
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev)
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

function touch(pointerId: number, clientX: number, clientY: number): Record<string, unknown> {
  return {
    pointerId,
    clientX,
    clientY,
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    pointerType: 'touch',
    preventDefault() {},
    stopPropagation() {},
  }
}

function attach() {
  const { canvas, fire } = makeStubCanvas()
  const controller = new PanZoomController()
  const onClick = vi.fn()
  controller.attach(canvas, makeFlatCamera(), () => ({ projectionName: 'mercator' }), { onClick })
  return { fire, onClick, controller }
}

describe('#2296 — two-finger tap must not fire onClick', () => {
  it('CONTROL: a single-finger touch tap still fires onClick exactly once', () => {
    const { fire, onClick } = attach()
    fire('pointerdown', touch(1, 100, 100))
    fire('pointerup', touch(1, 100, 100))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0]?.[0]).toBe(100)
    expect(onClick.mock.calls[0]?.[1]).toBe(100)
  })

  it('a clean two-finger tap (down1, down2, up1, up2; zero travel) fires NO onClick', () => {
    const { fire, onClick } = attach()
    fire('pointerdown', touch(1, 100, 100))
    fire('pointerdown', touch(2, 300, 300))
    fire('pointerup', touch(1, 100, 100))
    fire('pointerup', touch(2, 300, 300))
    expect(
      onClick,
      `two-finger tap fired onClick ${onClick.mock.calls.length}x at ${JSON.stringify(
        onClick.mock.calls.map((c) => [c[0], c[1]]),
      )} — multi-touch is click-ineligible`,
    ).not.toHaveBeenCalled()
  })

  it('two-finger tap lifted in the other order (up2 first, then up1) fires NO onClick', () => {
    const { fire, onClick } = attach()
    fire('pointerdown', touch(1, 100, 100))
    fire('pointerdown', touch(2, 300, 300))
    fire('pointerup', touch(2, 300, 300))
    fire('pointerup', touch(1, 100, 100))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('a three-finger tap fires NO onClick in any lift order', () => {
    const { fire, onClick } = attach()
    fire('pointerdown', touch(1, 100, 100))
    fire('pointerdown', touch(2, 300, 300))
    fire('pointerdown', touch(3, 500, 500))
    fire('pointerup', touch(3, 500, 500))
    fire('pointerup', touch(1, 100, 100))
    fire('pointerup', touch(2, 300, 300))
    expect(onClick).not.toHaveBeenCalled()
  })
})
