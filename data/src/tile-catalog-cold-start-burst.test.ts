// #1155 F3 — TileCatalog.resetCompileBudget() ticks every attached backend with
// the per-frame compile-dispatch budget. Steady state passes _TICK_BUDGET (2);
// while the cold-start burst flag is on it passes 16 so the first-viewport tile
// cascade dispatches to the worker pool in a couple of frames instead of ~8.
// setColdStartBurst(false) restores the steady 2 exactly.

import { describe, expect, it } from 'vitest'
import { TileCatalog } from './tile-catalog'
import type { TileSource } from './tile-source'

/** Minimal backend that records the maxOps its tick() was called with. Only the
 *  fields TileCatalog.attachBackend / resetCompileBudget touch are populated. */
function makeRecordingBackend(): { backend: TileSource; ticks: number[] } {
  const ticks: number[] = []
  const backend = {
    meta: {
      maxZoom: 14,
      minZoom: 0,
      bounds: [-180, -85, 180, 85] as [number, number, number, number],
    },
    attach: () => {},
    has: () => false,
    loadTile: () => {},
    tick: (maxOps: number) => {
      ticks.push(maxOps)
    },
  } as unknown as TileSource
  return { backend, ticks }
}

describe('TileCatalog — cold-start burst tick budget (#1155 F3)', () => {
  it('steady state ticks backends with 2', () => {
    const catalog = new TileCatalog()
    const { backend, ticks } = makeRecordingBackend()
    catalog.attachBackend(backend)
    catalog.resetCompileBudget()
    expect(ticks.at(-1)).toBe(2)
  })

  it('with the burst flag on, ticks backends with 16', () => {
    const catalog = new TileCatalog()
    const { backend, ticks } = makeRecordingBackend()
    catalog.attachBackend(backend)
    catalog.setColdStartBurst(true)
    catalog.resetCompileBudget()
    expect(ticks.at(-1)).toBe(16)
  })

  it('clearing the burst flag restores the steady 2', () => {
    const catalog = new TileCatalog()
    const { backend, ticks } = makeRecordingBackend()
    catalog.attachBackend(backend)
    catalog.setColdStartBurst(true)
    catalog.resetCompileBudget()
    catalog.setColdStartBurst(false)
    catalog.resetCompileBudget()
    expect(ticks.at(-1)).toBe(2)
  })
})
