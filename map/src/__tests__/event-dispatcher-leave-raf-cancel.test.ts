// Bug #9: handlePointerLeave did not cancel the pending move-coalescing rAF.
// Flicking the cursor off the canvas with a coalesced move pending caused the
// queued flushMove to fire spurious mouseenter+mousemove AFTER mouseleave,
// and left hoverPrev stale.
//
// Fail-before: schedule a move over feature F (with hoverPrev set), call
// handlePointerLeave, fire the rAF → assert NO mouseenter/mousemove fires
// and all three fields (hoverPrev, moveRafHandle, moveLatest) are null.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from '../event-dispatcher'
import type { XGISFeatureEvent } from '../layer'

// ── rAF mock (mirrors destroy-raf-and-globals.test.ts) ───────────────────────
interface MockRaf {
  callbacks: Map<number, FrameRequestCallback>
  cancelled: number[]
  fire(handle: number): void
}

function installMockRaf(): MockRaf {
  let next = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback): number => {
    const h = next++; callbacks.set(h, cb); return h
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((h: number): void => {
    cancelled.push(h); callbacks.delete(h)
  }))
  return {
    callbacks, cancelled,
    fire(h: number) {
      const cb = callbacks.get(h)
      if (cb) { callbacks.delete(h); cb(performance.now()) }
    },
  }
}

// ── deps factory ─────────────────────────────────────────────────────────────
// Records every event type dispatched through layer and map hooks.
function makeDeps(): DispatcherDeps & { fired: string[] } {
  const fired: string[] = []

  // Minimal layer stub: listens to everything, records dispatched types.
  const layer = {
    hasListeners: (_t: string) => true,
    dispatchEvent: (ev: XGISFeatureEvent) => { fired.push(ev.type) },
  }

  const feature = { id: 1, properties: {}, type: 'Feature', geometry: null }

  const pickAt = vi.fn(async () => ({ featureId: 1, layerId: 1, instanceId: 0 }))

  return {
    fired,
    pickAt,
    getLayerById: (_id: number) => layer as unknown as ReturnType<DispatcherDeps['getLayerById']>,
    buildFeature: (_lid: number, _fid: number) => feature as unknown as ReturnType<DispatcherDeps['buildFeature']>,
    clientToLngLat: (_x: number, _y: number) => [0, 0] as const,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect),
    dispatchMapEvent: (ev: XGISFeatureEvent) => { fired.push(`map:${ev.type}`) },
    mapHasListeners: (_t: string) => true,
  }
}

// Plain-object PointerEvent (node has no PointerEvent constructor).
function ptr(clientX = 100, clientY = 100): PointerEvent {
  return { clientX, clientY, timeStamp: 0 } as unknown as PointerEvent
}

// ── test ─────────────────────────────────────────────────────────────────────
describe('EventDispatcher.handlePointerLeave: cancels the pending move rAF', () => {
  let raf: MockRaf

  beforeEach(() => { raf = installMockRaf() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('no spurious mouseenter/mousemove after pointerleave + rAF flush; state fields nulled', async () => {
    const deps = makeDeps()
    const d = new EventDispatcher(deps)
    const priv = d as unknown as {
      hoverPrev: { layerId: number; featureId: number } | null
      moveRafHandle: number | null
      moveLatest: unknown
    }

    // ── step 1: settle hoverPrev onto feature F ──────────────────────────────
    // Call handleMove and fire its rAF so flushMove runs and sets hoverPrev.
    d.handleMove(100, 100, ptr())
    const firstHandle = priv.moveRafHandle!
    expect(firstHandle).not.toBeNull()
    raf.fire(firstHandle)                    // runs the rAF callback
    await Promise.resolve()                  // let flushMove's async pickAt settle
    await Promise.resolve()

    expect(priv.hoverPrev).toEqual({ layerId: 1, featureId: 1 })

    // ── step 2: queue a new move (sets moveRafHandle + moveLatest) ───────────
    deps.fired.length = 0                    // reset log — only capture what follows
    d.handleMove(110, 110, ptr(110, 110))
    const moveHandle = priv.moveRafHandle!
    expect(moveHandle).not.toBeNull()
    expect(priv.moveLatest).not.toBeNull()

    // ── step 3: pointer leaves the canvas ────────────────────────────────────
    d.handlePointerLeave({ clientX: 110, clientY: 110, timeStamp: 0 } as unknown as PointerEvent)

    // After handlePointerLeave the three move fields MUST be cleared.
    expect(priv.moveRafHandle).toBeNull()
    expect(priv.moveLatest).toBeNull()
    expect(priv.hoverPrev).toBeNull()

    // The rAF must have been cancelled (not just the handle cleared).
    expect(raf.cancelled).toContain(moveHandle)

    // ── step 4: fire the (now-cancelled) rAF handle ──────────────────────────
    // cancelAnimationFrame already removed it from callbacks, so fire() is a
    // no-op. We call it explicitly to confirm nothing survives.
    deps.fired.length = 0
    raf.fire(moveHandle)                     // no-op: callback was deleted on cancel
    await Promise.resolve()
    await Promise.resolve()

    // No mouseenter or mousemove should have been dispatched.
    const spurious = deps.fired.filter(t =>
      t === 'mouseenter' || t === 'mousemove' ||
      t === 'map:mouseenter' || t === 'map:mousemove',
    )
    expect(spurious).toEqual([])
    expect(priv.hoverPrev).toBeNull()
  })
})
