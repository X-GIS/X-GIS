// #1356 — the fetch budgets actually respond to link cost, not only to screen
// width.
//
// The classifier's own semantics are pinned in shared/src/network-class.test.ts,
// and a source gate there proves each site IMPORTS the authority. Importing it
// and ignoring it would satisfy that gate, which is what this file exists to
// exclude: every assertion below drives the real production function and reads
// the number a fetch scheduler would actually receive.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { maxConcurrentLoads, defaultSkeletonByteBudget } from './tile-types'
import { maxInflight } from './sources/pmtiles-backend-helpers'

function stubConnection(connection: { saveData?: boolean; effectiveType?: string } | undefined) {
  vi.stubGlobal('navigator', { connection })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the fetch budgets respond to link cost, not only screen width (#1356)', () => {
  it('catalog concurrency drops on a metered link and is restored on a fast one', () => {
    // This is the headline case from the issue: a TETHERED DESKTOP. Width says
    // "desktop, give it 32"; the link says the user is paying per byte.
    stubConnection({ effectiveType: '4g' })
    const full = maxConcurrentLoads()
    stubConnection({ saveData: true })
    const saver = maxConcurrentLoads()
    expect(saver).toBeLessThan(full)
    expect(saver).toBeGreaterThanOrEqual(2)

    stubConnection({ effectiveType: '3g' })
    const reduced = maxConcurrentLoads()
    expect(reduced).toBeLessThan(full)
    expect(reduced).toBeGreaterThan(saver)
  })

  it('the per-archive in-flight cap scales the same way', () => {
    // A second, independent cap: the catalog limit above bounds the whole
    // pipeline, this one bounds one archive. Both must move, or whichever stays
    // wide silently becomes the only real limit.
    stubConnection({ effectiveType: '4g' })
    const full = maxInflight()
    stubConnection({ saveData: true })
    expect(maxInflight()).toBeLessThan(full)
  })

  it('skeleton prewarm is cut to the floor levels under Save-Data', () => {
    // The prewarm buys pan-ahead smoothness by fetching low-zoom tiles the
    // camera may never reach — precisely the trade a data-saving user declined.
    // z0+z1 complete regardless of this budget, so navigation still works.
    stubConnection({ effectiveType: '4g' })
    expect(defaultSkeletonByteBudget()).toBeGreaterThan(0)
    stubConnection({ saveData: true })
    expect(defaultSkeletonByteBudget()).toBe(0)
  })

  it('leaves every budget untouched where the API is absent (Safari / Firefox)', () => {
    // Progressive enhancement: no signal must mean no change. Compared against
    // an explicitly-fast link rather than hard-coded numbers, so retuning a
    // device cap cannot make this assertion stale.
    stubConnection({ effectiveType: '4g' })
    const fast = [maxConcurrentLoads(), maxInflight(), defaultSkeletonByteBudget()]
    stubConnection(undefined)
    expect([maxConcurrentLoads(), maxInflight(), defaultSkeletonByteBudget()]).toEqual(fast)
  })
})
