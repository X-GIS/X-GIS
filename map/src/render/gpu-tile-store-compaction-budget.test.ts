// Gate for the arena-compaction BUDGET + FUTILITY GATE (#1515 — the release-side hitch).
//
// THE BUG. `GpuTileStore._compactPolyArenas` relocated the live set of BOTH poly arenas in
// ONE `runFrameMaintenance` pass, and nothing checked whether the relocation could achieve
// anything. `GPUArena.compact()` finishes with `bumpPtr === liveBytes`, so a SECOND same-size
// repack of an untouched arena provably reclaims zero bytes — yet `forceEvictBytes` re-raises
// `_pendingArenaCompaction` on every alloc-fail it cannot serve and may not grow out of (at
// the auto-grow ceiling, or when the live set is not over-capacity), and nothing frees
// mid-frame. Under sustained arena pressure the store therefore re-relocated the whole live
// set EVERY FRAME: a fresh full-capacity `createBuffer`, one `copyBufferToBuffer` per resident
// tile per arena, and `bundleCache.invalidateAll()` forcing a total bundle re-encode. That is
// the freeze "when tiles are released" in #1515, and it is sustained rather than one-off.
//
// THE FIX. `render/arena-compaction-budget.ts` decides each pass: drop a same-size repack that
// cannot reclaim `MIN_RECLAIM_BYTES`, and charge what survives against
// `RELOCATION_BUDGET_BYTES`, deferring the remainder to the next pass. A one-arena floor plus
// an alternating charge cursor make starvation impossible.
//
// ORACLE. The store's `rhi` seam is a recording stub, so every `copyBufferToBuffer` this
// module would issue is counted in BYTES — the quantity the budget is written in, not a proxy
// for it. The arenas are REAL `GPUArena`s over a stub device, so `bumpPtr`/`liveBytes`/
// `compactionCount` are the allocator's own accounting rather than the test's.
//
// FAIL-BEFORE (both arms go red on the pre-fix code, for the right reason):
//   • "each pass relocates at most the budget" — pre-fix pass 1 copies BOTH arenas (40 MiB
//     against a 32 MiB budget).
//   • "an already-packed arena is not relocated" — pre-fix each pass copies the whole live set
//     again, forever, and bumps `compactionCount` every time.

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from '@xgis/map'
import { GPUArena, type GPUArenaDevice } from '@xgis/engine'
import type { RhiBuffer, RhiDevice } from '@xgis/engine'
import {
  planArenaCompaction,
  MIN_RECLAIM_BYTES,
  RELOCATION_BUDGET_BYTES,
} from './arena-compaction-budget'

const MIB = 1024 * 1024

interface MockBuffer {
  size: number
  destroyed: boolean
  destroy(): void
}
function makeBuffer(size: number): MockBuffer {
  const b: MockBuffer = {
    size,
    destroyed: false,
    destroy() {
      b.destroyed = true
    },
  }
  return b
}

/** The pooled-buffer half of the store's constructor — never exercised here. */
function mockGpuDevice(): GPUDevice {
  return {
    createBuffer: (desc: GPUBufferDescriptor): GPUBuffer =>
      makeBuffer(desc.size) as unknown as GPUBuffer,
  } as unknown as GPUDevice
}

/** The RHI seam compaction actually routes through. Records the SIZE of every copy so a pass's
 *  relocation volume is measured in the same unit the budget is declared in. */
function recordingRhi(): { rhi: RhiDevice; copyBytes: number[] } {
  const copyBytes: number[] = []
  const rhi = {
    createCommandEncoder: () => ({
      copyBufferToBuffer(
        _src: RhiBuffer,
        _srcOffset: number,
        _dst: RhiBuffer,
        _dstOffset: number,
        size: number,
      ) {
        copyBytes.push(size)
      },
      finish: () => ({}),
    }),
    destroyBuffer(b: RhiBuffer) {
      ;(b as unknown as MockBuffer).destroy()
    },
  }
  return { rhi: rhi as unknown as RhiDevice, copyBytes }
}

function arenaDevice(): GPUArenaDevice {
  return {
    createBuffer: (desc): RhiBuffer => makeBuffer(desc.size) as unknown as RhiBuffer,
    destroyBuffer: (h) => (h as unknown as MockBuffer).destroy(),
  }
}

type StorePriv = {
  polyVertexArena: GPUArena | null
  polyIndexArena: GPUArena | null
  gpuCache: Map<string, Map<number, Record<string, unknown>>>
  _gpuCacheCount: number
  _pendingArenaCompaction: boolean
  forceEvictBytes(
    a: GPUArena,
    needed: number,
    stable: readonly number[],
    hook: (k: string) => void,
  ): boolean
  runFrameMaintenance(
    stable: readonly number[],
    hook: (k: string) => void,
    up: () => boolean,
  ): boolean
}

/** Build a store whose two poly arenas hold `liveTiles` cached slots of `slotBytes` each,
 *  interleaved with freed slots of HALF that size.
 *
 *  The half-size is load-bearing, not decoration. `GPUArena`'s free-list is keyed on the EXACT
 *  align4 footprint, so a freed slot of the same size would simply be popped by the next alloc
 *  and no fragmentation would exist — the harness would then measure a packed arena and prove
 *  nothing. Mismatched footprints are precisely what the allocator strands, and stranded bytes
 *  (`highWaterBytes - liveUsedBytes`) are what a same-size repack exists to hand back. */
function fragmentedStore(opts: { capacity: number; slotBytes: number; liveTiles: number }): {
  store: GpuTileStore
  inj: StorePriv
  vArena: GPUArena
  iArena: GPUArena
  copyBytes: number[]
  keys: number[]
} {
  const { rhi, copyBytes } = recordingRhi()
  const store = new GpuTileStore(mockGpuDevice(), rhi)
  const inj = store as unknown as StorePriv
  const dev = arenaDevice()
  const vArena = new GPUArena(dev, {
    capacityBytes: opts.capacity,
    usage: 'vertex',
    copySrc: true,
  })
  const iArena = new GPUArena(dev, { capacityBytes: opts.capacity, usage: 'index', copySrc: true })
  inj.polyVertexArena = vArena
  inj.polyIndexArena = iArena

  const inner = new Map<number, Record<string, unknown>>()
  inj.gpuCache.set('', inner)
  const keys: number[] = []
  const doomedBytes = opts.slotBytes / 2
  for (let i = 0; i < opts.liveTiles; i++) {
    const vOff = vArena.alloc(opts.slotBytes)
    const iOff = iArena.alloc(opts.slotBytes)
    const vDoomed = vArena.alloc(doomedBytes)
    const iDoomed = iArena.alloc(doomedBytes)
    vArena.free(vDoomed, doomedBytes)
    iArena.free(iDoomed, doomedBytes)
    inner.set(i, {
      polyVertexOffset: vOff,
      polyVertexByteLength: opts.slotBytes,
      polyIndexOffset: iOff,
      polyIndexByteLength: opts.slotBytes,
      zBufferOffset: 0,
      zBufferByteLength: 0,
      lineVertexBuffer: null,
      lineIndexBuffer: null,
      outlineIndexBuffer: null,
      outlineSegmentBuffer: null,
      lineSegmentBuffer: null,
      featureDataBuffer: null,
      vertexBuffer: vArena.rhiBuffer,
      indexBuffer: iArena.rhiBuffer,
      lastUsedFrame: 1,
      tileZoom: 14,
    })
    inj._gpuCacheCount++
    keys.push(i)
  }
  return { store, inj, vArena, iArena, copyBytes, keys }
}

const NO_UPLOADS = () => false
const NO_HOOK = () => {}

describe('GpuTileStore arena-compaction budget (#1515)', () => {
  it('splits an over-budget relocation across passes — each pass stays within the budget', () => {
    // 20 live MiB per arena = 40 MiB of relocation against a 32 MiB per-pass budget, so the
    // two arenas cannot both be relocated in one pass.
    const { inj, vArena, iArena, copyBytes, keys } = fragmentedStore({
      capacity: 128 * MIB,
      slotBytes: MIB,
      liveTiles: 20,
    })
    expect(vArena.liveUsedBytes + iArena.liveUsedBytes).toBeGreaterThan(RELOCATION_BUDGET_BYTES)
    inj._pendingArenaCompaction = true

    const perPass: number[] = []
    let compactedPasses = 0
    for (let pass = 0; pass < 4; pass++) {
      const before = copyBytes.length
      if (inj.runFrameMaintenance(keys, NO_HOOK, NO_UPLOADS)) compactedPasses++
      perPass.push(copyBytes.slice(before).reduce((a, b) => a + b, 0))
    }

    // THE BOUND. Pre-fix, pass 1 alone copies 40 MiB.
    for (const bytes of perPass) {
      expect(
        bytes,
        `a pass relocated ${bytes} bytes against a ${RELOCATION_BUDGET_BYTES} budget`,
      ).toBeLessThanOrEqual(RELOCATION_BUDGET_BYTES)
    }
    // NO STARVATION. Both arenas are relocated exactly once, and the work is finished — not
    // merely postponed: the pending flag is clear and later passes are free.
    expect(vArena.compactionCount).toBe(1)
    expect(iArena.compactionCount).toBe(1)
    expect(compactedPasses).toBe(2)
    expect(inj._pendingArenaCompaction).toBe(false)
    // MONOTONIC PROGRESS: the deferred arena went next, it did not restart from zero.
    expect(perPass[0]).toBeGreaterThan(0)
    expect(perPass[1]).toBeGreaterThan(0)
    expect(perPass[2]).toBe(0)
  })

  it('leaves both arenas packed and internally consistent after the split compaction', () => {
    const { inj, vArena, iArena, keys } = fragmentedStore({
      capacity: 128 * MIB,
      slotBytes: MIB,
      liveTiles: 20,
    })
    inj._pendingArenaCompaction = true
    for (let pass = 0; pass < 3; pass++) inj.runFrameMaintenance(keys, NO_HOOK, NO_UPLOADS)

    // Fragmentation is gone in BOTH arenas: bump collapsed onto the live total.
    for (const a of [vArena, iArena]) {
      expect(a.highWaterBytes).toBe(a.liveUsedBytes)
      expect(a.liveUsedBytes).toBe(20 * MIB)
      expect(a.getStats().freeBytes).toBe(0)
    }
    // Every tile now addresses the CURRENT buffer at a packed, non-overlapping offset.
    const inner = inj.gpuCache.get('')!
    const vSeen = new Set<number>()
    const iSeen = new Set<number>()
    for (const tile of inner.values()) {
      expect(tile.vertexBuffer).toBe(vArena.rhiBuffer)
      expect(tile.indexBuffer).toBe(iArena.rhiBuffer)
      const vOff = tile.polyVertexOffset as number
      const iOff = tile.polyIndexOffset as number
      expect(vOff % MIB).toBe(0)
      expect(vOff).toBeLessThan(20 * MIB)
      expect(vSeen.has(vOff)).toBe(false)
      expect(iSeen.has(iOff)).toBe(false)
      vSeen.add(vOff)
      iSeen.add(iOff)
    }
    expect(vSeen.size).toBe(20)
    expect(iSeen.size).toBe(20)
    // The reclaimed headroom is real, and the number DISTINGUISHES: 100 MiB does not fit the
    // pre-compaction bump (30 + 100 > 128) and does fit the packed one (20 + 100 ≤ 128), so
    // this arm goes red if the split compaction quietly relocated nothing.
    expect(() => vArena.alloc(100 * MIB)).not.toThrow()
  })

  it('does NOT relocate an already-packed arena, however many times it is re-flagged', () => {
    // The every-frame relocation loop. An arena straight out of a compaction has
    // bumpPtr === liveBytes, so a same-size repack can hand back nothing — but forceEvictBytes
    // keeps re-raising the flag while the pressure lasts.
    const { inj, vArena, iArena, copyBytes, keys } = fragmentedStore({
      capacity: 64 * MIB,
      slotBytes: MIB,
      liveTiles: 8,
    })
    // Drain the fragmentation first, so both arenas are genuinely packed.
    inj._pendingArenaCompaction = true
    for (let pass = 0; pass < 3; pass++) inj.runFrameMaintenance(keys, NO_HOOK, NO_UPLOADS)
    expect(vArena.compactionCount).toBe(1)
    expect(iArena.compactionCount).toBe(1)

    const copiesAfterDrain = copyBytes.length
    for (let frame = 0; frame < 5; frame++) {
      inj._pendingArenaCompaction = true // what forceEvictBytes does under sustained pressure
      expect(inj.runFrameMaintenance(keys, NO_HOOK, NO_UPLOADS)).toBe(false)
    }
    // Pre-fix this recorded 5 × 16 MiB of copies and five bundle-cache invalidations.
    expect(copyBytes.length).toBe(copiesAfterDrain)
    expect(vArena.compactionCount).toBe(1)
    expect(iArena.compactionCount).toBe(1)
  })

  it('records no copy outside the post-submit window — forceEvictBytes only FLAGS', () => {
    // The store's oldest invariant (class header #2): the relocating copyBufferToBuffer runs
    // ONLY in runFrameMaintenance. The budget must not have moved work forward into the
    // mid-render alloc-fail path.
    const { inj, vArena, copyBytes, keys } = fragmentedStore({
      capacity: 16 * MIB,
      slotBytes: MIB,
      liveTiles: 4,
    })
    // Pin the bump pointer at capacity WITHOUT raising the live total: alloc the remaining
    // headroom and free it straight back. That is the fragmentation branch of forceEvictBytes
    // (live+needed still fits the capacity, so it flags a compaction rather than a grow), with
    // nothing evictable because every cached key is protected.
    const filler = vArena.capacityBytes - vArena.highWaterBytes
    vArena.free(vArena.alloc(filler), filler)
    expect(inj.forceEvictBytes(vArena, 4 * MIB, keys, NO_HOOK)).toBe(false)
    expect(inj._pendingArenaCompaction).toBe(true)
    expect(copyBytes.length, 'compaction copied mid-render').toBe(0)

    inj.runFrameMaintenance(keys, NO_HOOK, NO_UPLOADS)
    expect(copyBytes.length).toBeGreaterThan(0)
  })
})

describe('planArenaCompaction — the policy on its own', () => {
  const frag = (liveBytes: number, reclaimableBytes = 8 * MIB) => ({
    liveBytes,
    reclaimableBytes,
    grow: false,
  })

  it('skips a same-size repack that cannot reclaim MIN_RECLAIM_BYTES', () => {
    expect(planArenaCompaction(frag(MIB, 0), null, false).vertex).toBe('skip')
    expect(planArenaCompaction(frag(MIB, MIN_RECLAIM_BYTES - 1), null, false).vertex).toBe('skip')
    expect(planArenaCompaction(frag(MIB, MIN_RECLAIM_BYTES), null, false).vertex).toBe('run')
  })

  it('exempts an auto-grow request from the futility gate', () => {
    // The point of a grow is the LARGER destination buffer, so zero reclaimable bytes — and
    // even an empty arena, when one allocation exceeds the whole capacity — must not cancel it.
    const grow = { liveBytes: 0, reclaimableBytes: 0, grow: true }
    expect(planArenaCompaction(grow, null, false).vertex).toBe('run')
  })

  it('runs both arenas when their combined relocation fits the budget', () => {
    const plan = planArenaCompaction(frag(4 * MIB), frag(4 * MIB), false)
    expect(plan).toEqual({ vertex: 'run', index: 'run' })
  })

  it('defers the second arena when the pair exceeds the budget', () => {
    const big = RELOCATION_BUDGET_BYTES - MIB
    expect(planArenaCompaction(frag(big), frag(big), false)).toEqual({
      vertex: 'run',
      index: 'defer',
    })
    // The cursor decides WHICH one wins the floor — that is what stops either arena from
    // being the perpetual loser across a run of re-flagged passes.
    expect(planArenaCompaction(frag(big), frag(big), true)).toEqual({
      vertex: 'defer',
      index: 'run',
    })
  })

  it('runs a single over-budget arena anyway — the floor, not a deadlock', () => {
    const huge = RELOCATION_BUDGET_BYTES * 4
    expect(planArenaCompaction(frag(huge), null, false).vertex).toBe('run')
  })
})
