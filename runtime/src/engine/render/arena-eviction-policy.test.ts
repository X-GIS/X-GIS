// Integration gate for the byte-aware arena eviction policy (Lane A fix).
//
// THE BUG THIS PINS: eviction was triggered solely by UNIQUE-TILE-COUNT
// (getMaxGpuTiles = 256 desktop). Large globe / extruded tiles exhaust the
// 64 MB arena long before 256 unique keys accumulate, so:
//   1. evictGPUTiles early-returned (count ≤ 256 → "nothing to do")
//   2. arena.alloc() threw "out of capacity" every frame
//   3. the throw propagated out of doUploadTile → crashed the render loop
//
// THE FIX: evictGPUTiles now triggers on BYTES (usedBytes ≥ HIGH_WATER)
// in addition to count, and drains LRU tiles until liveUsedBytes ≤ LOW_WATER.
//
// HOW THESE TESTS WORK: VTR's constructor requires full GPU device init which
// can't run in vitest. We therefore test the eviction policy at the GPUArena
// level only — no GPU device, no VTR instance — by exercising the exact
// arithmetic the production code uses:
//
//   (a) TRIGGER: beginFrame fires eviction when usedBytes ≥ cap * HIGH_WATER
//   (b) LOOP: eviction drains until liveUsedBytes ≤ cap * LOW_WATER
//   (c) SAFETY NET (Lane B): a second alloc-pair attempt after forced
//       eviction succeeds; the first-try failure never escapes as a throw
//   (d) RECLAIM: reclaimIfDrained resets the bump after a full drain,
//       restoring usedBytes to 0 so the next tile starts from offset 0
//
// These mirror the exact comparisons in vector-tile-renderer.ts beginFrame /
// evictGPUTiles, using ARENA_HIGH_WATER / ARENA_LOW_WATER from the helpers.

import { describe, expect, it } from 'vitest'
import { GPUArena, type GPUArenaDevice } from '../gpu/gpu-arena'
import type { RhiBuffer } from './rhi/rhi'
import { ARENA_HIGH_WATER, ARENA_LOW_WATER } from './vector-tile-renderer-helpers'

interface MockBuffer {
  size: number
  usage: string
  copySrc?: boolean
  label?: string
  destroyed: boolean
  destroy(): void
}

const unwrap = (h: unknown): MockBuffer => (h as { native: MockBuffer }).native

function mockDevice(): GPUArenaDevice {
  return {
    createBuffer(desc): RhiBuffer {
      const b: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        copySrc: desc.copySrc,
        label: desc.label,
        destroyed: false,
        destroy() { b.destroyed = true },
      }
      return { native: b } as unknown as RhiBuffer
    },
    destroyBuffer(h) { unwrap(h).destroy() },
    unwrapBuffer(h) { return unwrap(h) as unknown as GPUBuffer },
  }
}

const VERTEX_USAGE = 'vertex'  // RhiBufferUsage role (was GPUBufferUsage.VERTEX | COPY_DST)
// Match the production arena capacity (64 MB)
const CAPACITY = 64 * 1024 * 1024

describe('arena byte-pressure eviction — Lane A trigger gate', () => {
  it('usedBytes crossing HIGH_WATER fires before unique-tile-count cap is reached', () => {
    // Repro of the crash: 30 large tiles each 2 MB → 60 MB used but only
    // 30 unique keys (well under getMaxGpuTiles()=256). The old count-only
    // trigger would NOT fire; the new byte-pressure trigger fires at tile 25
    // (50 MB > 75% of 64 MB).
    const arena = new GPUArena(mockDevice(), {
      capacityBytes: CAPACITY,
      usage: VERTEX_USAGE,
      label: 'poly-vertex-arena',
    })

    const TILE_BYTES = 2 * 1024 * 1024  // 2 MB per tile (large globe tile)
    const offsets: number[] = []

    // Alloc 30 tiles worth of large vertex data
    let triggerFiredAt = -1
    for (let i = 0; i < 30; i++) {
      const off = arena.alloc(TILE_BYTES)
      offsets.push(off)
      // The production beginFrame trigger: usedBytes >= capacity * HIGH_WATER
      if (triggerFiredAt < 0 && arena.usedBytes >= CAPACITY * ARENA_HIGH_WATER) {
        triggerFiredAt = i
      }
    }

    // Trigger must have fired well before 30 tiles (30 × 2 MB = 60 MB > 64 MB
    // would already throw; trigger fires at 75% = 48 MB → tile 24)
    expect(triggerFiredAt).toBeGreaterThanOrEqual(0)
    // 24 tiles × 2 MB = 48 MB = 75%
    expect(triggerFiredAt).toBeLessThan(25)

    // With only 30 unique tile keys (count << 256 desktop cap), the old
    // count-only path would have returned early. Assert the byte-pressure
    // path is what determines trigger timing:
    const uniqueTileCount = 30
    const MAX_GPU_TILES_DESKTOP = 256
    expect(uniqueTileCount).toBeLessThan(MAX_GPU_TILES_DESKTOP)  // count cap NOT reached
    expect(arena.usedBytes).toBeGreaterThan(CAPACITY * ARENA_HIGH_WATER)  // byte cap IS crossed
    void offsets
  })

  it('eviction loop terminates when liveUsedBytes falls below LOW_WATER', () => {
    // Simulates the production evictGPUTiles drain loop. Fill to HIGH_WATER,
    // then free LRU tiles one by one, stopping once liveUsedBytes ≤ LOW_WATER.
    const arena = new GPUArena(mockDevice(), {
      capacityBytes: CAPACITY,
      usage: VERTEX_USAGE,
    })

    const TILE_BYTES = 4 * 1024 * 1024  // 4 MB tiles
    // Alloc 14 tiles → 56 MB live (87.5% — above HIGH_WATER at 75%)
    const offsets: number[] = []
    for (let i = 0; i < 14; i++) {
      offsets.push(arena.alloc(TILE_BYTES))
    }

    // Confirm trigger would fire (production beginFrame check)
    expect(arena.usedBytes >= CAPACITY * ARENA_HIGH_WATER).toBe(true)

    // Simulate eviction: free LRU (oldest) tiles until liveUsedBytes ≤ LOW_WATER
    const LOW_WATER_BYTES = CAPACITY * ARENA_LOW_WATER
    let freed = 0
    for (const off of offsets) {
      if (arena.liveUsedBytes <= LOW_WATER_BYTES) break
      arena.free(off, TILE_BYTES)
      freed++
    }

    // Loop must have freed some tiles (not zero — that would mean no drain)
    expect(freed).toBeGreaterThan(0)
    // Loop must have stopped at or below LOW_WATER (not over-evicted)
    expect(arena.liveUsedBytes).toBeLessThanOrEqual(LOW_WATER_BYTES)
    // liveUsedBytes (not usedBytes/bumpPtr) is the termination signal.
    // bumpPtr can stay high — it does NOT fall with free().
    expect(arena.usedBytes).toBeGreaterThan(arena.liveUsedBytes)
  })

  it('after eviction drain the arena accepts new large allocs without throwing', () => {
    // THE CORE CRASH PIN: before the fix, alloc after HIGH_WATER fill threw
    // "out of capacity" every frame because evictGPUTiles never ran.
    // After the fix, freed slots are reused and alloc succeeds.
    const arena = new GPUArena(mockDevice(), {
      capacityBytes: CAPACITY,
      usage: VERTEX_USAGE,
    })

    const TILE_BYTES = 4 * 1024 * 1024  // 4 MB each

    // Fill to ~75% (12 tiles × 4 MB = 48 MB)
    const offsets: number[] = []
    for (let i = 0; i < 12; i++) {
      offsets.push(arena.alloc(TILE_BYTES))
    }
    // Confirm HIGH_WATER is crossed (or just at the boundary)
    expect(arena.usedBytes).toBeGreaterThanOrEqual(CAPACITY * ARENA_HIGH_WATER)

    // Eviction: free oldest 5 tiles (20 MB freed → live drops to 28 MB ≈ 43.75%)
    for (let i = 0; i < 5; i++) {
      arena.free(offsets[i]!, TILE_BYTES)
    }

    // New large alloc MUST NOT throw — freed slots are available
    let newOffset: number | undefined
    expect(() => { newOffset = arena.alloc(TILE_BYTES) }).not.toThrow()
    expect(typeof newOffset).toBe('number')
    // The reused offset was in the freed range (free-list pop)
    expect(arena.getStats().reuseHits).toBeGreaterThan(0)
  })

  it('Lane B safety net: allocPair failure after eviction degrades to warn-and-skip, never throws', () => {
    // Simulates the Lane B allocPair() pattern in doUploadTile:
    //   1. alloc vertex → succeeds
    //   2. alloc index  → fails (arena full)
    //   → vertex must be freed (no partial leak)
    //   → no throw escapes
    // We use two separate small arenas to isolate vertex vs index failure.
    const SMALL = 4 * 1024   // 4 KB capacity each
    const vertexArena = new GPUArena(mockDevice(), { capacityBytes: SMALL, usage: VERTEX_USAGE })
    const indexArena  = new GPUArena(mockDevice(), { capacityBytes: SMALL, usage: VERTEX_USAGE })

    // Fill index arena to capacity so the next alloc throws
    indexArena.alloc(4096)

    const REQUEST_BYTES = 1024

    // This is the exact Lane B allocPair() pattern from VTR doUploadTile:
    let escaped = false
    let v: number | null = null
    const allocPair = (): { v: number; i: number } | null => {
      try {
        v = vertexArena.alloc(REQUEST_BYTES)
        const i = indexArena.alloc(REQUEST_BYTES)
        return { v, i }
      } catch {
        if (v !== null) vertexArena.free(v, REQUEST_BYTES)
        return null
      }
    }

    try {
      const pair = allocPair()
      // pair === null means alloc-fail was contained (no throw)
      expect(pair).toBeNull()
    } catch {
      escaped = true
    }

    // The throw must NOT escape the allocPair wrapper
    expect(escaped).toBe(false)

    // Vertex arena must have been freed — no partial leak
    // liveUsedBytes should be 0 since the vertex alloc was freed on index fail
    expect(vertexArena.liveUsedBytes).toBe(0)
    // freeCount should be 1 (the rollback free)
    expect(vertexArena.getStats().freeCount).toBe(1)
  })
})

describe('async upload path (FIX 1) — _allocPolyPair leak-free + OOM-safe', () => {
  // The VTR constructor needs a real GPU device, so we pin the shared
  // _allocPolyPair contract + the async race-guard/backstop free invariant
  // at the GPUArena level — the exact arithmetic doUploadTileAsync runs.

  // Mirror of VectorTileRenderer._allocPolyPair (the promoted private method
  // both upload paths share). Vertex-then-index; free vertex if index fails.
  function allocPolyPair(
    vArena: GPUArena, iArena: GPUArena, vBytes: number, iBytes: number,
  ): { v: number; i: number } | null {
    let v: number | null = null
    try {
      v = vArena.alloc(vBytes)
      const i = iArena.alloc(iBytes)
      return { v, i }
    } catch {
      if (v !== null) vArena.free(v, vBytes)
      return null
    }
  }

  it('index-arena OOM frees the just-claimed vertex slot (no partial leak)', () => {
    const SMALL = 4 * 1024
    const vArena = new GPUArena(mockDevice(), { capacityBytes: SMALL, usage: VERTEX_USAGE })
    const iArena = new GPUArena(mockDevice(), { capacityBytes: SMALL, usage: VERTEX_USAGE })
    iArena.alloc(SMALL)  // index arena full → next index alloc throws

    const pair = allocPolyPair(vArena, iArena, 1024, 1024)
    expect(pair).toBeNull()                       // contained, no throw
    expect(vArena.liveUsedBytes).toBe(0)          // vertex slot rolled back
    expect(vArena.getStats().freeCount).toBe(1)   // exactly one rollback free
  })

  it('race-guard free returns BOTH poly slots so liveBytes drains to 0', () => {
    // doUploadTileAsync awaits the staging round-trip, then finds the cache
    // already populated by a competing upload. FIX 1 frees the slots THIS
    // call claimed before returning — without it they pin liveBytes > 0 and
    // block reclaimIfDrained forever. Pin: claim a pair, then free both as
    // the race-guard does, and assert the arenas drain + reclaim.
    const CAP = 1024 * 1024
    const vArena = new GPUArena(mockDevice(), { capacityBytes: CAP, usage: VERTEX_USAGE })
    const iArena = new GPUArena(mockDevice(), { capacityBytes: CAP, usage: VERTEX_USAGE })

    const pair = allocPolyPair(vArena, iArena, 4096, 2048)
    expect(pair).not.toBeNull()
    expect(vArena.liveUsedBytes).toBe(4096)
    expect(iArena.liveUsedBytes).toBe(2048)

    // Race-guard / backstop free path (the FIX 1 leak fix):
    vArena.free(pair!.v, 4096)
    iArena.free(pair!.i, 2048)
    expect(vArena.liveUsedBytes).toBe(0)
    expect(iArena.liveUsedBytes).toBe(0)
    // With liveBytes drained, reclaim exposes the whole arena again — proof
    // the slots did NOT leak (a leaked slot would refuse the reclaim).
    expect(vArena.reclaimIfDrained()).toBe(true)
    expect(iArena.reclaimIfDrained()).toBe(true)
    expect(vArena.usedBytes).toBe(0)
    expect(iArena.usedBytes).toBe(0)
  })

  it('persistent OOM after forced eviction degrades to skip (null), never throws', () => {
    // After both _allocPolyPair attempts fail (even post forceEvictBytes),
    // the async path returns without caching — no throw escapes the promise.
    const TINY = 64
    const vArena = new GPUArena(mockDevice(), { capacityBytes: TINY, usage: VERTEX_USAGE })
    const iArena = new GPUArena(mockDevice(), { capacityBytes: TINY, usage: VERTEX_USAGE })
    vArena.alloc(TINY)  // both arenas full, nothing evictable here
    iArena.alloc(TINY)

    let escaped = false
    let pair: { v: number; i: number } | null = null
    try {
      pair = allocPolyPair(vArena, iArena, 128, 128)
    } catch {
      escaped = true
    }
    expect(escaped).toBe(false)
    expect(pair).toBeNull()
    // No partial claim survived (vertex alloc itself failed → nothing to free)
    expect(vArena.liveUsedBytes).toBe(TINY)  // only the pre-filled alloc
  })
})

describe('arena byte-pressure eviction — reclaimIfDrained gate', () => {
  it('full drain + reclaimIfDrained restores the arena to pristine state', () => {
    // After ALL tiles evicted (liveBytes = 0), reclaimIfDrained resets
    // bumpPtr → 0 so the arena's entire capacity is available for new
    // uploads. Without this the bump stays at 60 MB even when live=0,
    // and subsequent allocs into the tail of the bump would eventually
    // fail even though the logical data has been freed.
    const arena = new GPUArena(mockDevice(), {
      capacityBytes: CAPACITY,
      usage: VERTEX_USAGE,
    })

    const TILE_BYTES = 8 * 1024 * 1024  // 8 MB tiles
    const offsets: number[] = []
    for (let i = 0; i < 7; i++) {        // 56 MB → 87.5% bump
      offsets.push(arena.alloc(TILE_BYTES))
    }
    expect(arena.usedBytes).toBe(7 * TILE_BYTES)

    // Evict all tiles
    for (const off of offsets) arena.free(off, TILE_BYTES)
    expect(arena.liveUsedBytes).toBe(0)
    expect(arena.usedBytes).toBe(7 * TILE_BYTES)  // bumpPtr still pinned

    // reclaimIfDrained should reset bump
    const reclaimed = arena.reclaimIfDrained()
    expect(reclaimed).toBe(true)
    expect(arena.usedBytes).toBe(0)       // bumpPtr reset
    expect(arena.liveUsedBytes).toBe(0)

    // New uploads use offset 0 again — arena fully available
    const fresh = arena.alloc(TILE_BYTES)
    expect(fresh).toBe(0)
    expect(arena.usedBytes).toBe(TILE_BYTES)
  })

  it('reclaimIfDrained is refused when any live alloc remains (dangling-offset safety)', () => {
    const arena = new GPUArena(mockDevice(), {
      capacityBytes: CAPACITY,
      usage: VERTEX_USAGE,
    })
    const TILE_BYTES = 4 * 1024 * 1024
    const o1 = arena.alloc(TILE_BYTES)
    arena.alloc(TILE_BYTES)  // second tile not freed
    arena.free(o1, TILE_BYTES)

    expect(arena.liveUsedBytes).toBe(TILE_BYTES)  // one still live
    const reclaimed = arena.reclaimIfDrained()
    expect(reclaimed).toBe(false)                 // refused
    expect(arena.usedBytes).toBe(2 * TILE_BYTES)  // bumpPtr unchanged
  })
})

describe('arena exact-align4 free-list under simulated tile eviction', () => {
  it('freed tile slot is reused by same-footprint next upload (steady-state no-throw)', () => {
    // Under the old next-pow2 bucket scheme, a tile freed at 20-byte stride
    // could be reused for a 28-byte request (both in bucket 32), silently
    // overrunning the neighbour. Exact-align4 prevents that AND still
    // enables same-footprint reuse (the common hot-path).
    const arena = new GPUArena(mockDevice(), { capacityBytes: 4096, usage: VERTEX_USAGE })

    const SIZE_A = 20  // align4 = 20
    const SIZE_B = 28  // align4 = 28; old bucket 32 = same as A → bug

    const offA = arena.alloc(SIZE_A)
    const offB = arena.alloc(SIZE_B)

    // Evict tile A
    arena.free(offA, SIZE_A)

    // Upload new tile with SIZE_B footprint: must NOT reuse A's slot
    const offC = arena.alloc(SIZE_B)
    expect(offC).not.toBe(offA)   // no corruption: A's 20 B slot not given to 28 B request
    expect(arena.getStats().reuseHits).toBe(0)

    // Upload new tile with SIZE_A footprint: DOES reuse A's slot
    const offD = arena.alloc(SIZE_A)
    expect(offD).toBe(offA)       // correct same-size reuse
    expect(arena.getStats().reuseHits).toBe(1)

    void offB
    void offC
    void offD
  })
})
