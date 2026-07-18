// ═══ The dispatcher must not pay a GPU pick to discover nobody listened ═══
//
// THE DEFECT (fail-before). `EventDispatcher.fireOnce` ran
// `await this.deps.pickAt(...)` as its FIRST statement and only then asked
// whether the layer / map had a listener. `pickAt` is a GPU readback —
// copyTextureToBuffer + queue.submit + `await mapAsync`, "the ~1-frame mapAsync
// window" per interaction-controller.ts's own comment; on webgl2 it is a
// SYNCHRONOUS texel read. So every click / pointerdown / pointerup / wheel on a
// picking-enabled map paid a round-trip even with zero listeners registered.
//
// The dep's own doc already promised otherwise — `mapHasListeners` is documented
// as letting the dispatcher "skip the pickAt/buildFeature path entirely when
// neither the topmost layer nor the map have a listener". It could not: answering
// "does the HIT layer listen?" needs the hit. The fix adds `anyLayerListens` — a
// coarse, hit-free "could anyone fire this?" — and gates before the pick.
//
// AND (D2) `handleWheel` fired one pick per wheel event while its sibling
// `handleMove` rAF-coalesces. A trackpad outruns the readback, so unbatched picks
// pile up and `mapAsync` rejects the overlaps ("still mapped (rapid re-pick)") —
// dropping the very events it was serving.
//
// WHY T2/T3 EXIST. T1 alone is passable by a WRONG fix: gate on only one of the
// two listener sources and T1 still goes green while real events stop firing.
// T2 (map listens, layer does not) and T3 (layer listens, map does not) lock both
// directions. T3 additionally pins the POST-pick per-layer check — the pre-gate is
// coarse ("someone listens"), so deleting the per-layer check as "redundant" would
// fire events at layers that never registered one.
//
// CPU-only: no GPU, no device. pickAt is a spy.

import { describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from '../event-dispatcher'
import type { XGISFeature, XGISFeatureEvent, XGISLayer } from '../layer'

interface MockRaf {
  callbacks: Map<number, FrameRequestCallback>
  cancelled: number[]
  fire(handle: number): void
  pending(): number[]
}

function installMockRaf(): MockRaf {
  let next = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback): number => {
      const h = next++
      callbacks.set(h, cb)
      return h
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((h: number): void => {
      cancelled.push(h)
      callbacks.delete(h)
    }),
  )
  return {
    callbacks,
    cancelled,
    pending: () => [...callbacks.keys()],
    fire(h: number) {
      const cb = callbacks.get(h)
      if (cb) {
        callbacks.delete(h)
        cb(0)
      }
    },
  }
}

function makeDeps(o: Partial<DispatcherDeps> & { layerListens?: boolean } = {}) {
  const layerDispatch = vi.fn()
  const layer = {
    hasListeners: () => o.layerListens ?? false,
    dispatchEvent: layerDispatch,
  } as unknown as XGISLayer
  const pickAt = vi.fn(async () => ({ featureId: 1, layerId: 1, instanceId: 0 }))
  const dispatchMapEvent = vi.fn()
  const deps: DispatcherDeps = {
    pickAt,
    getLayerById: () => layer,
    buildFeature: () =>
      ({ id: 1, type: 'Feature', properties: {}, geometry: null }) as unknown as XGISFeature,
    clientToLngLat: () => [0, 0] as const,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect,
    dispatchMapEvent: dispatchMapEvent as unknown as (e: XGISFeatureEvent) => void,
    mapHasListeners: () => false,
    anyLayerListens: () => false,
    ...o,
  }
  return { deps, pickAt, dispatchMapEvent, layerDispatch }
}

const ev = () => ({ clientX: 12, clientY: 12, timeStamp: 0 }) as unknown as PointerEvent
const wev = (x = 12, y = 12) =>
  ({ clientX: x, clientY: y, deltaY: -120, timeStamp: 0 }) as unknown as WheelEvent

describe('pre-pick listener gate (#pick-readback)', () => {
  // T1 — THE fail-before. Today every one of these awaits pickAt first.
  for (const kind of ['click', 'pointerdown', 'pointerup'] as const) {
    it(`${kind}: no listeners anywhere ⇒ pickAt is never called`, async () => {
      const { deps, pickAt } = makeDeps({
        mapHasListeners: () => false,
        anyLayerListens: () => false,
        layerListens: false,
      })
      const d = new EventDispatcher(deps)
      if (kind === 'click') await d.handleClick(12, 12, ev())
      if (kind === 'pointerdown') await d.handlePointerDown(12, 12, ev())
      if (kind === 'pointerup') await d.handlePointerUp(12, 12, ev())
      expect(pickAt).toHaveBeenCalledTimes(0)
    })
  }

  it('wheel: no listeners anywhere ⇒ pickAt is never called', () => {
    const raf = installMockRaf()
    const { deps, pickAt } = makeDeps({
      mapHasListeners: () => false,
      anyLayerListens: () => false,
      layerListens: false,
    })
    const d = new EventDispatcher(deps)
    d.handleWheel(12, 12, wev())
    for (const h of raf.pending()) raf.fire(h)
    expect(pickAt).toHaveBeenCalledTimes(0)
    vi.unstubAllGlobals()
  })

  // T2 — ANTI-VACUITY. A fix that gates on anyLayerListens ALONE breaks this.
  it('map listens but no layer does ⇒ pick still runs and the map still gets the event', async () => {
    const { deps, pickAt, dispatchMapEvent } = makeDeps({
      mapHasListeners: () => true,
      anyLayerListens: () => false,
      layerListens: false,
    })
    await new EventDispatcher(deps).handleClick(12, 12, ev())
    expect(pickAt).toHaveBeenCalledTimes(1)
    expect(dispatchMapEvent).toHaveBeenCalledTimes(1)
  })

  // T3 — ANTI-VACUITY. A fix that gates on mapHasListeners ALONE breaks this.
  // Also pins the POST-pick per-layer check (see header).
  it('a layer listens but the map does not ⇒ pick runs and the layer gets the event', async () => {
    const { deps, pickAt, layerDispatch } = makeDeps({
      mapHasListeners: () => false,
      anyLayerListens: () => true,
      layerListens: true,
    })
    await new EventDispatcher(deps).handleClick(12, 12, ev())
    expect(pickAt).toHaveBeenCalledTimes(1)
    expect(layerDispatch).toHaveBeenCalledTimes(1)
  })

  // T3b — the pre-gate is COARSE. Some layer listens, but not the one we hit:
  // the pick must run, and nothing may be dispatched.
  it('some other layer listens but the HIT layer does not ⇒ pick runs, nothing dispatched', async () => {
    const { deps, pickAt, layerDispatch, dispatchMapEvent } = makeDeps({
      mapHasListeners: () => false,
      anyLayerListens: () => true,
      layerListens: false,
    })
    await new EventDispatcher(deps).handleClick(12, 12, ev())
    expect(pickAt).toHaveBeenCalledTimes(1)
    expect(layerDispatch).toHaveBeenCalledTimes(0)
    expect(dispatchMapEvent).toHaveBeenCalledTimes(0)
  })
})

describe('wheel rAF coalescing (#pick-readback)', () => {
  // T4 — today: 3 synchronous picks, before any rAF.
  it('three wheels in one frame ⇒ one pick, with the LAST coordinates', async () => {
    const raf = installMockRaf()
    const { deps, pickAt } = makeDeps({
      mapHasListeners: () => true,
      anyLayerListens: () => true,
      layerListens: true,
    })
    const d = new EventDispatcher(deps)
    d.handleWheel(10, 10, wev(10, 10))
    d.handleWheel(11, 11, wev(11, 11))
    d.handleWheel(12, 12, wev(12, 12))
    expect(pickAt, 'no pick may run before the frame boundary').toHaveBeenCalledTimes(0)
    for (const h of raf.pending()) raf.fire(h)
    await Promise.resolve()
    expect(pickAt).toHaveBeenCalledTimes(1)
    expect(pickAt).toHaveBeenLastCalledWith(12, 12)
    vi.unstubAllGlobals()
  })

  // T5 — a pending wheel rAF must not fire pickAt at a destroyed device.
  it('destroy() cancels a pending wheel rAF', () => {
    const raf = installMockRaf()
    const { deps, pickAt } = makeDeps({
      mapHasListeners: () => true,
      anyLayerListens: () => true,
      layerListens: true,
    })
    const d = new EventDispatcher(deps)
    d.handleWheel(12, 12, wev())
    const pending = raf.pending()
    expect(pending.length, 'a wheel must have scheduled exactly one rAF').toBe(1)
    d.destroy()
    expect(raf.cancelled).toContain(pending[0])
    for (const h of raf.pending()) raf.fire(h)
    expect(pickAt).toHaveBeenCalledTimes(0)
    vi.unstubAllGlobals()
  })
})

describe('hover pre-gate (#pick-readback)', () => {
  // flushMove had the same defect, and it matters MORE: rAF-coalesced means one
  // readback per FRAME for as long as the pointer moves, not just wheel bursts.
  it('no hover listeners ⇒ a pointermove flush never picks', async () => {
    const raf = installMockRaf()
    const { deps, pickAt } = makeDeps({
      mapHasListeners: () => false,
      anyLayerListens: () => false,
      layerListens: false,
    })
    const d = new EventDispatcher(deps)
    d.handleMove(12, 12, ev())
    for (const h of raf.pending()) raf.fire(h)
    await Promise.resolve()
    expect(pickAt).toHaveBeenCalledTimes(0)
    vi.unstubAllGlobals()
  })
})
