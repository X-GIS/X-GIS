// hunt 2026-09-02 (#2297): a hover pick that RESOLVES after pointerleave must be
// dropped — no mouseenter/mousemove, hoverPrev stays null, no hover=true.
//
// handlePointerLeave can only cancel a NOT-YET-FIRED move rAF. Once the rAF
// callback has started flushMove, the pick is in flight (~1 frame of mapAsync
// readback in interaction-controller.ts) and the leave has no way to invalidate
// it; flushMove then read hoverPrev AFTER the await and dispatched against a
// pointer that had already left, pinning the `pointer` cursor off-canvas.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from '../event-dispatcher'
import type { XGISFeatureEvent } from '../layer'

// ── rAF mock (mirrors event-dispatcher-leave-raf-cancel.test.ts) ─────────────
interface MockRaf {
  callbacks: Map<number, FrameRequestCallback>
  fire(handle: number): void
}

function installMockRaf(): MockRaf {
  let next = 1
  const callbacks = new Map<number, FrameRequestCallback>()
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
      callbacks.delete(h)
    }),
  )
  return {
    callbacks,
    fire(h: number) {
      const cb = callbacks.get(h)
      if (cb) {
        callbacks.delete(h)
        cb(performance.now())
      }
    },
  }
}

type Hit = { featureId: number; layerId: number; instanceId: number }

// ── deps factory: pickAt is DEFERRED, so the test controls the moment the
// readback answers relative to the leave. ────────────────────────────────────
function makeDeps(): DispatcherDeps & {
  fired: string[]
  hoverActive: boolean[]
  resolvePick: (hit: Hit | null) => void
} {
  const fired: string[] = []
  const hoverActive: boolean[] = []
  let resolvePick: (hit: Hit | null) => void = () => {}

  const layer = {
    hasListeners: (_t: string) => true,
    dispatchEvent: (ev: XGISFeatureEvent) => {
      fired.push(ev.type)
    },
  }

  const feature = { id: 7, properties: {}, type: 'Feature', geometry: null }

  return {
    fired,
    hoverActive,
    resolvePick: (hit) => resolvePick(hit),
    pickAt: () =>
      new Promise<Hit | null>((r) => {
        resolvePick = r
      }),
    getLayerById: (_id: number) => layer as unknown as ReturnType<DispatcherDeps['getLayerById']>,
    buildFeature: (_lid: number, _fid: number) =>
      feature as unknown as ReturnType<DispatcherDeps['buildFeature']>,
    clientToLngLat: (_x: number, _y: number) => [0, 0] as const,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect,
    dispatchMapEvent: (ev: XGISFeatureEvent) => {
      fired.push(`map:${ev.type}`)
    },
    mapHasListeners: (_t: string) => false,
    anyLayerListens: (_t: string) => true,
    onHoverActiveChange: (active: boolean) => {
      hoverActive.push(active)
    },
  }
}

// Plain-object PointerEvent (node has no PointerEvent constructor).
function ptr(clientX = 100, clientY = 100): PointerEvent {
  return { clientX, clientY, timeStamp: 0 } as unknown as PointerEvent
}

interface DispatcherPrivates {
  hoverPrev: { layerId: number; featureId: number } | null
  moveRafHandle: number | null
}

// Start a move and let the rAF fire so flushMove is parked on the deferred pick.
async function startInFlightPick(d: EventDispatcher, priv: DispatcherPrivates, raf: MockRaf) {
  d.handleMove(100, 100, ptr())
  const handle = priv.moveRafHandle!
  expect(handle).not.toBeNull()
  raf.fire(handle)
  await Promise.resolve()
}

describe('EventDispatcher.flushMove: pick resolving after hover state is invalidated', () => {
  let raf: MockRaf

  beforeEach(() => {
    raf = installMockRaf()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops the stale hit after pointerleave: no mouseenter/mousemove, hoverPrev null, no hover=true', async () => {
    const deps = makeDeps()
    const d = new EventDispatcher(deps)
    const priv = d as unknown as DispatcherPrivates

    await startInFlightPick(d, priv, raf)

    // Pointer leaves the canvas while the readback is still in flight.
    d.handlePointerLeave(ptr(-1, -1))
    expect(priv.hoverPrev).toBeNull()
    expect(priv.moveRafHandle).toBeNull()

    // The readback answers AFTER the leave.
    deps.resolvePick({ featureId: 7, layerId: 1, instanceId: 0 })
    await new Promise((r) => setTimeout(r, 0))

    expect({ fired: deps.fired, hoverPrev: priv.hoverPrev, hoverActive: deps.hoverActive }).toEqual(
      {
        fired: [],
        hoverPrev: null,
        hoverActive: [],
      },
    )
  })

  it('drops the stale hit after destroy(): nothing dispatched against a torn-down device', async () => {
    const deps = makeDeps()
    const d = new EventDispatcher(deps)
    const priv = d as unknown as DispatcherPrivates

    await startInFlightPick(d, priv, raf)

    d.destroy()

    deps.resolvePick({ featureId: 7, layerId: 1, instanceId: 0 })
    await new Promise((r) => setTimeout(r, 0))

    expect({ fired: deps.fired, hoverPrev: priv.hoverPrev, hoverActive: deps.hoverActive }).toEqual(
      {
        fired: [],
        hoverPrev: null,
        hoverActive: [],
      },
    )
  })
})
