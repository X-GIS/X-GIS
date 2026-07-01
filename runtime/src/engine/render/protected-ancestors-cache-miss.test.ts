// Regression test for the `protectedAncestors` variable-shadowing bug in
// TileSelectionCache.selectForFrame (tile-selection-cache.ts).
//
// THE BUG (confirmed):
//   `selectForFrame` declares a function-scope `let protectedAncestors =
//   []` (line 542) which the final `return` reads (line 849). Inside the
//   cache-MISS `else` branch it RE-declared a NEW `const protectedAncestors
//   = []` (line 780) that SHADOWED the outer var. The selector's
//   `fallbackOnly` parent-inject tiles were pushed into the inner const
//   and correctly stored into `_frameTileCache.protectedAncestors`, but
//   the `return` — being OUTSIDE the else block — read the OUTER var,
//   which on the cache-miss path was never assigned and stayed `[]`.
//
//   Net effect: every cache-MISS call returned `protectedAncestors: []`,
//   dropping the eviction-protection keys for the high-pitch parent
//   inject. The cache-HIT path (line 553 assigns the outer var from the
//   stored cache) returned the correct value, masking the bug.
//
// THE FIX: drop `const` at line 780 so the inner block assigns the
//   outer function-scoped variable.
//
// ORACLE (the invariant the bug violates):
//   On a cache-miss call, the RETURNED `selection.protectedAncestors`
//   must EQUAL the value STORED in `cache.frameTileCache().protectedAncestors`
//   — the renderer (return) and the prefetch/eviction reader (stored)
//   must see the same protected set. With the bug the stored value is
//   non-empty while the returned value is `[]`, so they diverge.
//
// REPRODUCTION CONFIG (produces fallbackOnly tiles):
//   A mercator (projType 0, globeMode false) Camera over Tokyo at zoom 14
//   with pitch 60° drives the flat SSE selector branch in selectForFrame.
//   `visibleTilesSSE` injects (z-1, z-2) ancestors flagged `fallbackOnly`
//   for each primary leaf — this is the exact camera the SSE selector
//   unit test (`tiles-sse.test.ts` → "emits fallbackOnly parent ancestors
//   for eviction protection") uses to prove non-empty fallbackOnly
//   emission. `selectForFrame` strips those into `protectedAncestors`.
//
//   A fresh TileSelectionCache has `_hysteresisZ = -1`, so the first call
//   takes the `cz = Math.floor(zoom)` branch — no readiness gate runs, so
//   the only catalog methods touched on this path are `maxLevel` and
//   `hasEntryInIndex` (the latter only for in-archive tiles at z <=
//   maxLevel). With `sliceLayer = ''` the per-layer minzoom gates are
//   skipped entirely.

import { describe, expect, it } from 'vitest'
import { Camera } from '@xgis/engine'
import { TileSelectionCache } from '@xgis/map'
import { FrameDrawStats } from '@xgis/engine'
import type { TileCatalog } from '@xgis/data'

// Minimal catalog stub. On the fresh-cache mercator high-pitch path
// selectForFrame reads only `maxLevel` (line 499) + `hasEntryInIndex`
// (line 804, for z <= maxLevel tiles). Everything else throws so any
// drift onto an unexpected branch (globe / readiness gate) surfaces
// loudly rather than silently producing the wrong tile set.
function makeMockCatalog(): TileCatalog {
  const catalog = {
    maxLevel: 14,
    // Ancestor index probe — return true so the in-archive parent walk
    // (line 829) terminates on the first hit; the value doesn't affect
    // protectedAncestors (which is populated purely from the selector's
    // fallbackOnly flag), it just keeps the walk cheap.
    hasEntryInIndex: () => true,
  }
  return catalog as unknown as TileCatalog
}

// Tokyo — the SSE selector unit test's fallbackOnly-emission camera.
const TOKYO = { lon: 139.76, lat: 35.68 }
const W = 1280
const H = 800
const DPR = 1

describe('TileSelectionCache.selectForFrame — protectedAncestors cache-miss parity', () => {
  it('returns the SAME protectedAncestors it stores in the frame cache (non-empty)', () => {
    const cache = new TileSelectionCache()
    const camera = new Camera(TOKYO.lon, TOKYO.lat, 14)
    camera.pitch = 60 // drives the flat SSE selector's fallbackOnly inject
    const drawStats = new FrameDrawStats()

    // Cache-MISS call: fresh cache, no prior frame.
    const selection = cache.selectForFrame(
      camera,
      0, // projType = mercator → flat SSE selector branch
      TOKYO.lon, // projCenterLon
      TOKYO.lat, // projCenterLat
      W,
      H,
      DPR,
      1, // frameId
      makeMockCatalog(),
      '', // sliceLayer empty → per-layer minzoom gates skipped
      0, // offsetMarginPx
      14, // maxLevel
      drawStats,
    )

    expect(selection, 'selectForFrame returned null (below minzoom?)').not.toBeNull()
    if (!selection) return

    const stored = cache.frameTileCache()
    expect(stored, 'frame cache was not populated on the miss path').not.toBeNull()
    if (!stored) return

    // Sanity: the SSE selector at pitch=60 over Tokyo MUST emit
    // fallbackOnly ancestors, so the STORED protected set is non-empty.
    // (If this ever fails the reproduction camera no longer triggers the
    // inject — see tiles-sse.test.ts for the canonical config.)
    expect(
      stored.protectedAncestors.length,
      'reproduction camera produced no fallbackOnly tiles — stored set empty',
    ).toBeGreaterThan(0)

    // THE ORACLE: the RETURNED protected set must equal the STORED one.
    // With the shadowing bug the return reads the outer (untouched) []
    // while the cache holds the real non-empty inject — they diverge.
    expect(
      selection.protectedAncestors,
      'returned protectedAncestors diverged from the stored frame-cache value '
        + '(variable-shadowing bug: return read the outer [] not the inner inject)',
    ).toEqual(stored.protectedAncestors)
    expect(
      selection.protectedAncestors.length,
      'returned protectedAncestors is empty — the fallbackOnly inject was dropped',
    ).toBeGreaterThan(0)
  })

  it('cache-MISS then cache-HIT for the same frame return identical protectedAncestors', () => {
    // Second guard: the HIT path (line 553) assigns the outer var from
    // the stored cache and so always returned the right value, masking
    // the bug. A miss followed by a hit on the SAME key must agree —
    // before the fix the miss returned [] and the hit returned the real
    // set, so the two calls disagreed.
    const cache = new TileSelectionCache()
    const camera = new Camera(TOKYO.lon, TOKYO.lat, 14)
    camera.pitch = 60
    const drawStats = new FrameDrawStats()

    const args = [
      camera, 0, TOKYO.lon, TOKYO.lat, W, H, DPR, 7, makeMockCatalog(), '', 0, 14, drawStats,
    ] as const

    const miss = cache.selectForFrame(...args)
    const hit = cache.selectForFrame(...args) // same frameId + key → cache hit

    expect(miss, 'miss call returned null').not.toBeNull()
    expect(hit, 'hit call returned null').not.toBeNull()
    if (!miss || !hit) return

    expect(hit.protectedAncestors.length).toBeGreaterThan(0)
    expect(
      miss.protectedAncestors,
      'cache-miss return disagreed with the cache-hit return for the same key',
    ).toEqual(hit.protectedAncestors)
  })
})
