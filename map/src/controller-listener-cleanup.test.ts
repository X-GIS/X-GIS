// ═══ PanZoomController listener-cleanup round-trip gate ═══
//
// Guards a per-rebuild canvas-listener LEAK: attach() registers handlers on the
// canvas, and detach()'s cleanup closure must remove EVERY one. switchController
// (map.ts) detaches+reconstructs a PanZoomController on every run/projection
// rebuild, and map.destroy() calls detach(); any listener attach() adds but the
// cleanup closure forgets to remove stays bound to the (dead) canvas, retaining
// the old controller closure — a leak that survives teardown.
//
// The original gap: attach() added a 'contextmenu' listener (controller.ts:189)
// whose wrapped reference was never stored, so the cleanup closure removed
// pointer*/wheel ONLY and never 'contextmenu'.
//
// This test records every (type, fn) pair added during attach() and every pair
// removed during detach(), then asserts the two MULTISETS are equal. That
// catches the missing 'contextmenu' removal AND any future unmatched listener,
// and explicitly checks 'contextmenu' was removed with the SAME function ref
// that was added.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/engine'
import { PanZoomController } from './controller'

const W = 800,
  H = 800

type Rec = { type: string; fn: (e: unknown) => void }

// Stub canvas that RECORDS every add/removeEventListener(type, fn) call (in
// addition to behaving like the GATE 2 harness canvas). Mirrors the
// HTMLCanvasElement surface the controller touches.
function makeRecordingCanvas(): {
  canvas: HTMLCanvasElement
  added: Rec[]
  removed: Rec[]
} {
  const added: Rec[] = []
  const removed: Rec[] = []
  const canvas = {
    width: W,
    height: H,
    clientWidth: W,
    clientHeight: H,
    style: {} as CSSStyleDeclaration,
    addEventListener(type: string, fn: (e: unknown) => void) {
      added.push({ type, fn })
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      removed.push({ type, fn })
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: W, bottom: H, width: W, height: H }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  return { canvas, added, removed }
}

function makeCamera(): Camera {
  const cam = new Camera(20, 30, 6)
  cam.projType = 0
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

describe('PanZoomController listener cleanup — detach() removes every listener attach() added', () => {
  it('the multiset of added (type, fn) listeners equals the multiset removed', () => {
    const cam = makeCamera()
    const { canvas, added, removed } = makeRecordingCanvas()
    const ctrl = new PanZoomController()

    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    expect(added.length, 'attach() registered no listeners — harness broken').toBeGreaterThan(0)

    ctrl.detach()

    // Tokenize a (type, fn) pair into a multiset key. Reference identity
    // matters: removeEventListener only unbinds when passed the SAME function
    // reference, so the key folds the function's identity in via a shared id
    // space (so equal refs in either array collapse to the same token).
    const idOf = new Map<(e: unknown) => void, number>()
    let next = 0
    const tokenize = (recs: Rec[]) => {
      const counts = new Map<string, number>()
      for (const { type, fn } of recs) {
        let id = idOf.get(fn)
        if (id === undefined) {
          id = next++
          idOf.set(fn, id)
        }
        const key = `${type}#${id}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return counts
    }
    const addCounts = tokenize(added)
    const remCounts = tokenize(removed)

    // Every added (type, fn) must have an equal-count removal.
    const unmatched: string[] = []
    for (const [key, n] of addCounts) {
      if ((remCounts.get(key) ?? 0) !== n) {
        const type = key.split('#')[0]
        unmatched.push(`${type} (added ${n}, removed ${remCounts.get(key) ?? 0})`)
      }
    }
    // And no removal that was never added (would indicate a ref mismatch).
    for (const [key, n] of remCounts) {
      if ((addCounts.get(key) ?? 0) !== n) {
        const type = key.split('#')[0]
        unmatched.push(
          `${type} removed-but-not-added (removed ${n}, added ${addCounts.get(key) ?? 0})`,
        )
      }
    }

    expect(
      unmatched,
      `attach()/detach() listener multisets differ — leaked/orphaned listeners: ${unmatched.join(', ')}`,
    ).toEqual([])
  })

  it("'contextmenu' is removed during detach() with the same function reference it was added with", () => {
    const cam = makeCamera()
    const { canvas, added, removed } = makeRecordingCanvas()
    const ctrl = new PanZoomController()

    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    const addedCtx = added.filter((r) => r.type === 'contextmenu')
    expect(addedCtx.length, "attach() did not add a 'contextmenu' listener").toBe(1)

    ctrl.detach()
    const removedCtx = removed.filter((r) => r.type === 'contextmenu')
    expect(removedCtx.length, "detach() did not removeEventListener('contextmenu', ...)").toBe(1)
    // Same reference — removeEventListener only unbinds when passed the exact fn.
    expect(
      removedCtx[0].fn,
      "'contextmenu' was removed with a DIFFERENT function reference than it was added with (removeEventListener would no-op)",
    ).toBe(addedCtx[0].fn)
  })
})
