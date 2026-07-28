import { describe, it, expect } from 'vitest'
import {
  MAX_TILE_ATTEMPTS,
  COLD_START_PARENT_SLOTS,
  retryDelayFrames,
  tileRequestable,
  noteFailure,
  leafLoadBudget,
  type FailedTile,
} from './hillshade-tile-retry'

// The defect this encodes: a DEM tile whose load resolved null was in neither the
// tile cache nor the in-flight set, so the next frame re-requested it — forever.
// A DEM source has a real max zoom (terrarium stops at z15) and rasterCoverZoom asks
// for zoom+1 on a 256-px source, so zooming past it makes EVERY visible tile a
// permanent 404 and the storm pins all 6 concurrency slots.
describe('hillshade failed-tile backoff', () => {
  it('lets a tile that has never failed through', () => {
    expect(tileRequestable(undefined, 0)).toBe(true)
    expect(tileRequestable(undefined, 9_999)).toBe(true)
  })

  it('blocks the very next frame after a failure — the actual bug', () => {
    const failed = new Map<string, FailedTile>()
    noteFailure(failed, '16/1/1', 100)
    // Before: this returned true every frame forever.
    expect(tileRequestable(failed.get('16/1/1'), 101)).toBe(false)
  })

  it('releases the tile once its backoff has elapsed, and backs off further each time', () => {
    const failed = new Map<string, FailedTile>()
    noteFailure(failed, 'k', 0)
    expect(tileRequestable(failed.get('k'), 29)).toBe(false)
    expect(tileRequestable(failed.get('k'), 30)).toBe(true) // 1st retry after 30

    noteFailure(failed, 'k', 30)
    expect(tileRequestable(failed.get('k'), 149)).toBe(false)
    expect(tileRequestable(failed.get('k'), 150)).toBe(true) // 2nd after 120 more

    noteFailure(failed, 'k', 150)
    expect(tileRequestable(failed.get('k'), 629)).toBe(false)
    expect(tileRequestable(failed.get('k'), 630)).toBe(true) // 3rd after 480 more
  })

  it('abandons the tile after the attempt cap, however long you wait', () => {
    const failed = new Map<string, FailedTile>()
    for (let i = 0; i < MAX_TILE_ATTEMPTS; i++) noteFailure(failed, 'k', i)
    expect(failed.get('k')!.attempts).toBe(MAX_TILE_ATTEMPTS)
    expect(tileRequestable(failed.get('k'), 1_000_000)).toBe(false)
  })

  it('bounds total doomed requests — a permanent 404 costs attempts, not a per-frame storm', () => {
    // Simulate the past-max-zoom case over 10 minutes of rendering at 60 fps and
    // count how many requests the tile would actually cost.
    const failed = new Map<string, FailedTile>()
    let requests = 0
    for (let frame = 0; frame < 36_000; frame++) {
      if (tileRequestable(failed.get('k'), frame)) {
        requests++
        noteFailure(failed, 'k', frame)
      }
    }
    expect(requests).toBe(MAX_TILE_ATTEMPTS) // was 36_000 — one per frame
  })

  it('the backoff curve is exponential and starts at half a second', () => {
    expect(retryDelayFrames(1)).toBe(30)
    expect(retryDelayFrames(2)).toBe(120)
    expect(retryDelayFrames(3)).toBe(480)
    // Defensive: a 0/negative attempt count must not produce a 0 delay (which
    // would re-open the every-frame storm).
    expect(retryDelayFrames(0)).toBe(30)
    expect(retryDelayFrames(-1)).toBe(30)
  })

  it('counts attempts per tile, not globally', () => {
    const failed = new Map<string, FailedTile>()
    noteFailure(failed, 'a', 0)
    noteFailure(failed, 'a', 30)
    noteFailure(failed, 'b', 30)
    expect(failed.get('a')!.attempts).toBe(2)
    expect(failed.get('b')!.attempts).toBe(1)
    // 'b' is on its FIRST backoff, so it is free again 30 frames later while 'a'
    // (second failure) still is not.
    expect(tileRequestable(failed.get('b'), 60)).toBe(true)
    expect(tileRequestable(failed.get('a'), 60)).toBe(false)
  })
})

// The defect this encodes: on the FIRST frame the leaf loop breaks only at the full
// concurrency budget, so it consumed all 6 slots and the parent-fallback prefetch
// directly below it got none. Nothing was drawable until a full-resolution DEM tile
// landed — and those are ~131-143 KB (terrarium PNG) against ~19-28 KB for a satellite
// JPEG over the same ground, so "empty until the leaves arrive" is exactly the
// slow-to-appear symptom hillshade has and the raster basemap does not.
describe('hillshade cold-start load budget', () => {
  it('holds slots back for the parent prefetch when nothing is cached', () => {
    // Before: 6 — every slot to leaves, zero coarse tiles requested on frame 1.
    expect(leafLoadBudget(6, 0)).toBe(6 - COLD_START_PARENT_SLOTS)
  })

  it('gives the leaf loop the full budget as soon as anything is drawable', () => {
    // Leaf-first is load-bearing under pitch / mixed LOD — it must come back
    // unchanged the moment there is coverage to fall back on.
    expect(leafLoadBudget(6, 1)).toBe(6)
    expect(leafLoadBudget(6, 500)).toBe(6)
  })

  it('never starves the leaf loop to zero, whatever the concurrency limit', () => {
    // A budget of 0 would deadlock the cold start: no leaf ever requested, so the
    // cache never becomes non-empty, so the budget never recovers.
    expect(leafLoadBudget(1, 0)).toBe(1)
    expect(leafLoadBudget(2, 0)).toBe(1)
    expect(leafLoadBudget(COLD_START_PARENT_SLOTS, 0)).toBeGreaterThan(0)
  })
})
