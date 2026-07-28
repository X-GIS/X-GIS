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

describe('visibleTilesFrustum — the frustum budget classifies on the LARGER CSS axis (#1350)', () => {
  it('a 960x360 desktop canvas gets the desktop frustum budget, not the phone budget', () => {
    // Reaches the module-private `isMobileViewport` through the only exported
    // entry point that consumes it: isMobileViewport -> maxFrustumTilesFor ->
    // the DFS cap inside visibleTilesFrustum.
    //
    // 960x360 is the discriminating shape: max=960 (>900) is desktop, but
    // min=360 (<=900) is phone-class, so a Math.min/Math.max swap misclassifies
    // an ordinary desktop window as a phone. At pitch>=60 (pitchMul=2) the two
    // budgets are 120 tiles (desktop: floor 60) vs 38 (phone: area/18000).
    //
    // A COARSE pointer is stubbed on purpose. The correct implementation never
    // consults it here — max=960 fails isMobileClassViewport's size gate first —
    // but the Math.min mutant passes 360 into that gate, reaches the pointer
    // branch, and takes the phone budget. Stubbing coarse is what makes the
    // mutant observable instead of silently landing on the same desktop answer.
    //
    // Measured on this camera: 93 tiles with Math.max, 65 with Math.min. 80
    // separates them with margin on both sides.
    //
    // (Re-baselined for the #1427 far-plane cull. The former shape — 1200x800,
    // 169 vs 133, threshold 150 — worked because the selection SATURATED the
    // budget; culling past-far-plane tiles dropped that camera to 98 selected
    // against a 160/106 pair of caps, so neither cap bound any more and the
    // classification became unobservable through the tile count. The invariant
    // is unchanged; only a camera where the caps still bind could still see it.)
    stubPointer('coarse')
    const cam = new Camera(-73.95, 40.8, 14)
    cam.pitch = 85
    cam.bearing = 30
    const tiles = visibleTilesFrustum(cam, mercator, 18, 960, 360, 0, 1)
    expect(tiles.length).toBeGreaterThan(80)
  })

  it('a small 640px window is DESKTOP on a fine pointer and PHONE on a coarse one', () => {
    // The case above cannot reach the classifier's POINTER branch on a correct
    // implementation: 960 > 900 fails isMobileClassViewport's size gate first,
    // so it is satisfied by any mutant that keeps width-only classification.
    // This one is the pointer test — same canvas, same camera, only
    // `pointer: coarse` differs — so the ONLY thing that can move the count is
    // the classification itself.
    //
    // Asserted as a RELATION, not two pinned constants. `fine > coarse` is what
    // "the pointer decides" means, and it is what fails for every mutation of
    // this classifier: a constant `return false` (phone budget deleted), a
    // constant `return true` (desktop budget deleted), and a restored
    // width-only rule (640 is phone-class on width, so the pointer stops
    // mattering) all collapse the two sides to the SAME count. It also survives
    // unrelated selector drift, which a pinned 73-vs-61 would not.
    //
    // (Re-baselined for the #1427 far-plane cull alongside the case above. At
    // the former 860x600 the post-cull selection no longer reaches either cap,
    // so both pointers returned the same 73 and the relation went vacuous;
    // 640x480 keeps the phone cap binding. Measured here: fine 73, coarse 61.)
    const camFor = () => {
      const c = new Camera(-73.95, 40.8, 14)
      c.pitch = 85
      c.bearing = 30
      return c
    }
    stubPointer('fine')
    const fine = visibleTilesFrustum(camFor(), mercator, 18, 640, 480, 0, 1).length
    stubPointer('coarse')
    const coarse = visibleTilesFrustum(camFor(), mercator, 18, 640, 480, 0, 1).length

    expect(fine, 'a fine pointer must get the desktop frustum budget').toBeGreaterThan(coarse)
    // Both sides must be doing real work — a selector that returned nothing
    // would satisfy an inequality against zero just as well.
    expect(coarse).toBeGreaterThan(0)
  })
})
