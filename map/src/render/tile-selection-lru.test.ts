// GATE B1 (#1153 #12) — the tile-selection memo is a per-margin LRU, not a
// single slot. Two alternating cull margins at a FIXED camera + frameId must hit
// the cache (the 7-16 ms quadtree walk runs ONCE per distinct margin, not once
// per show), and a camera move (new frameId) / invalidateFrame() must invalidate.
//
// The walk count is instrumented via TileSelectionCache.selectionComputeCount()
// (a cache-MISS counter). The old single slot ping-ponged: the sequence
// [marginA, marginB, marginA, marginB] recomputed FOUR times; the LRU recomputes
// TWICE (once per distinct margin) then hits.

import { describe, expect, it } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

// Minimal flat-mercator-path catalog (same surface slice-zoom-range-cull uses):
// maxLevel + hasEntryInIndex for the ancestor walk. No layer range → no cull.
function fakeCatalog(maxLevel: number): TileCatalog {
  return {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
  } as unknown as TileCatalog
}

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

// selectForFrame at a fixed camera (Tokyo, z14, mercator flat path). marginPx and
// frameId vary per call; everything else is frame-constant.
function select(
  cache: TileSelectionCache,
  source: TileCatalog,
  frameId: number,
  marginPx: number,
  camera: Camera,
) {
  return cache.selectForFrame(
    camera,
    0, // projType — mercator (flat selection path)
    0,
    0,
    1024,
    768,
    1,
    frameId,
    source,
    '', // no sliceLayer → skip the per-layer minzoom cull
    marginPx,
    source.maxLevel,
    NO_STATS,
  )
}

describe('TileSelectionCache — per-margin LRU (#1153 #12)', () => {
  it('alternating margins at a fixed camera+frame hit the cache (walk runs once per distinct margin)', () => {
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    const A = 2
    const B = 8

    // First touch of each margin → one walk each.
    expect(select(cache, source, 1, A, camera)).not.toBeNull()
    expect(cache.selectionComputeCount()).toBe(1)
    expect(select(cache, source, 1, B, camera)).not.toBeNull()
    expect(cache.selectionComputeCount()).toBe(2)

    // Now ping-pong the two margins within the SAME frame — the single slot would
    // recompute every time (→ 8); the LRU serves both from cache (stays 2).
    for (let i = 0; i < 6; i++) {
      select(cache, source, 1, A, camera)
      select(cache, source, 1, B, camera)
    }
    expect(cache.selectionComputeCount()).toBe(2)
  })

  it('a Bright-like frame (many shows, few distinct margins) walks once per distinct margin, not per show', () => {
    // GATE B2 mechanism (deterministic proxy for the headed OFM-bright run): a
    // Bright/Liberty source feeds ~13 layer ShowCommands per frame. Their stroke-
    // derived cull margins collapse to a handful of distinct values. The single
    // slot re-walked on every margin change (up to ~13 walks/frame); the LRU
    // walks once per DISTINCT margin, then hits.
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 15)
    // 13 shows, 3 distinct margins (2, 3, 6) interleaved as a real style would be.
    const showMargins = [2, 3, 2, 6, 3, 2, 6, 2, 3, 6, 2, 3, 6]

    for (const mgn of showMargins) select(cache, source, 1, mgn, camera)
    // 3 distinct margins → 3 walks for the whole 13-show frame (was up to 13).
    expect(cache.selectionComputeCount()).toBe(3)

    // Next frame, camera moved (new frameId): the 3 margins re-walk once each
    // (~1 walk per camera change per distinct margin, not per show).
    for (const mgn of showMargins) select(cache, source, 2, mgn, camera)
    expect(cache.selectionComputeCount()).toBe(6)
  })

  it('a camera move (new frameId) invalidates every slot — both margins re-walk', () => {
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    select(cache, source, 1, 2, camera)
    select(cache, source, 1, 8, camera)
    expect(cache.selectionComputeCount()).toBe(2)

    // frameId bumps on any camera/canvas change → the frameId guard misses for
    // every cached margin, re-selecting exactly as the single slot did.
    select(cache, source, 2, 2, camera)
    select(cache, source, 2, 8, camera)
    expect(cache.selectionComputeCount()).toBe(4)

    // Still cached within the new frame.
    select(cache, source, 2, 2, camera)
    select(cache, source, 2, 8, camera)
    expect(cache.selectionComputeCount()).toBe(4)
  })

  it('invalidateFrame() clears the LRU', () => {
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    select(cache, source, 1, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)
    // Same frameId + margin → would hit…
    select(cache, source, 1, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)
    // …but invalidateFrame() drops the memo, so the next identical query re-walks.
    cache.invalidateFrame()
    expect(cache.frameTileCache()).toBeNull()
    select(cache, source, 1, 2, camera)
    expect(cache.selectionComputeCount()).toBe(2)
  })

  it('frameTileCache() returns the most-recently-used entry (single-slot semantics for readers)', () => {
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    const selA = select(cache, source, 1, 2, camera)
    const selB = select(cache, source, 1, 8, camera)
    // MRU is margin 8 (last computed) — its neededKeys match selB.
    expect(cache.frameTileCache()?.marginPx).toBe(8)
    expect(cache.frameTileCache()?.neededKeys).toEqual(selB!.neededKeys)
    // Touch margin 2 again → it becomes MRU.
    select(cache, source, 1, 2, camera)
    expect(cache.frameTileCache()?.marginPx).toBe(2)
    expect(cache.frameTileCache()?.neededKeys).toEqual(selA!.neededKeys)
  })

  it('each cached margin owns its parentAtMaxLevel/archiveAncestor arrays (no shared-scratch clobber)', () => {
    // Over-zoom so parentAtMaxLevel is populated (tz > maxLevel). Two margins must
    // not alias the same arrays — recomputing one must not corrupt the other.
    const cache = new TileSelectionCache()
    const source = fakeCatalog(4) // low maxLevel → z14 tiles over-zoom
    const camera = new Camera(139.767, 35.681, 14)

    const a = select(cache, source, 1, 2, camera)
    const b = select(cache, source, 1, 8, camera)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // Distinct array identities per entry.
    expect(a!.parentAtMaxLevel).not.toBe(b!.parentAtMaxLevel)
    expect(a!.archiveAncestor).not.toBe(b!.archiveAncestor)
    // Re-serving margin 2 from cache returns the SAME (uncorrupted) arrays.
    const a2 = select(cache, source, 1, 2, camera)
    expect(a2!.parentAtMaxLevel).toBe(a!.parentAtMaxLevel)
    expect(a2!.parentAtMaxLevel).toEqual(a!.parentAtMaxLevel)
  })
})
