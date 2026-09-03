// Cesium-style permanent skeleton invariants for TileCatalog.
//
// `_skeletonKeys` is the runtime equivalent of Cesium's
// `_doNotDestroySubtree` flag on quadtree root tiles: a small set of
// low-zoom tiles pinned in catalog so `classifyFallback`'s ancestor
// walk always succeeds during fast-pan. These tests mirror the
// invariants from Cesium `tileReplacementQueueSpec` — protected roots
// must survive eviction AND must not be aborted by the per-frame
// fetch-cancellation pass.
//
// Pulling on TileCatalog directly (not via PMTiles attach) keeps the
// tests focused on the protection mechanism — the prewarm pump is
// covered separately via the e2e suite.
import { describe, expect, it, vi } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog } from '@xgis/data'
import { type TileData, MAX_CACHED_TILES } from '@xgis/data'
import { type TileSource, type TileSourceMeta, type TileSourceSink } from '@xgis/data'

// Minimal TileData with controllable byte cost. sizeOfTileData sums
// vertices + indices + lineVertices + lineIndices + outlineIndices, so
// putting `floats` Float32 elements in each gives 5 × 4 × floats bytes.
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
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 1,
    tileHeight: 1,
    tileZoom: 0,
  }
}

// Reach into the private setSlice for direct cache injection — same
// escape hatch the multi-layer-overzoom test uses.
function injectSlice(catalog: TileCatalog, key: number, data: TileData): void {
  const slice = (
    catalog as unknown as {
      setSlice(k: number, layer: string, d: TileData): void
    }
  ).setSlice.bind(catalog)
  slice(key, '', data)
}

// Stub TileSource: just enough to satisfy attachBackend's contract so
// `cancelStale` is exercised. Records the merged key set the catalog
// passes through so test 4 can audit it.
function makeStubBackend(): {
  backend: TileSource
  cancelStale: ReturnType<typeof vi.fn>
} {
  const cancelStale = vi.fn<(activeKeys: Set<number>) => void>()
  const meta: TileSourceMeta = {
    bounds: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 14,
    scheme: 'web-mercator-xyz',
  }
  const backend: TileSource = {
    meta,
    has: () => false,
    attach: (_sink: TileSourceSink) => undefined,
    loadTile: () => undefined,
    cancelStale,
  }
  return { backend, cancelStale }
}

describe('TileCatalog skeleton (Cesium permanent-root pattern)', () => {
  it('markSkeleton keys survive evictTiles even with empty protectedKeys', () => {
    const catalog = new TileCatalog()
    const keep = tileKey(0, 0, 0)
    injectSlice(catalog, keep, makeStubTileData(8))
    catalog.markSkeleton([keep])
    catalog.evictTiles(new Set())
    expect(
      catalog.hasTileData(keep),
      'skeleton key must survive eviction with no frame-protectedKeys',
    ).toBe(true)
  })

  it('non-skeleton keys evict normally when count cap is exceeded', () => {
    const catalog = new TileCatalog()
    // Inject MAX_CACHED_TILES + 5 keys; mark the first one as skeleton.
    // Eviction must drop at least 5 non-skeleton keys to bring the
    // count back to the cap, but the skeleton key MUST remain.
    const skeletonKey = tileKey(0, 0, 0)
    const overflow: number[] = []
    injectSlice(catalog, skeletonKey, makeStubTileData(8))
    catalog.markSkeleton([skeletonKey])
    for (let i = 0; i < MAX_CACHED_TILES + 5; i++) {
      const k = tileKey(8, i, 0)
      injectSlice(catalog, k, makeStubTileData(8))
      overflow.push(k)
    }
    catalog.evictTiles(new Set())
    expect(
      catalog.hasTileData(skeletonKey),
      'skeleton survives count-cap-driven LRU eviction',
    ).toBe(true)
    let evicted = 0
    for (const k of overflow) {
      if (!catalog.hasTileData(k)) evicted++
    }
    expect(evicted, 'count-cap eviction must drop ≥ 5 non-skeleton keys').toBeGreaterThanOrEqual(5)
  })

  it('skeleton survives eviction even after _evictShield TTL would have expired', () => {
    // Two protection channels coexist: _evictShield (transient, 2s TTL)
    // and _skeletonKeys (permanent). With shield TTL forced into the
    // past, only _skeletonKeys can save the key. Confirms the channels
    // are orthogonal — skeleton doesn't piggyback on shield.
    const catalog = new TileCatalog()
    const k = tileKey(1, 0, 0)
    injectSlice(catalog, k, makeStubTileData(8))
    catalog.markSkeleton([k])
    // Stuff cache to the count cap with non-skeleton keys so the
    // entry-not-needed early-out doesn't short-circuit eviction.
    for (let i = 0; i < MAX_CACHED_TILES + 1; i++) {
      injectSlice(catalog, tileKey(8, i, 0), makeStubTileData(8))
    }
    // Sanity: shield is empty here (we never called prefetchTiles), so
    // the only thing standing between this key and eviction is the
    // skeleton filter.
    const shield = (catalog as unknown as { eviction: { shieldMap: Map<number, number> } }).eviction
      .shieldMap
    expect(shield.has(k)).toBe(false)
    catalog.evictTiles(new Set())
    expect(catalog.hasTileData(k), 'skeleton must survive without any shield protection').toBe(true)
  })

  it("cancelStale unions skeleton keys into the backend's active set", () => {
    // The pump's 250ms gap collides with the catalog's 12-frame
    // _prefetchAge wipe; without skeleton union here, in-flight
    // skeleton fetches would be aborted between retries.
    const catalog = new TileCatalog()
    const { backend, cancelStale } = makeStubBackend()
    catalog.attachBackend(backend)
    const k1 = tileKey(0, 0, 0)
    const k2 = tileKey(1, 0, 0)
    catalog.markSkeleton([k1, k2])
    // Empty active set — without skeleton union this would tell
    // backend "abort everything".
    catalog.cancelStale(new Set())
    expect(cancelStale).toHaveBeenCalledTimes(1)
    const merged = cancelStale.mock.calls[0][0]
    expect(merged.has(k1), 'skeleton key 1 must be in cancelStale merged set').toBe(true)
    expect(merged.has(k2), 'skeleton key 2 must be in cancelStale merged set').toBe(true)
  })
})

// ═══ #2273 — the prefetch shield ages per FRAME, not per cancelStale call ═══
//
// `cancelStale` runs once per VectorTileRenderer.render(), and render() runs
// once per ShowCommand — measured 97 calls per frame (max 105) on OFM Bright at
// z14. The shield's "12 frames ≈ 200 ms" therefore expired after 12 CALLS, an
// eighth of a frame, and every sibling prefetch was aborted on the 13th call of
// the frame that issued it, then re-fetched next frame: 2-3 real network
// requests per tile and no prefetch ever landing as one.
describe('prefetch shield aging (#2273)', () => {
  const shieldOf = (c: TileCatalog) =>
    (c as unknown as { _prefetchKeys: Set<number> })._prefetchKeys

  it('THE REGRESSION: 100 cancelStale calls inside ONE frame do not age the shield out', () => {
    const catalog = new TileCatalog()
    const { backend, cancelStale } = makeStubBackend()
    catalog.attachBackend(backend)
    const k = tileKey(14, 13972, 6344)
    catalog.resetCompileBudget(41) // the frame's id, as render() supplies it
    catalog.prefetchTiles([k])
    expect(shieldOf(catalog).has(k)).toBe(true)
    for (let i = 0; i < 100; i++) catalog.cancelStale(new Set())
    expect(shieldOf(catalog).has(k), 'shield dropped inside the frame that armed it').toBe(true)
    // ...and the backend kept being told the key is active, every call.
    const last = cancelStale.mock.calls.at(-1)![0] as Set<number>
    expect(last.has(k)).toBe(true)
  })

  it('still ages out across frames: 13 frames without a new prefetch clears it', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(makeStubBackend().backend)
    const k = tileKey(14, 13972, 6344)
    catalog.resetCompileBudget(1)
    catalog.prefetchTiles([k])
    for (let f = 1; f <= 12; f++) {
      catalog.resetCompileBudget(f)
      catalog.cancelStale(new Set())
      catalog.cancelStale(new Set()) // a second ShowCommand in the same frame must not count
    }
    expect(shieldOf(catalog).has(k), 'cleared early — the second call per frame was counted').toBe(
      true,
    )
    catalog.resetCompileBudget(13)
    catalog.cancelStale(new Set())
    expect(shieldOf(catalog).has(k), 'must age out on the 13th FRAME').toBe(false)
  })

  it('a fresh prefetch inside the window re-arms the age (camera still interested)', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(makeStubBackend().backend)
    const k = tileKey(14, 13972, 6344)
    for (let f = 1; f <= 10; f++) {
      catalog.resetCompileBudget(f)
      catalog.cancelStale(new Set())
    }
    catalog.resetCompileBudget(11)
    catalog.prefetchTiles([k]) // age -> 0
    for (let f = 11; f <= 22; f++) {
      catalog.resetCompileBudget(f)
      catalog.cancelStale(new Set())
    }
    expect(shieldOf(catalog).has(k)).toBe(true)
  })

  it('no frame id (-1, the default) keeps the pre-#2273 per-call aging', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(makeStubBackend().backend)
    const k = tileKey(14, 13972, 6344)
    catalog.prefetchTiles([k])
    for (let i = 0; i < 12; i++) catalog.cancelStale(new Set())
    expect(shieldOf(catalog).has(k)).toBe(true)
    catalog.cancelStale(new Set())
    expect(shieldOf(catalog).has(k)).toBe(false)
  })
})
