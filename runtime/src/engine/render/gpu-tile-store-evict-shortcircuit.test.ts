// Gate for the at-ceiling eviction-futility short-circuit (a1) — the ARENA-OOM
// LAG fix (NOT the OOM itself; that needs pitch-distance LOD, tier-b).
//
// THE BUG: at z22+pitch / globe-zoom the protected (on-screen) poly working
// set exceeds the 512MB vertex-arena ceiling. forceEvictBytes can't free
// anything (every resident tile is a protected stableKey) and the grow/
// compaction remedy only runs next frame in runFrameMaintenance. Yet the sync
// fallback uploader retries per-tile-per-layer, so forceEvictBytes is called
// O(tiles) times PER FRAME — and each call rebuilds an O(resident-set) Map +
// sort that provably frees 0 bytes. That redundant scan is the lag.
//
// THE FIX: latch the arena "futile" on the first failing call; subsequent
// calls the same frame short-circuit BEFORE the Map-build. Cleared each frame
// in runFrameMaintenance so a moved camera re-attempts a real eviction.
//
// OBSERVATION: a CountingMap whose [Symbol.iterator] increments a counter — the
// Map-build (gpu-tile-store.ts `for (… of this.gpuCache)`) is the only gpuCache
// iteration inside forceEvictBytes, so scanCount == number of full resident
// scans. fail-before (drop `if (futile) return false`): the 2nd same-frame call
// re-scans → scanCount 2 instead of 1.

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from '@xgis/map'
import { GPUArena, type GPUArenaDevice } from '@xgis/engine'
import type { RhiBuffer } from '@xgis/engine'
import { WebGpuDevice } from '@xgis/engine'

interface MockBuffer {
  size: number
  destroyed: boolean
  destroy(): void
}
function mockDevice(): GPUDevice {
  return {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const b: MockBuffer = {
        size: desc.size,
        destroyed: false,
        destroy() {
          b.destroyed = true
        },
      }
      return b as unknown as GPUBuffer
    },
    createCommandEncoder(): GPUCommandEncoder {
      return {
        copyBufferToBuffer() {},
        finish() {
          return {} as GPUCommandBuffer
        },
      } as unknown as GPUCommandEncoder
    },
    queue: { submit() {} },
  } as unknown as GPUDevice
}

// The injected arena drives the RHI device subset (createBuffer→RhiBuffer +
// destroyBuffer). RHI handles wrap as {native}; the arena unwraps `buffer`.
function arenaDevice(): GPUArenaDevice {
  return {
    createBuffer(desc): RhiBuffer {
      const b: MockBuffer = {
        size: desc.size,
        destroyed: false,
        destroy() {
          b.destroyed = true
        },
      }
      return { native: b } as unknown as RhiBuffer
    },
    destroyBuffer(h) {
      ;(h as unknown as { native: MockBuffer }).native.destroy()
    },
    unwrapBuffer(h) {
      return (h as unknown as { native: MockBuffer }).native as unknown as GPUBuffer
    },
  }
}

const VERTEX_USAGE = 'vertex'

/** A Map that counts how many times it is iterated (for…of). An OWN
 *  [Symbol.iterator] shadows the prototype's, so the count is exact and
 *  there's no computed-method-with-generic-return that esbuild mis-parses. */
type ScanMap<K, V> = Map<K, V> & { scanCount: number }
function countingMap<K, V>(): ScanMap<K, V> {
  const m = new Map<K, V>() as ScanMap<K, V>
  m.scanCount = 0
  const orig = m[Symbol.iterator].bind(m)
  ;(m as { [Symbol.iterator]: () => IterableIterator<[K, V]> })[Symbol.iterator] = () => {
    m.scanCount++
    return orig()
  }
  return m
}

type StorePriv = {
  polyVertexArena: GPUArena | null
  gpuCache: Map<string, Map<number, unknown>>
  _gpuCacheCount: number
  _evictFutileV: boolean
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

/** Build an at-ceiling, fully-protected vertex arena (eviction frees 0). */
function atCeilingProtected(store: GpuTileStore): {
  arena: GPUArena
  counting: ScanMap<string, Map<number, unknown>>
} {
  const inj = store as unknown as StorePriv
  const counting = countingMap<string, Map<number, unknown>>()
  inj.gpuCache = counting as unknown as Map<string, Map<number, unknown>>
  const CEIL = 512 * 1024 * 1024
  const arena = new GPUArena(arenaDevice(), {
    capacityBytes: CEIL,
    usage: VERTEX_USAGE,
    copySrc: true,
  })
  inj.polyVertexArena = arena
  const inner = new Map<number, unknown>()
  counting.set('', inner)
  const off = arena.alloc(CEIL - 1024) // bump ≈ ceiling → next alloc fails
  inner.set(0, {
    polyVertexOffset: off,
    polyVertexByteLength: CEIL - 1024,
    polyIndexOffset: 0,
    polyIndexByteLength: 0,
    zBufferOffset: 0,
    zBufferByteLength: 0,
    lineVertexBuffer: null,
    lineIndexBuffer: null,
    outlineIndexBuffer: null,
    outlineSegmentBuffer: null,
    lineSegmentBuffer: null,
    featureDataBuffer: null,
    vertexBuffer: arena.buffer,
    indexBuffer: arena.buffer,
    lastUsedFrame: 1,
  })
  inj._gpuCacheCount++
  return { arena, counting }
}

describe('GpuTileStore forceEvictBytes — at-ceiling futility short-circuit (a1)', () => {
  it('a repeated at-ceiling evict in the SAME frame skips the O(resident) scan', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const inj = store as unknown as StorePriv
    const { arena, counting } = atCeilingProtected(store)

    // First call: full path — builds the resident Map once (frees 0, all
    // protected), flags the deferred remedy, latches the arena futile.
    expect(inj.forceEvictBytes(arena, 4096, [0], () => {})).toBe(false)
    expect(inj._evictFutileV).toBe(true)
    expect(counting.scanCount).toBe(1)

    // Subsequent same-frame calls (the sync fallback uploader's per-tile retries)
    // MUST short-circuit before the Map-build. fail-before: each rebuilds the
    // Map → scanCount climbs to 4.
    for (let i = 0; i < 3; i++) {
      expect(inj.forceEvictBytes(arena, 4096, [0], () => {})).toBe(false)
    }
    expect(counting.scanCount).toBe(1)
  })

  it('runFrameMaintenance clears the latch so the next frame re-attempts eviction', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const inj = store as unknown as StorePriv
    const { arena } = atCeilingProtected(store)

    inj.forceEvictBytes(arena, 4096, [0], () => {})
    expect(inj._evictFutileV).toBe(true)

    // New frame: maintenance clears the per-arena futility latch.
    inj.runFrameMaintenance(
      [0],
      () => {},
      () => false,
    )
    expect(inj._evictFutileV).toBe(false)
  })
})
