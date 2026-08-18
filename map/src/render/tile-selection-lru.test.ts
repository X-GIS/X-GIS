// GATE B1 (#1153 #12) — the tile-selection memo is a per-margin LRU, not a
// single slot. Two alternating cull margins at a FIXED camera must hit the
// cache (the 7-16 ms quadtree walk runs ONCE per distinct margin, not once
// per show), and a REAL camera move / a landed tile / invalidateFrame() must
// invalidate.
//
// #1581 leg A corrected the validity key from `frameId` (which bumps on
// every RENDERED frame, not only on camera/canvas change — see
// tile-selection-cache.ts) to the camera signature + indexGeneration. `select`
// below still takes a `frameId`-shaped counter argument for readability, but
// it is no longer part of the cache key; only `camera` (and `indexGeneration`
// via `catalogGen`) drive invalidation now.
//
// The walk count is instrumented via TileSelectionCache.selectionComputeCount()
// (a cache-MISS counter). The old single slot ping-ponged: the sequence
// [marginA, marginB, marginA, marginB] recomputed FOUR times; the LRU recomputes
// TWICE (once per distinct margin) then hits.

import { describe, expect, it } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import type { TileCatalog } from '@xgis/data'
import { FrameDrawStats } from './frame-draw-stats'

// Minimal flat-mercator-path catalog (same surface slice-zoom-range-cull uses):
// maxLevel + hasEntryInIndex for the ancestor walk. No layer range → no cull.
// `indexGeneration` is mutable so tests can simulate a tile landing.
function fakeCatalog(maxLevel: number): TileCatalog & { gen: number } {
  const catalog = {
    maxLevel,
    gen: 0,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
    indexGeneration(): number {
      return catalog.gen
    },
  }
  return catalog as unknown as TileCatalog & { gen: number }
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

    // #1581 leg A — the NEXT rendered frame at the SAME (untouched) camera
    // must NOT re-walk: this is the exact case a keep-alive animation or a
    // permanent flow field puts the loop in at 60 Hz. frameId (here, the
    // `select` counter arg) bumping alone is no longer part of the cache key.
    for (const mgn of showMargins) select(cache, source, 2, mgn, camera)
    expect(cache.selectionComputeCount()).toBe(3)
  })

  it('more distinct margins than slots — a margin already walked THIS frame is never re-walked', () => {
    // The slot cap must clear the frame's real distinct-margin count, or the LRU
    // evicts an entry the SAME frame still needs and re-walks it — the exact
    // ping-pong the LRU exists to kill, one N up. Measured (RTX 2080, OFM Bright
    // z14 Tokyo, wheel zoom) via selectionComputeCount(): D = 10 distinct walks per
    // frame median, 14 max. At 8 slots a sweep of 12 margins evicts each one before
    // the second pass reaches it, so EVERY access misses: 24 walks, not 12.
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    // 12 distinct stroke-derived margins — inside the measured D = 10..14 band.
    const margins = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20]

    // Pass 1 — first touch of each margin walks once, by definition.
    for (const mgn of margins) expect(select(cache, source, 1, mgn, camera)).not.toBeNull()
    expect(cache.selectionComputeCount()).toBe(margins.length)

    // Pass 2 — SAME frame, same margins. Every one was computed in this frame, so
    // every one must still be resident and the walk count must not move.
    for (const mgn of margins) expect(select(cache, source, 1, mgn, camera)).not.toBeNull()
    expect(cache.selectionComputeCount()).toBe(margins.length)
  })

  it('a REAL camera move invalidates every slot — both margins re-walk', () => {
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    select(cache, source, 1, 2, camera)
    select(cache, source, 1, 8, camera)
    expect(cache.selectionComputeCount()).toBe(2)

    // Actually move the camera (zoom change) — the camera-signature guard
    // misses for every cached margin, re-selecting exactly as the single
    // slot did.
    camera.zoom = 15
    select(cache, source, 2, 2, camera)
    select(cache, source, 2, 8, camera)
    expect(cache.selectionComputeCount()).toBe(4)

    // Still cached at the new camera state.
    select(cache, source, 2, 2, camera)
    select(cache, source, 2, 8, camera)
    expect(cache.selectionComputeCount()).toBe(4)
  })

  it('#1581 leg A — a STATIC camera across many rendered frames never re-walks after the first', () => {
    // The falsifiable prediction the issue states directly: with the camera
    // untouched, selectionComputeCount() must NOT rise per rendered frame.
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    select(cache, source, 1, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)

    // 60 further "rendered frames" (frameId keeps incrementing — a
    // keep-alive animation or a permanent flow field holds the loop hot),
    // camera never touched.
    for (let f = 2; f <= 61; f++) select(cache, source, f, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)
  })

  it('#1785 — globeTilesSelected survives a cache HIT on a static camera (sphere-routed, maxLevel=0)', () => {
    // The diagnostic's own doc says it is "set only on the globe branch" — that
    // branch is the cache-MISS quadtree walk. #1581 (the leg-A tests above) made
    // the LRU survive across frames instead of clearing every frame, but nothing
    // taught the diagnostic to follow: `drawStats.beginFrame()` resets it to 0
    // every frame regardless, and pre-fix only a fresh compute set it back. A
    // STATIC camera over a z0-only source (this test's shape: orthographic,
    // maxLevel=0 — the synthetic earth-surface backend's own catalog) hits the
    // cache on every frame after the first, so the diagnostic read 0 forever
    // despite the selection (and the draw) being correct throughout — the exact
    // false negative `_synth-bg-ortho-pitch80-gate.spec.ts` measured on main.
    const stats = new FrameDrawStats()
    const cache = new TileSelectionCache()
    const source = fakeCatalog(0) // z0-only archive, matching the synthetic backend
    const camera = new Camera(0, 0, 0)
    camera.pitch = 80

    const selectOrtho = (frameId: number) => {
      stats.beginFrame() // the real per-frame reset selectForFrame's callers do
      const sel = cache.selectForFrame(
        camera,
        3, // projType — orthographic, routes through globeVisibleTiles
        0,
        0,
        1280,
        720,
        1,
        frameId,
        source,
        '',
        0,
        source.maxLevel,
        stats,
      )
      return { sel, globeTilesSelected: stats.getDrawStats().globeTilesSelected }
    }

    // Frame 1 — cache MISS, fresh compute. globeVisibleTiles' containsTarget
    // always keeps the root tile (it covers the whole world), so exactly 1.
    const f1 = selectOrtho(1)
    expect(f1.sel).not.toBeNull()
    expect(cache.selectionComputeCount()).toBe(1)
    expect(f1.globeTilesSelected).toBe(1)

    // Frames 2..10 — camera untouched, so every one is a cache HIT (mirrors the
    // "STATIC camera" leg-A test above: selectionComputeCount stays 1). The
    // diagnostic must stay truthful on every one of them, not just the first.
    for (let f = 2; f <= 10; f++) {
      const { sel, globeTilesSelected } = selectOrtho(f)
      expect(sel, `frame ${f}`).not.toBeNull()
      expect(globeTilesSelected, `frame ${f}`).toBe(1)
    }
    expect(cache.selectionComputeCount()).toBe(1) // still one walk — the LRU held
  })

  it('#1581 leg A — a tile landing (indexGeneration bump) invalidates even at a static camera', () => {
    // The landmine the issue flags by name: archiveAncestor is a walk over
    // hasEntryInIndex, so a memo that now survives across frames must still
    // invalidate the instant a tile lands, or it serves pre-landing ancestor
    // data for as long as the camera stays still.
    const cache = new TileSelectionCache()
    const source = fakeCatalog(15)
    const camera = new Camera(139.767, 35.681, 14)

    select(cache, source, 1, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)
    // Static camera, next frame — would hit (see the test above).
    select(cache, source, 2, 2, camera)
    expect(cache.selectionComputeCount()).toBe(1)

    // A tile lands.
    source.gen++
    select(cache, source, 3, 2, camera)
    expect(cache.selectionComputeCount()).toBe(2)

    // CONTROL — settles again: no further landings, no further re-walks.
    select(cache, source, 4, 2, camera)
    expect(cache.selectionComputeCount()).toBe(2)
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
