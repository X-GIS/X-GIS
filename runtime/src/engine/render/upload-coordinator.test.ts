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
import { PriorityQueue } from '../../core/priority-queue'
import { UploadCoordinator, type UploadHost, type UploadStore } from './upload-coordinator'
import type { StagingBufferPool } from '../gpu/staging-buffer-pool'
import type { TileData } from '../../data/tile-types'

beforeAll(() => {
  if (typeof (globalThis as Record<string, unknown>).GPUBufferUsage === 'undefined') {
    ;(globalThis as Record<string, unknown>).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
      INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
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
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 14,
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
      alloc: (_b: number) => { if (oom) throw new Error('arena OOM'); return 0 },
      free: vi.fn(),
    }
    const iArena = { buffer: { id: 'i' } as unknown as GPUBuffer, alloc: () => 0, free: vi.fn() }
    const evict = vi.fn((_a: unknown, _b: number) => { oom = false; return true })
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({} as GPUBuffer),
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
      alloc: (_b: number) => { throw new Error('arena OOM') },  // always fails
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
      acquireBuffer: () => ({} as GPUBuffer),
      releaseBuffer: () => {},
      incrementCount: vi.fn(),
      nextUploadEpoch: () => 1,
      forceEvictBytes: () => false,  // frees nothing → retry still fails
    } as unknown as UploadStore

    const markWarned = vi.fn()
    const coord = new UploadCoordinator(makeHost(store, { markWarned }))
    expect(() => coord.uploadSync(99, polyOnlyTileData(), '')).not.toThrow()

    expect(layerCache.has(99)).toBe(false)        // un-cached → retried next frame
    expect(markWarned).toHaveBeenCalled()          // warn-once fired
    expect(vArena.free).not.toHaveBeenCalled()     // no slot claimed → nothing to free
    expect(iArena.free).not.toHaveBeenCalled()
  })
})

describe('UploadCoordinator — queue surface', () => {
  it('pendingCount / queueSize / hasPending / isActive forward the queue; isHeld reflects the cap-deferred set', () => {
    const queue = {
      size: () => 3,
      activeCount: () => 2,
      get running() { return true },
    } as unknown as PriorityQueue<string, void>
    const coord = new UploadCoordinator(makeHost({ getLayer: () => undefined } as unknown as UploadStore), queue)

    expect(coord.queueSize()).toBe(3)
    expect(coord.pendingCount()).toBe(5)     // 3 queued + 2 active
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
    const vArena = { buffer: { id: 'v' } as unknown as GPUBuffer, alloc: () => 0, free: vi.fn() }
    const iArena = { buffer: { id: 'i' } as unknown as GPUBuffer, alloc: () => 0, free: vi.fn() }
    const store = {
      getLayer: () => undefined,
      getOrCreateLayer: () => layerCache,
      polyVertexArenaOrCreate: () => vArena,
      polyIndexArenaOrCreate: () => iArena,
      polyVertexArenaOrNull: () => vArena,
      polyIndexArenaOrNull: () => iArena,
      acquireBuffer: () => ({} as GPUBuffer),
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
    await new Promise(r => setTimeout(r, 0))
    await Promise.resolve()

    expect(layerCache.has(7)).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

// ── host builder ──
function makeHost(store: UploadStore, over: Partial<UploadHost> = {}): UploadHost {
  return {
    device: ({ queue: { writeBuffer: () => {} } } as unknown as GPUDevice),
    stagingPool: ({} as unknown as StagingBufferPool),
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
