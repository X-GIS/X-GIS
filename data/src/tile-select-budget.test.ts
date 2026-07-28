import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_FRUSTUM_TILES_CEILING,
  isMobileViewport,
  maxFrustumTilesFor,
} from './tile-select-budget'

// ═══════════════════════════════════════════════════════════════════
// The frustum tile budget, tested DIRECTLY.
// ═══════════════════════════════════════════════════════════════════
//
// These two functions used to be private to `tile-select.ts`, so the only way
// to reach them was to pick a camera that SATURATED the budget and read the
// resulting tile count — which is what `map/src/render/
// viewport-class-budget-behaviour.test.ts` did. That inference has been getting
// weaker: the #1427 far-plane cull means an ordinary camera no longer comes
// anywhere near the cap, so the two classifications produce nearly the same
// count and the gate loses its teeth. (It had to be re-baselined twice in one
// change for exactly that reason.)
//
// Now that the budget lives in its own module the assertions can be exact.
// The behavioural test in map/ stays, reduced to the one thing this file
// cannot check: that the budget is actually WIRED to `visibleTilesFrustum`.
//
// Runs in the default node env (no window). matchMedia is stubbed per case,
// copying the harness in vector-tile-renderer-helpers.test.ts.

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

describe('isMobileViewport — classify on the LARGER CSS axis (#1350)', () => {
  it('classifies a wide-but-short window as DESKTOP, whatever the pointer', () => {
    // 960x360 is the discriminating shape: max=960 (>900) is desktop, min=360
    // (<=900) is phone-class, so a Math.min/Math.max swap flips it. A COARSE
    // pointer is stubbed on purpose — the correct implementation never reaches
    // the pointer branch here because 960 fails the size gate first, so this
    // case is exactly the one a swap turns into a phone.
    stubPointer('coarse')
    expect(isMobileViewport(960, 360)).toBe(false)
    expect(isMobileViewport(360, 960)).toBe(false) // orientation-independent
  })

  it('lets the POINTER decide once both axes are small', () => {
    stubPointer('fine')
    expect(isMobileViewport(500, 400)).toBe(false)
    stubPointer('coarse')
    expect(isMobileViewport(500, 400)).toBe(true)
  })

  it('never treats a real desktop canvas as a phone', () => {
    stubPointer('coarse')
    for (const [w, h] of [
      [1280, 800],
      [1920, 1080],
      [2560, 1440],
    ] as [number, number][]) {
      expect(isMobileViewport(w, h), `${w}x${h}`).toBe(false)
    }
  })
})

describe('maxFrustumTilesFor — the per-frame cap', () => {
  it('gives a small desktop window the desktop budget, not the phone one', () => {
    stubPointer('coarse')
    // 960x360 @ pitch>=60: desktop floor 60*2 = 120 vs phone round(345600/18000)*2 = 38.
    expect(maxFrustumTilesFor(960, 360, 72.4)).toBe(120)
    stubPointer('fine')
    expect(maxFrustumTilesFor(960, 360, 72.4)).toBe(120)
  })

  it('gives a real phone the phone budget', () => {
    stubPointer('coarse')
    // 390x844 @ pitch 0: max(12, round(329160/18000)) = max(12, 18) = 18.
    expect(maxFrustumTilesFor(390, 844, 0)).toBe(18)
    // ...and the same viewport on a laptop trackpad keeps the desktop floor.
    stubPointer('fine')
    expect(maxFrustumTilesFor(390, 844, 0)).toBe(60)
  })

  it('scales with the pitch band, 1 / 1.5 / 2', () => {
    stubPointer('fine')
    const at = (p: number) => maxFrustumTilesFor(1280, 800, p)
    expect(at(0)).toBe(Math.round((1280 * 800) / 12000))
    expect(at(30)).toBe(at(0) * 1.5)
    expect(at(60)).toBe(at(0) * 2)
    // The bands are half-open at their lower edge — 59.9 is still the 1.5x one.
    expect(at(59.9)).toBe(at(30))
    expect(at(29.9)).toBe(at(0))
  })

  it('honours the absolute ceiling however large the viewport gets', () => {
    stubPointer('fine')
    expect(maxFrustumTilesFor(7680, 4320, 85)).toBe(MAX_FRUSTUM_TILES_CEILING)
  })

  it('never returns less than the floor, however small the viewport gets', () => {
    stubPointer('fine')
    expect(maxFrustumTilesFor(1, 1, 0)).toBe(60)
    stubPointer('coarse')
    expect(maxFrustumTilesFor(1, 1, 0)).toBe(12)
    // Floor scales with the pitch band too.
    expect(maxFrustumTilesFor(1, 1, 72.4)).toBe(24)
  })
})
