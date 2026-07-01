// Lifecycle invariants for TileCatalog: the prewarmSkeleton retry pump
// must be cancellable, and the evict-shield must drain even when the
// cache stays under budget.
//
// BUG 11: prewarmSkeleton self-reschedules a 250 ms pump that only
// stops once every skeleton key reports hasTileData. A 'failed'
// (5xx/network) skeleton tile never populates dataCache, so without an
// explicit cancel the pump reschedules for the page lifetime —
// GC-pinning the catalog and firing prefetch against a dead source.
// teardownSource never reached the catalog, so destroy() is the missing
// brake.
//
// BUG 13: the evict-shield's only removal path used to sit AFTER the
// under-budget early-return in evictTiles. A map that stays under the
// cap while still prefetching never drained the shield → monotonic
// JS-heap growth.
//
// Pulling on TileCatalog directly keeps the tests on the lifecycle
// mechanism (no PMTiles attach / GPU).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog } from './tile-catalog'
import { type TileData } from '@xgis/data'

// Minimal TileData with a controllable byte cost (mirrors the helper in
// tile-catalog-skeleton.test.ts).
function makeStubTileData(floats: number): TileData {
  const verts = new Float32Array(floats)
  const lineVerts = new Float32Array(floats)
  const idx = new Uint32Array(floats)
  return {
    vertices: verts,
    dequantScale: 0,
    dequantHalf: 0,
    indices: idx,
    lineVertices: lineVerts,
    lineIndices: idx,
    outlineIndices: idx,
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
  }
}

function injectSlice(catalog: TileCatalog, key: number, data: TileData): void {
  const slice = (catalog as unknown as {
    setSlice(k: number, layer: string, d: TileData): void
  }).setSlice.bind(catalog)
  slice(key, '', data)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TileCatalog lifecycle (BUG 11: prewarm pump cancellation)', () => {
  it('prewarmSkeleton pump re-arms forever when a skeleton tile never loads; destroy() stops it', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const catalog = new TileCatalog()
    // No backend ever populates dataCache, so hasTileData stays false
    // for every skeleton key → the pump's remaining filter never empties.
    const prefetchSpy = vi.spyOn(catalog, 'prefetchTiles')

    // depth 0 → just the z=0 root key. The pump fires immediately, then
    // re-arms via setTimeout.
    catalog.prewarmSkeleton({ depth: 0 })

    const armedAfterFirstTick = setTimeoutSpy.mock.calls.length
    expect(armedAfterFirstTick,
      'first tick must arm a retry because hasTileData stays false')
      .toBeGreaterThanOrEqual(1)

    // Advance several 250 ms windows — the pump keeps re-arming forever.
    vi.advanceTimersByTime(250)
    vi.advanceTimersByTime(250)
    vi.advanceTimersByTime(250)
    expect(setTimeoutSpy.mock.calls.length,
      'pump re-arms on every 250 ms tick (never terminates)')
      .toBeGreaterThan(armedAfterFirstTick)
    const prefetchCallsBeforeDestroy = prefetchSpy.mock.calls.length
    expect(prefetchCallsBeforeDestroy,
      'pump keeps firing prefetch against the source')
      .toBeGreaterThan(1)

    // destroy() must exist and stop the pump (FAILS before the fix:
    // TileCatalog has no destroy method).
    expect(typeof (catalog as unknown as { destroy?: unknown }).destroy,
      'TileCatalog must expose destroy() to cancel the pump')
      .toBe('function')
    catalog.destroy()

    const armsAtDestroy = setTimeoutSpy.mock.calls.length
    const prefetchAtDestroy = prefetchSpy.mock.calls.length
    vi.advanceTimersByTime(250)
    vi.advanceTimersByTime(250)
    expect(setTimeoutSpy.mock.calls.length,
      'after destroy() the pump must not re-arm')
      .toBe(armsAtDestroy)
    expect(prefetchSpy.mock.calls.length,
      'after destroy() prefetch must not fire again')
      .toBe(prefetchAtDestroy)
  })

  it('prewarmSkeleton pump terminates on its own once tiles load (no leak when healthy)', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const catalog = new TileCatalog()
    catalog.prewarmSkeleton({ depth: 0 })
    const armed = setTimeoutSpy.mock.calls.length
    // Populate the root key so hasTileData → true.
    injectSlice(catalog, tileKey(0, 0, 0), makeStubTileData(8))
    vi.advanceTimersByTime(250)
    expect(setTimeoutSpy.mock.calls.length,
      'pump stops once every skeleton key reports hasTileData')
      .toBe(armed)
  })
})

describe('TileCatalog lifecycle (BUG 13: evict-shield drains under budget)', () => {
  it('evictTiles sweeps expired shield entries even while under the cap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const catalog = new TileCatalog()
    const shield = (catalog as unknown as {
      eviction: { shieldMap: Map<number, number> }
    }).eviction.shieldMap

    // Stay well under MAX_CACHED_TILES the whole time, but keep
    // prefetching distinct keys whose shield TTL keeps expiring. Each
    // prefetch inserts a shield entry; only the sweep can remove it.
    for (let round = 0; round < 50; round++) {
      // Distinct key per round so nothing dedups.
      catalog.prefetchTiles([tileKey(10, round, 0)])
      // Jump past EVICT_SHIELD_TTL_MS (2 s) so the prior round's entry
      // is now expired, then run an eviction pass.
      vi.advanceTimersByTime(5_000)
      catalog.evictTiles(new Set())
    }

    // Before the fix the shield only sweeps after the under-budget
    // early-return, so it never drains → size ≈ 50. After the fix the
    // sweep runs every call, so only the most-recent (un-expired) entry
    // can remain.
    expect(shield.size,
      'expired shield entries must be swept even when under budget')
      .toBeLessThanOrEqual(2)
  })
})
