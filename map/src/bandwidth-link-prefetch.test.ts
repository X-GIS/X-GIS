// #1356 — speculative prefetch is suppressed under Save-Data.
//
// Prefetch is the first lever the issue names, and the reason is that it is the
// only traffic in the library that is SPECULATIVE: both routes fetch tiles the
// camera may never reach. Suppressing them costs correctness nothing — no
// visible tile goes unfetched — so this is the one place where honouring the
// user's declared preference is free.
//
// The budget caps are covered in data/src/bandwidth-link-budgets.test.ts; this
// file drives the real PrefetchScheduler against a recording catalog.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TileCatalog } from '@xgis/data'
import { PrefetchScheduler } from './render/prefetch-scheduler'
import { Camera } from './camera/camera'

function stubConnection(connection: { saveData?: boolean; effectiveType?: string } | undefined) {
  vi.stubGlobal('navigator', { connection })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Catalog stub that records prefetch traffic. `hasTileData: false` +
 *  `hasEntryInIndex: true` is the state that makes route 1 emit — every sibling
 *  is indexed but uncached, so a live scheduler has work to do. */
function recordingCatalog(): { calls: number[][]; catalog: TileCatalog } {
  const calls: number[][] = []
  const catalog = {
    hasData: () => true,
    hasTileData: () => false,
    hasEntryInIndex: () => true,
    prefetchTiles: (keys: number[]) => calls.push(keys),
  } as unknown as TileCatalog
  return { calls, catalog }
}

/** Two z=4 neighbours, so each has uncached siblings for route 1 to pull. */
const NEEDED = [(4 << 26) | (8 << 13) | 5, (4 << 26) | (9 << 13) | 5]

function pumpOnce(): number[][] {
  const { calls, catalog } = recordingCatalog()
  const scheduler = new PrefetchScheduler()
  scheduler.pump(catalog, { neededKeys: NEEDED }, new Camera(0, 0, 4), 0, 800, 600, 1)
  return calls
}

describe('speculative prefetch is suppressed under Save-Data (#1356)', () => {
  it('a fast link still prefetches — the control that makes the next test mean something', () => {
    stubConnection({ effectiveType: '4g' })
    expect(pumpOnce().length).toBeGreaterThan(0)
  })

  it('Save-Data issues no speculative fetch at all', () => {
    // Not "fewer" — none. The on-demand path still serves every tile the camera
    // actually reaches; only the guessing stops.
    stubConnection({ saveData: true })
    expect(pumpOnce()).toEqual([])
  })

  it('a 2g-grade link is treated as Save-Data', () => {
    stubConnection({ effectiveType: '2g' })
    expect(pumpOnce()).toEqual([])
  })

  it('a 3g link keeps prefetching — reduced is not saver', () => {
    // The three-way split has to be observable, or 'reduced' is a label with no
    // behaviour behind it. On a usable link speculation still pays for itself;
    // only the concurrency caps tighten.
    stubConnection({ effectiveType: '3g' })
    expect(pumpOnce().length).toBeGreaterThan(0)
  })
})
