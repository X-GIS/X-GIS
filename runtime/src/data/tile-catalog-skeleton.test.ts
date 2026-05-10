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
import { TileCatalog } from './tile-catalog'
import {
  type TileData,
  MAX_CACHED_TILES,
} from './tile-types'
import {
  type TileSource, type TileSourceMeta, type TileSourceSink,
} from './tile-source'

// Minimal TileData with controllable byte cost. sizeOfTileData sums
// vertices + indices + lineVertices + lineIndices + outlineIndices, so
// putting `floats` Float32 elements in each gives 5 × 4 × floats bytes.
function makeStubTileData(floats: number): TileData {
  const verts = new Float32Array(floats)
  const lineVerts = new Float32Array(floats)
  const idx = new Uint32Array(floats)
  return {
    vertices: verts,
    indices: idx,
    lineVertices: lineVerts,
    lineIndices: idx,
    outlineIndices: idx,
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
  }
}

// Reach into the private setSlice for direct cache injection — same
// escape hatch the multi-layer-overzoom test uses.
function injectSlice(catalog: TileCatalog, key: number, data: TileData): void {
  const slice = (catalog as unknown as {
    setSlice(k: number, layer: string, d: TileData): void
  }).setSlice.bind(catalog)
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
    bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 14,
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
    expect(catalog.hasTileData(keep),
      'skeleton key must survive eviction with no frame-protectedKeys')
      .toBe(true)
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
    expect(catalog.hasTileData(skeletonKey),
      'skeleton survives count-cap-driven LRU eviction')
      .toBe(true)
    let evicted = 0
    for (const k of overflow) {
      if (!catalog.hasTileData(k)) evicted++
    }
    expect(evicted,
      'count-cap eviction must drop ≥ 5 non-skeleton keys')
      .toBeGreaterThanOrEqual(5)
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
    const shield = (catalog as unknown as { _evictShield: Map<number, number> })._evictShield
    expect(shield.has(k)).toBe(false)
    catalog.evictTiles(new Set())
    expect(catalog.hasTileData(k),
      'skeleton must survive without any shield protection')
      .toBe(true)
  })

  it('cancelStale unions skeleton keys into the backend\'s active set', () => {
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
    expect(merged.has(k1),
      'skeleton key 1 must be in cancelStale merged set').toBe(true)
    expect(merged.has(k2),
      'skeleton key 2 must be in cancelStale merged set').toBe(true)
  })
})
