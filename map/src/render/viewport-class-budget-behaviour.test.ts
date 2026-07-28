// BEHAVIOURAL coverage for the two #1350 migration sites that live outside
// @xgis/data's own test reach. `data/src/viewport-class-budget-migration.test.ts`
// pins them with SOURCE gates only ("body mentions isMobileClassViewport, body
// has no literal 900") because @xgis/data cannot import @xgis/map. That rules
// out a test in data/src — it does NOT rule out one here, and a source gate is
// satisfied by a wrong implementation: an inverted ternary in getMaxGpuTiles
// and a Math.min/Math.max swap in tile-select's isMobileViewport both pass it.
// These are the assertions that fail when either mutation is applied.
//
// Runs in the default node env (no window). matchMedia is stubbed per-case,
// copying the harness in vector-tile-renderer-helpers.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Camera } from '@xgis/map'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator } from '@xgis/geo'
import { getMaxGpuTiles } from './vector-tile-renderer-helpers'

/** Minimal matchMedia stub — only `.matches` is read. A `pointer: coarse`
 *  query matches iff we emulate a coarse PRIMARY pointer (phone/tablet). */
function stubPointer(kind: 'coarse' | 'fine'): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse') ? kind === 'coarse' : kind === 'fine',
    media: query,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getMaxGpuTiles — GPU-cache cap routes through isMobileClassViewport (#1350)', () => {
  it('small DESKTOP window (fine pointer, 860px) keeps the desktop cap of 256', () => {
    // THE FIX. Pre-#1350 the width-only `w <= 900` test returned the 64-key
    // phone cap for this 860px desktop window, evicting GPU tiles 4× too eagerly.
    stubPointer('fine')
    vi.stubGlobal('window', { innerWidth: 860 })
    expect(getMaxGpuTiles()).toBe(256)
  })

  it('real phone (coarse pointer, 390px) still gets the 64-key phone cap', () => {
    stubPointer('coarse')
    vi.stubGlobal('window', { innerWidth: 390 })
    expect(getMaxGpuTiles()).toBe(64)
  })
})

describe('visibleTilesFrustum — the budget is WIRED to the selector (#1350)', () => {
  // The classification and the cap themselves are asserted exactly in
  // `data/src/tile-select-budget.test.ts`, which can call them directly now
  // that they live in their own module. What THAT file cannot check is that
  // `visibleTilesFrustum` actually consults them — a selector that ignored
  // `maxFrustumTilesFor` entirely would leave it green. This is that check,
  // and it is all that is left here.
  //
  // History worth keeping: these cases used to prove the classification by
  // picking a camera that SATURATED the budget and reading the tile count.
  // That inference kept weakening — the #1427 far-plane cull dropped the old
  // 1200x800 camera from 169 selected to 98 against a 160/106 pair of caps, so
  // neither cap bound and both pointers returned the same number. Chasing a
  // still-saturating camera would just defer the next re-baseline; testing the
  // budget directly ends it.

  it('honours the phone cap when the classifier says phone', () => {
    // 500x400: both axes are small, so the POINTER decides — same canvas, same
    // camera, only `pointer: coarse` differs. Any mutation of the classifier
    // (constant true, constant false, width-only) collapses the two sides to
    // the same count, which is why this is asserted as a relation rather than
    // as two pinned numbers. Measured: fine 70, coarse 51.
    const camFor = () => {
      const c = new Camera(-73.95, 40.8, 14)
      c.pitch = 85
      c.bearing = 30
      return c
    }
    stubPointer('fine')
    const fine = visibleTilesFrustum(camFor(), mercator, 18, 500, 400, 0, 1).length
    stubPointer('coarse')
    const coarse = visibleTilesFrustum(camFor(), mercator, 18, 500, 400, 0, 1).length

    expect(fine, 'a fine pointer must get the desktop frustum budget').toBeGreaterThan(coarse)
    // Both sides must be doing real work — a selector that returned nothing
    // would satisfy an inequality against zero just as well.
    expect(coarse).toBeGreaterThan(0)
  })

  it('caps the emitted set at the budget, not somewhere above it', () => {
    // The cap must BITE, not merely exist. A coarse-pointer 500x400 at
    // pitch>=60 gets max(24, round(200000/18000)*2) = 24 from the DFS; the
    // camera-region inject then adds its 5x5 ring on top by design, so the
    // observable ceiling is the cap plus that ring — well under what the same
    // camera selects on the desktop budget.
    stubPointer('coarse')
    const cam = new Camera(-73.95, 40.8, 14)
    cam.pitch = 85
    cam.bearing = 30
    const tiles = visibleTilesFrustum(cam, mercator, 18, 500, 400, 0, 1)
    expect(tiles.length).toBeLessThan(60)
    expect(tiles.length).toBeGreaterThan(0)
  })
})
