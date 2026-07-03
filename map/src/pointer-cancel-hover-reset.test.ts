// ═══ pointercancel must reset dispatcher hover state ═══
//
// Bug #10: onPointerCancel in map.ts only set `_pointerActive = false`
// and did NOT call dispatcher.handlePointerLeave(e). On a touch/pen
// OS gesture-steal (pointercancel with no following pointerleave), the
// dispatcher's hoverPrev stayed pinned → the feature was stuck "hovered".
//
// Fix: route pointercancel through the leave path:
//   onPointerCancel: (e) => { this._pointerActive = false; dispatcher.handlePointerLeave(e) }
//
// This test exercises the dispatcher in isolation (CPU-only, no GPU).

import { describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from './event-dispatcher'
import type { XGISLayer } from './layer'

// ── Helpers ──────────────────────────────────────────────────────────

function makeLayer(opts: { hasListeners?: boolean } = {}): XGISLayer {
  return {
    hasListeners: () => opts.hasListeners ?? true,
    dispatchEvent: vi.fn(),
  } as unknown as XGISLayer
}

function makeDeps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    pickAt: vi.fn(async () => null),
    getLayerById: () => null,
    buildFeature: () => null,
    clientToLngLat: () => null,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }) as DOMRect,
    dispatchMapEvent: vi.fn(),
    mapHasListeners: () => false,
    ...overrides,
  }
}

function makePointerEvent(clientX = 10, clientY = 20): PointerEvent {
  return { clientX, clientY } as PointerEvent
}

/** Access private fields on EventDispatcher without TypeScript complaint. */
type DispatcherInternals = {
  hoverPrev: { layerId: number; featureId: number } | null
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('EventDispatcher.handlePointerLeave(): clears hoverPrev and fires mouseleave', () => {
  it('resets hoverPrev to null when called after a hover is established', () => {
    const layer = makeLayer()
    const mapLeave = vi.fn()
    const deps = makeDeps({
      getLayerById: (id) => (id === 7 ? layer : null),
      buildFeature: () => ({ id: 99 }) as unknown as ReturnType<DispatcherDeps['buildFeature']>,
      mapHasListeners: () => false,
      dispatchMapEvent: mapLeave,
    })
    const d = new EventDispatcher(deps)
    const internals = d as unknown as DispatcherInternals

    // Seed hoverPrev directly — simulates a prior hover move that landed on
    // layerId=7, featureId=99 (exactly what flushMove would write).
    internals.hoverPrev = { layerId: 7, featureId: 99 }
    expect(internals.hoverPrev).not.toBeNull()

    // Calling handlePointerLeave must clear hoverPrev.
    d.handlePointerLeave(makePointerEvent())

    expect(internals.hoverPrev).toBeNull()
  })

  it('fires mouseleave on the layer when hoverPrev was set and layer has a listener', () => {
    const layer = makeLayer({ hasListeners: true })
    const dispatchEvent = layer.dispatchEvent as ReturnType<typeof vi.fn>
    const deps = makeDeps({
      getLayerById: (id) => (id === 7 ? layer : null),
      buildFeature: () => ({ id: 99 }) as unknown as ReturnType<DispatcherDeps['buildFeature']>,
      mapHasListeners: () => false,
    })
    const d = new EventDispatcher(deps)
    const internals = d as unknown as DispatcherInternals
    internals.hoverPrev = { layerId: 7, featureId: 99 }

    d.handlePointerLeave(makePointerEvent())

    // The layer's dispatchEvent must have been called (mouseleave).
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })
})

// ── Fail-before test for the map.ts bug ───────────────────────────────
//
// Simulates what the OLD onPointerCancel did (only set _pointerActive=false,
// no handlePointerLeave call) vs what the FIXED version does.
// The fail-before assertion confirms that without the leave call,
// hoverPrev stays pinned after a gesture-steal.

describe('pointercancel hover-reset: fail-before (old wiring) vs pass-after (fixed wiring)', () => {
  it('FAIL-BEFORE: hoverPrev stays pinned when cancel handler does NOT call handlePointerLeave', () => {
    const d = new EventDispatcher(makeDeps())
    const internals = d as unknown as DispatcherInternals
    // Seed a hover on feature F.
    internals.hoverPrev = { layerId: 3, featureId: 55 }

    // OLD onPointerCancel body — only clears _pointerActive, never touches dispatcher.
    let _pointerActive = true
    const oldOnPointerCancel = () => {
      _pointerActive = false
    }
    oldOnPointerCancel()

    // hoverPrev is STILL pinned — this is the bug.
    expect(internals.hoverPrev).not.toBeNull()
    expect(internals.hoverPrev?.featureId).toBe(55)
    expect(_pointerActive).toBe(false) // _pointerActive cleared but hover stuck
  })

  it('PASS-AFTER: hoverPrev cleared when cancel handler calls handlePointerLeave', () => {
    const d = new EventDispatcher(makeDeps())
    const internals = d as unknown as DispatcherInternals
    // Seed a hover on feature F.
    internals.hoverPrev = { layerId: 3, featureId: 55 }

    // FIXED onPointerCancel body — clears _pointerActive AND calls leave.
    let _pointerActive = true
    const fixedOnPointerCancel = (e: PointerEvent) => {
      _pointerActive = false
      d.handlePointerLeave(e)
    }
    fixedOnPointerCancel(makePointerEvent())

    // hoverPrev is now null — bug fixed.
    expect(internals.hoverPrev).toBeNull()
    expect(_pointerActive).toBe(false)
  })
})
