// ═══ destroy() completeness — RAF use-after-destroy + global leaks ═══
//
//  Three teardown gaps map.destroy() previously left open:
//
//  1. pointermove RAF use-after-destroy — EventDispatcher coalesces moves
//     into a requestAnimationFrame with NO cancel path, and destroy() never
//     touched the dispatcher. A pending move-rAF fired AFTER destroy →
//     flushMove → pickAt → copyTextureToBuffer/submit on the DESTROYED
//     GPUDevice. Fix: EventDispatcher.destroy() cancels the rAF; map.destroy
//     calls it; pickAt() is _destroyed-guarded as defense-in-depth.
//  2. flush RAF leak — scheduleFlushPendingUpdates stored _pendingFlushHandle
//     that destroy() never cancelled (~1-frame GC pin). Fix: destroy()
//     cancels it + clears _pendingPatches.
//  3. window globals — run() installs __xgisSnapshot/__xgisReplaySnapshot/
//     __xgisStartDrawOrderTrace closures (capturing the map) + __xgisReady=
//     true, and destroy() cleared none → GC pin + stale ready signal. Fix:
//     destroy() deletes the three closures + sets __xgisReady=false.
//
// GPU-free: the EventDispatcher is exercised in isolation with plain deps,
// and XGISMap is built through the same stubCanvas harness as p0-quartet
// (no run() → no real GPU). pickAt's _destroyed guard short-circuits before
// it ever touches the InteractionController, so no device is needed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from '@xgis/map'
import { XGISMap } from '@xgis/map'

// ── Shared mock RAF: records handles, does NOT auto-fire ─────────────
//
// requestAnimationFrame returns an incrementing handle and stashes the
// callback so a test can fire it manually (or, crucially, NOT fire it to
// simulate a frame that lands after destroy()). cancelAnimationFrame
// records every handle it was asked to cancel.

interface MockRaf {
  requestAnimationFrame: ReturnType<typeof vi.fn>
  cancelAnimationFrame: ReturnType<typeof vi.fn>
  callbacks: Map<number, FrameRequestCallback>
  cancelled: number[]
  fire(handle: number): void
}

function installMockRaf(): MockRaf {
  let nextHandle = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  const requestAnimationFrame = vi.fn((cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    callbacks.set(handle, cb)
    return handle
  })
  const cancelAnimationFrame = vi.fn((handle: number): void => {
    cancelled.push(handle)
    callbacks.delete(handle)
  })
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    callbacks,
    cancelled,
    fire(handle: number) {
      const cb = callbacks.get(handle)
      if (cb) {
        callbacks.delete(handle)
        cb(performance.now())
      }
    },
  }
}

// Plain non-GPU deps — every hook is a callback. pickAt is a spy so we can
// assert it does (or does not) run from a flushed move.
function makeDeps(pickAt: DispatcherDeps['pickAt']): DispatcherDeps {
  return {
    pickAt,
    getLayerById: () => null,
    buildFeature: () => null,
    clientToLngLat: () => null,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }) as DOMRect,
    dispatchMapEvent: () => {},
    mapHasListeners: () => false,
  }
}

// ── 1. EventDispatcher.destroy() in isolation ────────────────────────

describe('EventDispatcher.destroy(): cancels the move-coalescing rAF', () => {
  let raf: MockRaf
  beforeEach(() => {
    raf = installMockRaf()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a pending move-rAF is cancelled (handle passed to cancelAnimationFrame) and never fires pickAt', () => {
    const pickAt = vi.fn(async () => null)
    const d = new EventDispatcher(makeDeps(pickAt))
    const internals = d as unknown as {
      moveRafHandle: number | null
      moveLatest: unknown
      hoverPrev: unknown
    }

    // Schedule a move — handle stored, rAF NOT yet fired.
    d.handleMove(10, 20, {} as PointerEvent)
    const handle = internals.moveRafHandle
    expect(handle).not.toBeNull()
    expect(raf.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(raf.cancelled).toEqual([]) // FAIL-BEFORE: nothing cancelled yet

    // Teardown BEFORE the frame lands.
    d.destroy()

    // The exact handle was cancelled, state nulled.
    expect(raf.cancelled).toContain(handle)
    expect(internals.moveRafHandle).toBeNull()
    expect(internals.moveLatest).toBeNull()
    expect(internals.hoverPrev).toBeNull()

    // Even if a stray frame callback were somehow invoked, the queued
    // payload is gone, so no pickAt round-trip can run post-destroy.
    expect(pickAt).not.toHaveBeenCalled()
  })

  it('is idempotent and a no-op when no move was ever scheduled', () => {
    const d = new EventDispatcher(makeDeps(vi.fn(async () => null)))
    expect(() => {
      d.destroy()
      d.destroy()
    }).not.toThrow()
    expect(raf.cancelAnimationFrame).not.toHaveBeenCalled()
  })
})

// ── 2 + 3. XGISMap.destroy() integration via the stubCanvas harness ──

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

interface MapInternals {
  _destroyed: boolean
  _pendingFlushHandle: number | null
  _pendingPatches: Map<string, unknown>
  eventDispatcher: EventDispatcher | null
}

describe('XGISMap.destroy(): RAF + global teardown', () => {
  let raf: MockRaf
  let win: Record<string, unknown>

  beforeEach(() => {
    raf = installMockRaf()
    // The vitest env is `node` (no jsdom — confirmed: typeof window ===
    // 'undefined'). map.ts gates BOTH its flush-rAF cancel and its window-
    // globals teardown on `typeof window !== 'undefined'`, so to exercise
    // those paths we stub a minimal window. Its RAF/CAF point at the same
    // mocks the global RAF uses (the dispatcher uses the bare globals; the
    // map uses window.*), so one `cancelled` list captures both. matchMedia
    // is intentionally absent so attachAutoResize's DPR branch no-ops; the
    // ctor's only window touch is attachAutoResize, which is null-safe.
    win = {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      devicePixelRatio: 1,
      __xgisReady: true,
      __xgisSnapshot: () => Promise.resolve(),
      __xgisStartDrawOrderTrace: () => {},
      __xgisReplaySnapshot: () => Promise.resolve(),
    }
    vi.stubGlobal('window', win)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels _pendingFlushHandle, clears _pendingPatches, tears down the dispatcher, clears window globals; pickAt → null', async () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as MapInternals

    // (2) Arm a pending flush rAF + a queued patch, as updateFeature would.
    //     Go through window.requestAnimationFrame so the handle matches the
    //     primitive scheduleFlushPendingUpdates uses (window present → rAF).
    m._pendingFlushHandle = (win.requestAnimationFrame as MockRaf['requestAnimationFrame'])(
      () => {},
    ) as unknown as number
    m._pendingPatches.set('src', new Map())
    const flushHandle = m._pendingFlushHandle

    // (1) Inject a real EventDispatcher and arm its move-rAF so we can prove
    //     map.destroy() forwards into EventDispatcher.destroy(). (A bare
    //     XGISMap has a null dispatcher until run(), which needs a GPU.)
    const dispatcher = new EventDispatcher(makeDeps(vi.fn(async () => null)))
    m.eventDispatcher = dispatcher
    dispatcher.handleMove(5, 5, {} as PointerEvent)
    const moveHandle = (dispatcher as unknown as { moveRafHandle: number | null }).moveRafHandle
    expect(moveHandle).not.toBeNull()

    map.destroy()

    // (2) flush rAF cancelled with its exact handle; patches + handle dropped.
    expect(raf.cancelled).toContain(flushHandle)
    expect(m._pendingFlushHandle).toBeNull()
    expect(m._pendingPatches.size).toBe(0)

    // (1) dispatcher torn down (its move-rAF cancelled) and field nulled.
    expect(raf.cancelled).toContain(moveHandle)
    expect(m.eventDispatcher).toBeNull()
    expect((dispatcher as unknown as { moveRafHandle: number | null }).moveRafHandle).toBeNull()

    // (1) pickAt guarded post-destroy.
    expect(m._destroyed).toBe(true)
    await expect(map.pickAt(1, 1)).resolves.toBeNull()

    // (3) window globals cleared, ready signal reset.
    expect(win.__xgisReady).toBe(false)
    expect(win.__xgisSnapshot).toBeUndefined()
    expect(win.__xgisStartDrawOrderTrace).toBeUndefined()
    expect(win.__xgisReplaySnapshot).toBeUndefined()
  })
})
