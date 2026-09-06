import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  MAX_TILE_ATTEMPTS,
  COLD_START_PARENT_SLOTS,
  retryDelayMs,
  hasPendingRetries,
  MAX_FAILED_TILES,
  tileRequestable,
  noteFailure,
  leafLoadBudget,
  InflightLedger,
  FailedTileLedger,
  RASTER_INFLIGHT_KEEP_WARM_MS,
  type FailedTile,
} from './tile-retry'

afterEach(() => vi.restoreAllMocks())

// The defect this encodes: a DEM tile whose load resolved null was in neither the
// tile cache nor the in-flight set, so the next frame re-requested it — forever.
// A DEM source has a real max zoom (terrarium stops at z15) and rasterCoverZoom asks
// for zoom+1 on a 256-px source, so zooming past it makes EVERY visible tile a
// permanent 404 and the storm pins all 6 concurrency slots.
//
// #1575 moved the clock from RENDERED FRAMES to wall-clock ms. The numbers below are the
// same durations the frame counter intended at 60 fps (30/120/480 frames = 0.5/2/8 s);
// what changed is that they now advance when the map is idle, which is exactly when a
// failed tile needs them to. The frame counter froze with the loop, so a transiently
// failed tile could never reach its first retry on a static camera.
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
    expect(tileRequestable(failed.get('k'), 499)).toBe(false)
    expect(tileRequestable(failed.get('k'), 500)).toBe(true) // 1st retry after 0.5 s

    noteFailure(failed, 'k', 500)
    expect(tileRequestable(failed.get('k'), 2_499)).toBe(false)
    expect(tileRequestable(failed.get('k'), 2_500)).toBe(true) // 2nd after 2 s more

    noteFailure(failed, 'k', 2_500)
    expect(tileRequestable(failed.get('k'), 10_499)).toBe(false)
    expect(tileRequestable(failed.get('k'), 10_500)).toBe(true) // 3rd after 8 s more
  })

  it('abandons the tile after the attempt cap, however long you wait', () => {
    const failed = new Map<string, FailedTile>()
    for (let i = 0; i < MAX_TILE_ATTEMPTS; i++) noteFailure(failed, 'k', i)
    expect(failed.get('k')!.attempts).toBe(MAX_TILE_ATTEMPTS)
    expect(tileRequestable(failed.get('k'), 1_000_000)).toBe(false)
  })

  it('bounds total doomed requests — a permanent 404 costs attempts, not a per-frame storm', () => {
    // Simulate the past-max-zoom case over 10 minutes of rendering at 60 fps and
    // count how many requests the tile would actually cost. One tick = one 60 fps frame
    // of wall time, so this drives the same shape the frame-counter version did.
    const failed = new Map<string, FailedTile>()
    let requests = 0
    for (let ms = 0; ms < 600_000; ms += 16) {
      if (tileRequestable(failed.get('k'), ms)) {
        requests++
        noteFailure(failed, 'k', ms)
      }
    }
    expect(requests).toBe(MAX_TILE_ATTEMPTS) // was one per frame
  })

  it('the backoff curve is exponential and starts at half a second', () => {
    expect(retryDelayMs(1)).toBe(500)
    expect(retryDelayMs(2)).toBe(2_000)
    expect(retryDelayMs(3)).toBe(8_000)
    // Defensive: a 0/negative attempt count must not produce a 0 delay (which
    // would re-open the every-frame storm).
    expect(retryDelayMs(0)).toBe(500)
    expect(retryDelayMs(-1)).toBe(500)
  })

  it('counts attempts per tile, not globally', () => {
    const failed = new Map<string, FailedTile>()
    noteFailure(failed, 'a', 0)
    noteFailure(failed, 'a', 500)
    noteFailure(failed, 'b', 500)
    expect(failed.get('a')!.attempts).toBe(2)
    expect(failed.get('b')!.attempts).toBe(1)
    // 'b' is on its FIRST backoff, so it is free again 0.5 s later while 'a'
    // (second failure, 2 s) still is not.
    expect(tileRequestable(failed.get('b'), 1_000)).toBe(true)
    expect(tileRequestable(failed.get('a'), 1_000)).toBe(false)
  })
})

// ═══ #1575 — the ledger has to be readable, and it has to be bounded ═══
describe('retry keep-warm signal', () => {
  it('is true while a tile can still come back, and false once it is abandoned', () => {
    const failed = new Map<string, FailedTile>()
    expect(hasPendingRetries(failed), 'nothing failed ⇒ nothing to stay warm for').toBe(false)

    noteFailure(failed, 'k', 0)
    // The load-bearing case: the loop must keep rendering, because `tileRequestable` is
    // only ever consulted from inside render(). A wall clock nothing reads is no better
    // than the frozen frame counter it replaced.
    expect(hasPendingRetries(failed)).toBe(true)

    // …and it TERMINATES, which is what separates this from a loop that never idles.
    for (let i = 1; i < MAX_TILE_ATTEMPTS; i++) noteFailure(failed, 'k', i * 100_000)
    expect(failed.get('k')!.attempts).toBe(MAX_TILE_ATTEMPTS)
    expect(hasPendingRetries(failed), 'an abandoned tile must let the map idle').toBe(false)
  })

  it('one live tile among abandoned ones still keeps the loop warm', () => {
    const failed = new Map<string, FailedTile>()
    for (let i = 0; i < MAX_TILE_ATTEMPTS; i++) noteFailure(failed, 'dead', i * 100_000)
    noteFailure(failed, 'live', 0)
    // Without this arm, a `some`/`every` mix-up would pass the case above.
    expect(hasPendingRetries(failed)).toBe(true)
  })
})

describe('failed-tile ledger is bounded', () => {
  it('caps at MAX_FAILED_TILES over an unbounded key space', () => {
    // Panning across a broken region inserts one entry per tile that is never revisited,
    // and these entries have no TTL — the abandon-until-re-armed contract is deliberate —
    // so the cap is the only bound there is. The vector sibling has had one since #282.
    const failed = new Map<string, FailedTile>()
    for (let i = 0; i < MAX_FAILED_TILES + 500; i++) noteFailure(failed, `14/${i}/2000`, i)
    expect(failed.size).toBe(MAX_FAILED_TILES)
    // FIFO: the oldest keys go first, so the tiles the camera most recently failed on —
    // the ones it is still looking at — are the ones that keep their backoff.
    expect(failed.has('14/0/2000')).toBe(false)
    expect(failed.has(`14/${MAX_FAILED_TILES + 499}/2000`)).toBe(true)
  })
})

// ═══ #2574 — InflightLedger's two readers must never disagree about a hung entry ═══
//
// `size` (the concurrency budget) and `liveCount()` (the idle signal) read one Map. A
// tile whose fetch never settles used to leave `size` counting it forever while
// `liveCount()` alone went deadline-bounded — so a black-holing host wedged every
// concurrency slot permanently even though the map reported itself idle.
describe('InflightLedger records the reap, so a dead host is not re-asked forever (#2574)', () => {
  it('routes the timeout into the failed-tile ledger instead of leaving the tile requestable', () => {
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    // Exactly the wiring both owners use (raster-renderer.ts, dem-tile-store.ts).
    const failed = new FailedTileLedger()
    const ledger = new InflightLedger((key) => failed.noteOutcome(key, false))
    const key = '16/1/1'

    ledger.set(key, new AbortController())
    clock += RASTER_INFLIGHT_KEEP_WARM_MS + 1
    expect(ledger.size).toBe(0) // reaped

    // WITHOUT the callback this is `true`: `noteOutcome(key, aborted: true)` records
    // nothing, so the load loop's only gate (`if (!failedTiles.requestable(key)) continue`)
    // lets the same dead host be re-asked on the next frame — a reap every deadline,
    // forever, which is the storm the slot reclamation on its own would have created.
    expect(failed.requestable(key), 'a just-reaped tile must not be immediately requestable').toBe(
      false,
    )
  })

  it('gives up after MAX_TILE_ATTEMPTS, so the map can report itself loaded again', () => {
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const failed = new FailedTileLedger()
    const ledger = new InflightLedger((key) => failed.noteOutcome(key, false))
    const key = '16/2/2'

    // A host that never answers: each round is one request reaped at the deadline.
    for (let i = 0; i < MAX_TILE_ATTEMPTS; i++) {
      clock += retryDelayMs(i) + 1 // past the backoff this attempt earned
      ledger.set(key, new AbortController())
      clock += RASTER_INFLIGHT_KEEP_WARM_MS + 1
      expect(ledger.size).toBe(0)
    }

    // Terminal, exactly as a 404 host already reaches — no amount of waiting reopens it,
    // which is what makes `getMissingTileCount() === 0` mean what it says.
    clock += 60 * 60 * 1000
    expect(failed.requestable(key), 'a permanently dead host must be abandoned').toBe(false)
  })
})

describe('InflightLedger reaps a hung entry (#2574)', () => {
  it('reclaims the concurrency slot at the same deadline liveCount() already used', () => {
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const ledger = new InflightLedger()
    const ctrl = new AbortController()
    ledger.set('16/1/1', ctrl)

    expect(ledger.size).toBe(1)
    expect(ledger.liveCount()).toBe(1)

    // Still inside the deadline: both readers agree the entry is live, and the fetch
    // has not been touched.
    clock += RASTER_INFLIGHT_KEEP_WARM_MS
    expect(ledger.liveCount()).toBe(1)
    expect(ctrl.signal.aborted).toBe(false)

    // One tick past the deadline: before the fix `size` stayed 1 for the rest of the
    // session (nothing ever pruned the entry) while `liveCount()` had already dropped
    // to 0 — the exact "not-pending yet still-holding-a-slot" disagreement #2574
    // reports. The fix reaps the entry at the SAME deadline, so `size` now agrees, and
    // the hung fetch is actually aborted rather than left to leak.
    clock += 1
    expect(ledger.size, 'the concurrency slot must be reclaimed, not held forever').toBe(0)
    expect(ledger.liveCount()).toBe(0)
    expect(ctrl.signal.aborted, 'the hung fetch is aborted, not merely uncounted').toBe(true)
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
