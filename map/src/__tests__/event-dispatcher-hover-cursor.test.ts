// ═══ Hover→cursor hook (#1263) — onHoverActiveChange fires on null⇄hit only ═══
//
// The built-in `pointer` cursor needs one bit from the dispatcher: is ANY
// feature under the pointer right now? The dispatcher already computes that in
// its hover flush (`hoverPrev`); this pins that it PUSHES the bit via
// `onHoverActiveChange`, and only on the boolean transition — not once per
// coalesced move, and never for a map with no hover listeners (rides the
// existing pre-pick gate, so a no-listener map still pays zero readbacks).
//
// Fail-before: `onHoverActiveChange` did not exist on DispatcherDeps and the
// flush never called it — the spy stayed at 0 calls.
//
// CPU-only: pickAt is a spy; rAF is mocked; no GPU, no device.

import { describe, expect, it, vi } from 'vitest'
import { EventDispatcher, type DispatcherDeps } from '../event-dispatcher'
import type { XGISFeature, XGISFeatureEvent, XGISLayer } from '../layer'

function installMockRaf() {
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
    vi.fn((h: number): void => void callbacks.delete(h)),
  )
  return {
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

type Hit = { featureId: number; layerId: number; instanceId: number } | null

function makeDeps(hit: () => Hit, hoverListeners: boolean) {
  const onHoverActiveChange = vi.fn()
  const layer = {
    hasListeners: () => hoverListeners,
    dispatchEvent: vi.fn(),
  } as unknown as XGISLayer
  const deps: DispatcherDeps = {
    pickAt: vi.fn(async () => hit()),
    getLayerById: () => layer,
    buildFeature: () =>
      ({ id: 1, type: 'Feature', properties: {}, geometry: null }) as unknown as XGISFeature,
    clientToLngLat: () => [0, 0] as const,
    getCanvasRect: () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect,
    dispatchMapEvent: vi.fn() as unknown as (e: XGISFeatureEvent) => void,
    mapHasListeners: () => false,
    anyLayerListens: () => hoverListeners,
    onHoverActiveChange,
  }
  return { deps, onHoverActiveChange }
}

const ev = () => ({ clientX: 12, clientY: 12, timeStamp: 0 }) as unknown as PointerEvent
const HIT: Hit = { featureId: 1, layerId: 1, instanceId: 0 }

async function move(d: EventDispatcher, raf: ReturnType<typeof installMockRaf>) {
  d.handleMove(12, 12, ev())
  for (const h of raf.pending()) raf.fire(h)
  await new Promise<void>((r) => setTimeout(r, 0)) // drain the async flush
}

describe('#1263 hover→cursor hook', () => {
  it('fires true on enter, false on leave — one call per transition', async () => {
    const raf = installMockRaf()
    let hit: Hit = HIT
    const { deps, onHoverActiveChange } = makeDeps(() => hit, true)
    const d = new EventDispatcher(deps)

    await move(d, raf) // null → hit
    expect(onHoverActiveChange.mock.calls).toEqual([[true]])

    await move(d, raf) // hit → hit (same feature): no new call
    expect(onHoverActiveChange.mock.calls).toEqual([[true]])

    hit = null
    await move(d, raf) // hit → null
    expect(onHoverActiveChange.mock.calls).toEqual([[true], [false]])

    vi.unstubAllGlobals()
  })

  it('no hover listeners ⇒ never picks and never reports hover', async () => {
    const raf = installMockRaf()
    const { deps, onHoverActiveChange } = makeDeps(() => HIT, false)
    const d = new EventDispatcher(deps)
    await move(d, raf)
    expect(deps.pickAt).toHaveBeenCalledTimes(0)
    expect(onHoverActiveChange).toHaveBeenCalledTimes(0)
    vi.unstubAllGlobals()
  })

  it('pointerleave while hovering reports inactive', async () => {
    const raf = installMockRaf()
    const { deps, onHoverActiveChange } = makeDeps(() => HIT, true)
    const d = new EventDispatcher(deps)
    await move(d, raf)
    expect(onHoverActiveChange.mock.calls).toEqual([[true]])
    d.handlePointerLeave(ev())
    expect(onHoverActiveChange.mock.calls).toEqual([[true], [false]])
    vi.unstubAllGlobals()
  })
})
