// UAF gate: SDF line/outline SEGMENT buffer destruction during eviction must
// be DEFERRED past the in-flight frame submit.
//
// THE BUG THIS PINS: GpuTileStore._releaseTileSlots() destroyed a tile's
// `outlineSegmentBuffer` / `lineSegmentBuffer` (label "line-segments")
// SYNCHRONOUSLY. _releaseTileSlots is shared by evictToBudget AND
// forceEvictBytes — and forceEvictBytes runs MID-RENDER (arena alloc-fail
// during a sync fallback `doUploadTile`, gpu-tile-store.ts:599). A segment
// buffer destroyed mid-render may still be recorded in the CURRENT frame's
// render encoder, so that frame's queue.submit() (render-loop.ts:532) raised:
//   🛑 [X-GIS frame-validation] [Buffer "line-segments"] used in submit while destroyed
// (user repro: pmtiles buildings, Tokyo z17.9 pitch65, fill-extrusion + arena-oom.)
// The poly vertex/index are arena SLICES (free() the range, no buffer destroy),
// and arena COMPACTION already defers its old-buffer destroy to the post-submit
// window (_pendingArenaCompaction) — only these standalone segment buffers were
// destroyed mid-render.
//
// THE FIX (mirror of _retiredArenaBuffers + PointRenderer.retiredTilePointBuffers,
// render-loop.ts:381-387): _releaseTileSlots RETIRES the segment buffers into
// _retiredSegmentBuffers; they are destroyed at the next runFrameMaintenance
// (the post-submit safe window, after the prior frame's queue.submit() has
// drained) and on destroy().
//
// HOW THIS TEST WORKS: GpuTileStore's constructor is just `this.device = device`
// (no GPU init, gpu-tile-store.ts:185). We inject a cached tile carrying tracked
// segment buffers straight into the private gpuCache, drive the shared release
// path, and assert the buffers are NOT destroyed synchronously (they're retired)
// and ARE destroyed only after runFrameMaintenance / destroy().

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

interface MockBuffer {
  destroyed: boolean
  label: string
  destroy(): void
}
function mockBuffer(label: string): MockBuffer {
  const b: MockBuffer = {
    destroyed: false,
    label,
    destroy() {
      b.destroyed = true
    },
  }
  return b
}
function mockDevice(): GPUDevice {
  return { createBuffer: () => ({ destroy() {} }) } as unknown as GPUDevice
}

// Seed a cached tile carrying tracked segment buffers — the minimum
// _releaseTileSlots / eviction reads. polyVertexArena stays null (no alloc),
// so the arena.free + releaseBuffer(null) branches are silent no-ops and the
// test exercises the segment-buffer lifecycle specifically.
function seedTile(
  store: GpuTileStore,
  slot: string,
  tk: number,
): { outline: MockBuffer; line: MockBuffer; feat: MockBuffer } {
  const outline = mockBuffer('line-segments')
  const line = mockBuffer('line-segments')
  // featureDataBuffer is also render-bound (featureBindGroup) and destroyed at
  // the same _releaseTileSlots site → same mid-render UAF class. Track it too.
  const feat = mockBuffer('feat-data')
  const tile = {
    polyVertexOffset: 0,
    polyVertexByteLength: 0,
    polyIndexOffset: 0,
    polyIndexByteLength: 0,
    zBufferOffset: 0,
    zBufferByteLength: 0,
    lineVertexBuffer: null,
    lineIndexBuffer: null,
    outlineIndexBuffer: null,
    outlineSegmentBuffer: outline as unknown as GPUBuffer,
    lineSegmentBuffer: line as unknown as GPUBuffer,
    featureDataBuffer: feat as unknown as GPUBuffer,
    lastUsedFrame: 0,
  }
  const inj = store as unknown as {
    gpuCache: Map<string, Map<number, unknown>>
    _gpuCacheCount: number
  }
  let inner = inj.gpuCache.get(slot)
  if (!inner) {
    inner = new Map<number, unknown>()
    inj.gpuCache.set(slot, inner)
  }
  inner.set(tk, tile)
  inj._gpuCacheCount++
  return { outline, line, feat }
}

type ReleasePriv = { _releaseTileSlots(s: string, tk: number, hook: (k: string) => void): unknown }
type MaintPriv = {
  runFrameMaintenance(s: readonly number[], h: (k: string) => void, u: () => boolean): boolean
}

describe('GpuTileStore segment-buffer UAF — eviction defers destroy past the frame submit', () => {
  it('_releaseTileSlots retires (does NOT synchronously destroy) the render-bound tile buffers', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const { outline, line, feat } = seedTile(store, '', 1)

    // Drive the shared release path (forceEvictBytes / evictToBudget reach here).
    ;(store as unknown as ReleasePriv)._releaseTileSlots('', 1, () => {})

    // FAIL-BEFORE: pre-fix these destroyed synchronously → mid-render UAF.
    expect(
      outline.destroyed,
      'outline segment buffer must be RETIRED, not destroyed synchronously',
    ).toBe(false)
    expect(line.destroyed, 'line segment buffer must be RETIRED, not destroyed synchronously').toBe(
      false,
    )
    expect(
      feat.destroyed,
      'feature-data buffer (same render-bound UAF class) must be RETIRED',
    ).toBe(false)

    // Drained at the next post-submit maintenance pass (prior submit has landed).
    ;(store as unknown as MaintPriv).runFrameMaintenance(
      [],
      () => {},
      () => false,
    )
    expect(outline.destroyed, 'retired buffer must be destroyed by runFrameMaintenance').toBe(true)
    expect(line.destroyed).toBe(true)
    expect(feat.destroyed).toBe(true)
  })

  it('destroy() drains any still-retired tile buffers (no teardown leak)', () => {
    const _dev = mockDevice()
    const store = new GpuTileStore(_dev, new WebGpuDevice(_dev))
    const { outline, line, feat } = seedTile(store, '', 2)
    ;(store as unknown as ReleasePriv)._releaseTileSlots('', 2, () => {})
    expect(outline.destroyed).toBe(false) // retired, not yet drained

    store.destroy()
    expect(outline.destroyed, 'destroy() must drain the retired-tile pool').toBe(true)
    expect(line.destroyed).toBe(true)
    expect(feat.destroyed).toBe(true)
  })
})
