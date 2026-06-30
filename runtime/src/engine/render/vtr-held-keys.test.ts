// Integration tests for the UploadCoordinator's `_heldUploadKeys` — the set
// that mirrors `_heldUploads`'s tile keys (sliceLayer-collapsed) so
// `classifyTile`'s `hasOtherSliceHeld` predicate (via `isHeld`) can keep
// every layer of one tile on the same fallback level until the slowest slice
// catches up. Without this set, the upload cap (4/frame desktop, 1/frame
// mobile) staggers per-MVT-layer slice arrival across frames and the renderer
// renders `primary` z=N landcover next to `parent-fallback` z=N-1
// transportation in the same screen region.
//
// The upload cap + held-queue logic now lives on UploadCoordinator, which
// takes an injected host port — no GPU needed. We inject a stub priority
// queue so successful (non-held) uploads are silent (the job never runs), and
// reach into the coordinator's held-state privates to assert the bookkeeping.

import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { PriorityQueue } from '../../core/priority-queue'
import { UploadCoordinator, type UploadHost, type UploadStore } from './upload-coordinator'
import type { StagingBufferPool } from '@xgis/engine'
import type { TileData } from '../../data/tile-types'

// Stub TileData — none of the real upload code paths run here, so the fields
// can be empty typed arrays. The held-queue logic only cares about identity
// (key + sourceLayer).
function stubTileData(): TileData {
  return {
    vertices: new Float32Array(0),
    dequantScale: 0,
    dequantHalf: 0,
    indices: new Uint32Array(0),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    outlineIndices: new Uint32Array(0),
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
  }
}

// Build a coordinator with a stubbed priority queue so non-held items vanish
// silently — only the held-branch bookkeeping is exercised. The store's
// getLayer fakes "nothing on GPU yet" so the top-of-enqueue dedupe passes.
function makeCoordinator(): UploadCoordinator {
  const queue = {
    has: () => false,
    add: () => Promise.resolve(),
  } as unknown as PriorityQueue<string, void>
  const store = { getLayer: () => undefined } as unknown as UploadStore
  const host: UploadHost = {
    device: {} as unknown as GPUDevice,
    stagingPool: {} as unknown as StagingBufferPool,
    store,
    lineRenderer: () => null,
    buildPerTileFeatureData: () => null,
    frameCount: () => 0,
    stableKeys: () => [],
    releaseTileHook: () => {},
    hasWarned: () => false,
    markWarned: () => {},
  }
  return new UploadCoordinator(host, queue)
}

function heldKeysOf(c: UploadCoordinator): Set<number> {
  return (c as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
}
function heldUploadsOf(c: UploadCoordinator): unknown[] {
  return (c as unknown as { _heldUploads: unknown[] })._heldUploads
}
function jamCap(c: UploadCoordinator, n: number): void {
  ;(c as unknown as { _uploadsThisFrame: number })._uploadsThisFrame = n
}

describe('UploadCoordinator — _heldUploadKeys tracking for coherent fallback', () => {
  it('records every tile key whose slice gets pushed onto _heldUploads', () => {
    const c = makeCoordinator()
    // Force the cap by jamming _uploadsThisFrame past any plausible cap.
    jamCap(c, 9999)
    const kA = tileKey(14, 14000, 6500)
    const kB = tileKey(14, 14001, 6500)
    c.enqueue(kA, stubTileData(), 'water')
    c.enqueue(kA, stubTileData(), 'landcover')   // same key, different slice
    c.enqueue(kB, stubTileData(), 'water')

    const heldKeys = heldKeysOf(c)
    expect(heldKeys.has(kA)).toBe(true)
    expect(heldKeys.has(kB)).toBe(true)
    expect(c.isHeld(kA)).toBe(true)
    // 2 unique keys despite 3 push calls (kA appears twice — sliceLayer-collapsed).
    expect(heldKeys.size).toBe(2)
    // Underlying _heldUploads should still hold all 3 sliceLayer entries.
    expect(heldUploadsOf(c)).toHaveLength(3)
  })

  it('does NOT record keys for slices that bypass the held queue (cap not reached)', () => {
    const c = makeCoordinator()
    // Cap not jammed → enqueue takes the success path (stub queue makes it
    // silent). _heldUploadKeys must stay empty.
    c.enqueue(tileKey(14, 14000, 6500), stubTileData(), 'water')
    c.enqueue(tileKey(14, 14001, 6500), stubTileData(), 'water')
    expect(heldKeysOf(c).size).toBe(0)
    // Counter advanced for each successful upload.
    expect((c as unknown as { _uploadsThisFrame: number })._uploadsThisFrame).toBe(2)
  })

  it('resetFrameCap rebuilds _heldUploadKeys from the replay outcome', () => {
    const c = makeCoordinator()
    // Stage 6 distinct keys into the held queue.
    jamCap(c, 9999)
    for (let i = 0; i < 6; i++) {
      c.enqueue(tileKey(14, 14000 + i, 6500), stubTileData(), 'water')
    }
    expect(heldKeysOf(c).size).toBe(6)

    // Replay with no jamming — desktop cap=4 (jsdom env has window with
    // innerWidth defaulting > 900) so 4 succeed and 2 re-defer.
    c.resetFrameCap()
    const heldKeys = heldKeysOf(c)
    // The exact re-deferral count depends on the env's window.innerWidth, but
    // it MUST be ≤ 6 and consistent with `_heldUploads.length`.
    expect(heldKeys.size).toBe(heldUploadsOf(c).length)
    // Replay must have processed AT LEAST one slice (cap ≥ 1 always).
    expect(heldKeys.size).toBeLessThan(6)
  })
})
