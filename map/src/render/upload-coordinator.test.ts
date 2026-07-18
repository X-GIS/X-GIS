// Focused unit tests for UploadCoordinator — the logic that was previously
// locked INLINE in VectorTileRenderer's twin `doUploadTile` /
// `doUploadTileAsync` bodies and is now independently testable:
//   * Lane-B OOM recovery: alloc-fail → forced byte-eviction → retry once.
//   * OOM exhaustion: both attempts fail → warn-once, tile un-cached, no leak.
//   * Queue surface: pendingCount / queueSize / hasPending / isActive / isHeld.
//   * Async dispatch end-to-end (staging-pool write strategy) → tile cached,
//     single submit — driven through the real priority queue with the
//     staging pool's SwiftShader direct-write fallback (no GPU needed).

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PriorityQueue } from '@xgis/shared'
import { UploadCoordinator, type UploadHost, type UploadStore } from './upload-coordinator'
import type { RhiBuffer, RhiDevice } from '@xgis/engine'
import type { StagingBufferPool } from '@xgis/rhi-webgpu'
import type { TileData } from '@xgis/data'

beforeAll(() => {
  if (typeof (globalThis as Record<string, unknown>).GPUBufferUsage === 'undefined') {
    ;(globalThis as Record<string, unknown>).GPUBufferUsage = {
      MAP_READ: 0x0001,
      MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004,
      COPY_DST: 0x0008,
      INDEX: 0x0010,
      VERTEX: 0x0020,
      UNIFORM: 0x0040,
      STORAGE: 0x0080,
      INDIRECT: 0x0100,
      QUERY_RESOLVE: 0x0200,
    }
  }
})

/** Minimal poly-only TileData (no line/outline/segments) so the tests focus
 *  on the polygon arena alloc + OOM path. */
function polyOnlyTileData(): TileData {
  return {
    vertices: new Float32Array([0, 0, 0, 0, 0, 0]),
    dequantScale: 1,
    dequantHalf: 0,
    indices: new Uint32Array([0, 1, 2]),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    outlineIndices: new Uint32Array(0),
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 1,
    tileHeight: 1,
    tileZoom: 14,
  }
}

describe('UploadCoordinator — Lane-B OOM recovery (sync path)', () => {
  it('alloc-fail → forced byte-eviction on BOTH arenas → retry succeeds → tile cached', () => {
    const layerCache = new Map<number, unknown>()
    // Vertex arena throws on alloc while `oom` is set; forceEvictBytes clears
    // it, so the post-eviction retry succeeds.
    let oom = true
    const vArena = {
      buffer: { id: 'v' } as unknown as GPUBuffer,
      alloc: (_b: number) => {
        if (oom) throw new Error('arena OOM')
        return 0
      },
      free: vi.fn(),
    }
    const iArena = { buffer: { id: 'i' } as unknown as GPUBuffer, alloc: () => 0, free: vi.fn() }
    const evict = vi.fn((_a: unknown, _b: number) => {
      oom = false
      return true
    })
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({}) as GPUBuffer,
      releaseBuffer: () => {},
      incrementCount: vi.fn(),
      nextUploadEpoch: () => 7,
      forceEvictBytes: evict,
    } as unknown as UploadStore

    const coord = new UploadCoordinator(makeHost(store))
    coord.uploadSync(42, polyOnlyTileData(), '')

    // Forced eviction ran for BOTH arenas, then the retry cached the tile.
    expect(evict).toHaveBeenCalledTimes(2)
    expect(layerCache.has(42)).toBe(true)
    // No slot was freed (the successful alloc is owned by the cache entry).
    expect(vArena.free).not.toHaveBeenCalled()
    expect(iArena.free).not.toHaveBeenCalled()
  })

  it('persistent OOM (eviction frees nothing) → tile un-cached, warn-once, no leak', () => {
    const layerCache = new Map<number, unknown>()
    const vArena = {
      buffer: {} as GPUBuffer,
      alloc: (_b: number) => {
        throw new Error('arena OOM')
      }, // always fails
      free: vi.fn(),
    }
    const iArena = { buffer: {} as GPUBuffer, alloc: () => 0, free: vi.fn() }
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({}) as GPUBuffer,
      releaseBuffer: () => {},
      incrementCount: vi.fn(),
      nextUploadEpoch: () => 1,
      forceEvictBytes: () => false, // frees nothing → retry still fails
    } as unknown as UploadStore

    const markWarned = vi.fn()
    const coord = new UploadCoordinator(makeHost(store, { markWarned }))
    expect(() => coord.uploadSync(99, polyOnlyTileData(), '')).not.toThrow()

    expect(layerCache.has(99)).toBe(false) // un-cached → retried next frame
    expect(markWarned).toHaveBeenCalled() // warn-once fired
    expect(vArena.free).not.toHaveBeenCalled() // no slot claimed → nothing to free
    expect(iArena.free).not.toHaveBeenCalled()
  })
})

describe('UploadCoordinator — queue surface', () => {
  it('pendingCount / queueSize / hasPending / isActive forward the queue; isHeld reflects the cap-deferred set', () => {
    const queue = {
      size: () => 3,
      activeCount: () => 2,
      get running() {
        return true
      },
    } as unknown as PriorityQueue<string, void>
    const coord = new UploadCoordinator(
      makeHost({ getLayer: () => undefined } as unknown as UploadStore),
      queue,
    )

    expect(coord.queueSize()).toBe(3)
    expect(coord.pendingCount()).toBe(5) // 3 queued + 2 active
    expect(coord.hasPending()).toBe(true)
    expect(coord.isActive()).toBe(true)

    expect(coord.isHeld(123)).toBe(false)
    ;(coord as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys.add(123)
    expect(coord.isHeld(123)).toBe(true)
  })
})

describe('UploadCoordinator — async dispatch end-to-end (staging write strategy)', () => {
  it('queued upload caches the tile via the staging pool + a single submit', async () => {
    const layerCache = new Map<number, unknown>()
    const vArena = { rhiBuffer: { id: 'v' } as unknown as RhiBuffer, alloc: () => 0, free: vi.fn() }
    const iArena = { rhiBuffer: { id: 'i' } as unknown as RhiBuffer, alloc: () => 0, free: vi.fn() }
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({}) as GPUBuffer,
      releaseBuffer: () => {},
      incrementCount: vi.fn(),
      nextUploadEpoch: () => 5,
      forceEvictBytes: () => false,
    } as unknown as UploadStore

    const submit = vi.fn()
    const device = {
      createCommandEncoder: () => ({ copyBufferToBuffer: () => {}, finish: () => ({}) }),
      queue: { submit, writeBuffer: () => {} },
    } as unknown as GPUDevice
    // SwiftShader-style direct-write fallback so asyncWriteBuffer skips the
    // real mapAsync round-trip and resolves immediately (no GPU).
    const stagingPool = {
      hasMappedAtCreationFallback: true,
      gpuDevice: device,
    } as unknown as StagingBufferPool

    const coord = new UploadCoordinator(makeHost(store, { device, stagingPool }))
    coord.enqueue(7, polyOnlyTileData(), '')

    // Let the queue's microtask dispatch + the async dispatch settle.
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()

    expect(layerCache.has(7)).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('UploadCoordinator — render-on-demand starvation (held uploads count as pending)', () => {
  // Regression guard for the render-on-demand freeze. enqueue() defers slices
  // beyond the per-frame cap into `_heldUploads`; those are replayed ONLY by
  // resetFrameCap() at the next beginFrame. If hasPending()/pendingCount()
  // report only the visible queue, the render-on-demand loop can stop the
  // instant that queue self-drains — freezing every held slice forever
  // (half-loaded map far from the camera, permanent ancestor fallback, missing
  // labels). hasPending() must stay true and pendingCount() must include held
  // until the queue truly converges.

  // Read the CURRENT `_heldUploads` length — resetFrameCap() swaps in a fresh
  // array, so a captured reference goes stale.
  const heldLen = (c: UploadCoordinator) =>
    (c as unknown as { _heldUploads: unknown[] })._heldUploads.length
  // One setTimeout(0) macrotask flushes the queue's queueMicrotask dispatch +
  // each job's `await _dispatch` continuation; the extra tick is belt-and-braces.
  const flushMicrotasks = async () => {
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
  }

  it('held (cap-deferred) uploads keep hasPending() true and are counted after the visible queue drains', async () => {
    // No cached layers → enqueue proceeds. getOrCreateLayer reports the key
    // present so _dispatch returns at its top guard (no real GPU work), letting
    // each cap-admitted queue job complete and drain the visible queue.
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => ({ has: () => true }) as unknown as Map<number, unknown>,
    } as unknown as UploadStore
    // webgl2 backend → the cheap SyncWriteSink (the async sink's constructor
    // needs a real command encoder the stub device lacks).
    const coord = new UploadCoordinator(
      makeHost(store, {
        rhi: {
          backend: 'webgl2',
          writeBuffer: () => {},
          unwrapBuffer: (b: unknown) => b,
        } as unknown as RhiDevice,
      }),
    )

    // One "frame": enqueue more slices than the per-frame cap (4 desktop / 1
    // mobile). Six distinct tiles guarantees ≥2 land in _heldUploads either way.
    for (let key = 1; key <= 6; key++) coord.enqueue(key, polyOnlyTileData(), '')
    expect(heldLen(coord)).toBeGreaterThan(0) // scenario actually deferred slices

    // Let the cap-admitted queue jobs dispatch + complete (queueMicrotask).
    await flushMicrotasks()

    // Visible queue is idle now, but held slices remain. FIX CONTRACT: the
    // render-on-demand loop must still see pending work.
    const heldCount = heldLen(coord)
    expect(coord.queueSize()).toBe(0) // visible queue fully drained
    expect(coord.isActive()).toBe(false)
    expect(coord.hasPending()).toBe(true) // ← false before the fix (queue-only)
    expect(coord.pendingCount()).toBe(heldCount) // ← 0 before the fix

    // beginFrame replays held slices; loop until the queue truly converges.
    for (let i = 0; i < 20 && coord.hasPending(); i++) {
      coord.resetFrameCap()
      await flushMicrotasks()
    }
    expect(heldLen(coord)).toBe(0)
    expect(coord.hasPending()).toBe(false)
    expect(coord.pendingCount()).toBe(0)
  })
})

describe('UploadCoordinator — visible-first cap-deferral (zoom-in starvation)', () => {
  // Repro for the reported bug: on a heavy-style zoom-in, a large backlog of
  // cap-deferred upload slices accumulates. Before the fix, `_heldUploads`
  // replayed strict FIFO, so a newly-visible (nearest) slice enqueued AFTER a
  // far/ancestor backlog waited behind the ENTIRE backlog — visible tiles
  // stayed unloaded for many frames (~30 s at a low heavy-style frame rate)
  // even though the upload queue itself is distance-sorted. The cap-hold gate
  // defeated that priority. Fix: drain the held backlog NEAREST-first.

  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
  }

  // Staging store that actually caches the tile (mirrors the async end-to-end
  // test) so `layerCache.has(key)` reports true once a slice is uploaded.
  function makeStagingCoord(layerCache: Map<number, unknown>) {
    const vArena = { rhiBuffer: { id: 'v' } as unknown as RhiBuffer, alloc: () => 0, free: vi.fn() }
    const iArena = { rhiBuffer: { id: 'i' } as unknown as RhiBuffer, alloc: () => 0, free: vi.fn() }
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({}) as GPUBuffer,
      releaseBuffer: () => {},
      incrementCount: vi.fn(),
      nextUploadEpoch: () => 5,
      forceEvictBytes: () => false,
    } as unknown as UploadStore
    const device = {
      createCommandEncoder: () => ({ copyBufferToBuffer: () => {}, finish: () => ({}) }),
      queue: { submit: vi.fn(), writeBuffer: () => {} },
    } as unknown as GPUDevice
    const stagingPool = {
      hasMappedAtCreationFallback: true,
      gpuDevice: device,
    } as unknown as StagingBufferPool
    return new UploadCoordinator(makeHost(store, { device, stagingPool }))
  }

  it('drains the nearest newly-visible slice ahead of a far zoom-in backlog', async () => {
    const layerCache = new Map<number, unknown>()
    const coord = makeStagingCoord(layerCache)
    // distSq proxy: key IS the squared distance. key 1 = nearest visible tile;
    // keys 100..140 = the far ancestor/backlog accumulated during the zoom-in.
    coord.installPriority((key) => key)

    // One "zoom-in frame": the far backlog is requested first, then the
    // current nearest visible slice arrives LAST — exactly the accumulation
    // order a progressive zoom-in produces (shallow ancestors first).
    for (let k = 100; k <= 140; k++) coord.enqueue(k, polyOnlyTileData(), '')
    coord.enqueue(1, polyOnlyTileData(), '') // nearest visible, enqueued last
    await flush()

    // Drain frame-by-frame (beginFrame → resetFrameCap) and record how many
    // frames pass before the nearest visible slice actually uploads.
    let framesUntilVisible = -1
    for (let f = 0; f < 80 && framesUntilVisible < 0; f++) {
      coord.resetFrameCap()
      await flush()
      if (layerCache.has(1)) framesUntilVisible = f
    }

    // FIX CONTRACT: the nearest visible slice must upload within the first
    // couple of replayed frames — NOT after the whole far backlog drains.
    // Before the fix (FIFO) key 1 sits at the back and lands ~frame 9.
    expect(framesUntilVisible).toBeGreaterThanOrEqual(0)
    expect(framesUntilVisible).toBeLessThanOrEqual(1)
  })
})

describe('UploadCoordinator — #1155 F3 cold-start burst enqueue cap', () => {
  // The per-frame slice-enqueue cap is 4 desktop / 1 mobile in steady state;
  // cold-start burst raises it to 8 desktop / 4 mobile so the first-viewport
  // cascade isn't paced out. In the node test env `typeof window` is undefined
  // → the desktop branch, so the cap is 4 (steady) / 8 (burst). The cap is
  // applied SYNCHRONOUSLY in enqueue(), so held-count is observable at once.

  const heldLen = (c: UploadCoordinator) =>
    (c as unknown as { _heldUploads: unknown[] })._heldUploads.length

  function makeCoord(): UploadCoordinator {
    // getOrCreateLayer reports the key present → _dispatch returns at its top
    // guard (no real GPU work); getLayer undefined → enqueue proceeds.
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => ({ has: () => true }) as unknown as Map<number, unknown>,
    } as unknown as UploadStore
    return new UploadCoordinator(
      makeHost(store, {
        rhi: {
          backend: 'webgl2',
          writeBuffer: () => {},
          unwrapBuffer: (b: unknown) => b,
        } as unknown as RhiDevice,
      }),
    )
  }

  it('steady state (desktop) holds the 5th slice enqueued in one frame', () => {
    const coord = makeCoord()
    for (let key = 1; key <= 5; key++) coord.enqueue(key, polyOnlyTileData(), '')
    expect(heldLen(coord)).toBe(1) // 4 admitted, 5th held
  })

  it('with burst on (desktop) 8 slices admit in one frame before holding begins', () => {
    const coord = makeCoord()
    coord.setColdStartBurst(true)
    for (let key = 1; key <= 8; key++) coord.enqueue(key, polyOnlyTileData(), '')
    expect(heldLen(coord)).toBe(0) // all 8 admitted (cap raised 4 → 8)
    coord.enqueue(9, polyOnlyTileData(), '')
    expect(heldLen(coord)).toBe(1) // 9th exceeds the raised cap
  })

  it('clearing the burst flag restores the steady 4-cap (5th held again)', () => {
    const coord = makeCoord()
    coord.setColdStartBurst(true)
    coord.setColdStartBurst(false)
    for (let key = 1; key <= 5; key++) coord.enqueue(key, polyOnlyTileData(), '')
    expect(heldLen(coord)).toBe(1)
  })
})

// ── host builder ──
function makeHost(store: UploadStore, over: Partial<UploadHost> = {}): UploadHost {
  return {
    device: { queue: { writeBuffer: () => {} } } as unknown as GPUDevice,
    rhi: {
      backend: 'webgpu',
      writeBuffer: () => {},
      unwrapBuffer: (b: unknown) => b,
    } as unknown as RhiDevice,
    stagingPool: {} as unknown as StagingBufferPool,
    store,
    lineRenderer: () => null,
    buildPerTileFeatureData: () => null,
    frameCount: () => 0,
    stableKeys: () => [],
    releaseTileHook: () => {},
    hasWarned: () => false,
    markWarned: () => {},
    ...over,
  }
}
