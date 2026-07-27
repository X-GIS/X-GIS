import { describe, it, expect } from 'vitest'
import {
  MAX_TILE_ATTEMPTS,
  retryDelayFrames,
  tileRequestable,
  noteFailure,
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
