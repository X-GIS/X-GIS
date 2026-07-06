// Integration gate for GpuTileStore arena AUTO-GROW (US-003).
//
// THE FEATURE: when a mid-render alloc-fail (forceEvictBytes) cannot be served
// AND the live set is eviction-PROTECTED and genuinely exceeds the arena's
// CURRENT capacity, the store flags a per-arena GROW target (not a same-size
// compaction). runFrameMaintenance drains it in the post-submit safe window by
// relocating the live set into a LARGER buffer (GPUArena.compact(targetCapacity)).
// This fixes the user's extreme-camera arena-OOM (Tokyo z17.9 pitch65 fill-
// extrusion: ~all visible building tiles protected, so the 128MB cap can't hold
// the protected live set and eviction/compaction can't relieve it).
//
// DISTINCTION pinned here: over-capacity → GROW; at-ceiling → graceful compact
// (the pre-grow #218 skip-and-warn); both run in the post-submit safe window.
//
// HOW THIS TEST WORKS: GpuTileStore's constructor is just `this.device = device`.
// We inject a small real GPUArena + cached tiles referencing its slots, mark
// them protected via stableKeys, then drive forceEvictBytes / runFrameMaintenance
// and assert the grow decision + the actual capacity growth.

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from '@xgis/map'
import { GPUArena, type GPUArenaDevice } from '@xgis/engine'
import type { RhiBuffer } from '@xgis/engine'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

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
      return b as unknown as RhiBuffer
    },
    destroyBuffer(h) {
      ;(h as unknown as MockBuffer).destroy()
    },
  }
}

const VERTEX_USAGE = 'vertex'

type StorePriv = {
  polyVertexArena: GPUArena | null
  gpuCache: Map<string, Map<number, unknown>>
  _gpuCacheCount: number
  _pendingArenaGrowV: number
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

// Fill `arena` with N protected tiles (each `bytes`), recorded in gpuCache so
// _releaseTileSlots/compaction see them. Returns the tile keys (all protected).
function fillProtected(store: GpuTileStore, arena: GPUArena, n: number, bytes: number): number[] {
  const inj = store as unknown as StorePriv
  const inner = new Map<number, unknown>()
  inj.gpuCache.set('', inner)
  const keys: number[] = []
  for (let i = 0; i < n; i++) {
    const off = arena.alloc(bytes)
    inner.set(i, {
      polyVertexOffset: off,
      polyVertexByteLength: bytes,
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
      vertexBuffer: arena.rhiBuffer,
      indexBuffer: arena.rhiBuffer,
      lastUsedFrame: 1,
    })
    inj._gpuCacheCount++
    keys.push(i)
  }
  return keys
}

describe('GpuTileStore arena auto-grow (US-003)', () => {
  it('over-capacity protected live set → forceEvictBytes flags a GROW (not compaction)', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const inj = store as unknown as StorePriv
    const CAP = 64 * 1024
    const arena = new GPUArena(arenaDevice(), {
      capacityBytes: CAP,
      usage: VERTEX_USAGE,
      copySrc: true,
    })
    inj.polyVertexArena = arena

    // Fill the arena with protected tiles (≈ full capacity).
    const TILE = 8 * 1024
    const keys = fillProtected(store, arena, 8, TILE) // 8 × 8KB = 64KB = full

    // Alloc-fail recovery: nothing is evictable (all protected) → must GROW.
    const served = inj.forceEvictBytes(arena, TILE, keys, () => {})
    expect(served).toBe(false)
    expect(inj._pendingArenaCompaction).toBe(false) // NOT fragmentation
    expect(inj._pendingArenaGrowV).toBeGreaterThan(CAP) // grow target > current
    // Target fits live+needed and is ≥ 1.5× current.
    expect(inj._pendingArenaGrowV).toBeGreaterThanOrEqual(Math.ceil(CAP * 1.5))
  })

  it('runFrameMaintenance drains the grow → arena capacity increases + tile offsets rewritten', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const inj = store as unknown as StorePriv
    const CAP = 64 * 1024
    const arena = new GPUArena(arenaDevice(), {
      capacityBytes: CAP,
      usage: VERTEX_USAGE,
      copySrc: true,
    })
    inj.polyVertexArena = arena
    const TILE = 8 * 1024
    const keys = fillProtected(store, arena, 8, TILE)
    inj.forceEvictBytes(arena, TILE, keys, () => {})
    const target = inj._pendingArenaGrowV
    expect(target).toBeGreaterThan(CAP)
    const oldBuffer = arena.rhiBuffer

    // Drain in the post-submit safe window. uploadActive=false so it runs now.
    const moved = inj.runFrameMaintenance(
      keys,
      () => {},
      () => false,
    )

    expect(moved).toBe(true) // relocation happened → bundles invalidate
    expect(arena.capacityBytes).toBe(target) // arena GREW
    expect(inj._pendingArenaGrowV).toBe(0) // flag consumed
    expect(arena.rhiBuffer).not.toBe(oldBuffer) // swapped to the larger buffer
    // The previously-failing alloc now succeeds against the grown arena.
    expect(() => arena.alloc(TILE)).not.toThrow()
  })

  it('at the ceiling → flags compaction (graceful), NOT an unbounded grow', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const inj = store as unknown as StorePriv
    // Construct an arena already AT the vertex ceiling (512MB) but with a tiny
    // logical fill so we can saturate it cheaply: use the real ceiling cap and
    // a single protected tile occupying the whole bump via a large alloc is
    // impractical, so instead assert the branch via a near-ceiling cap.
    const CEIL = 512 * 1024 * 1024
    const arena = new GPUArena(arenaDevice(), {
      capacityBytes: CEIL,
      usage: VERTEX_USAGE,
      copySrc: true,
    })
    inj.polyVertexArena = arena
    // One protected tile near the top of the bump so liveBytes+needed > cap but
    // capacity is already at the ceiling → no further grow allowed.
    const inner = new Map<number, unknown>()
    inj.gpuCache.set('', inner)
    const off = arena.alloc(CEIL - 1024) // bump ≈ ceiling
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
      vertexBuffer: arena.rhiBuffer,
      indexBuffer: arena.rhiBuffer,
      lastUsedFrame: 1,
    })
    inj._gpuCacheCount++

    const served = inj.forceEvictBytes(arena, 4096, [0], () => {})
    expect(served).toBe(false)
    expect(inj._pendingArenaGrowV).toBe(0) // NO grow past the ceiling
    expect(inj._pendingArenaCompaction).toBe(true) // graceful compaction/skip
  })
})
