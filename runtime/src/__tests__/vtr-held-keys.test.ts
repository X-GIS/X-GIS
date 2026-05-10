// Integration tests for VectorTileRenderer's `_heldUploadKeys` —
// the set that mirrors `_heldUploads`'s tile keys (sliceLayer-
// collapsed) so `classifyTile`'s `hasOtherSliceHeld` predicate can
// keep every layer of one tile on the same fallback level until the
// slowest slice catches up. Without this set, the upload cap (4/frame
// desktop, 1/frame mobile) staggers per-MVT-layer slice arrival
// across frames and the renderer renders `primary` z=N landcover next
// to `parent-fallback` z=N-1 transportation in the same screen
// region.
//
// VTR's constructor needs WebGPU init we can't run in vitest, so we
// build instances with Object.create + manual field injection — same
// escape hatch the prior pumpPrefetch test uses.

import { describe, expect, it, vi } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { VectorTileRenderer } from '../engine/render/vector-tile-renderer'
import type { TileData } from '../data/tile-types'

// Stub TileData — none of the real upload code paths run here, so the
// fields can be empty typed arrays. The held-queue logic only cares
// about identity (key + sourceLayer).
function stubTileData(): TileData {
  return {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    outlineIndices: new Uint32Array(0),
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
  }
}

// Build a VTR instance bypassing GPU init. We stub the upload queue so
// successful (non-held) uploads are silent — only the held-branch
// bookkeeping is exercised.
function makeVtr(): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { _uploadsThisFrame: number })._uploadsThisFrame = 0
  ;(vtr as unknown as { _heldUploads: unknown[] })._heldUploads = []
  ;(vtr as unknown as { _heldUploadIds: Set<string> })._heldUploadIds = new Set()
  ;(vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys = new Set()
  // Stub the async upload pipeline so non-held items vanish silently.
  ;(vtr as unknown as { uploadQueue: unknown }).uploadQueue = {
    has: () => false,
    add: vi.fn(() => Promise.resolve()),
  }
  ;(vtr as unknown as { uploadItemData: Map<string, unknown> }).uploadItemData = new Map()
  // gpuCache is consulted at the very top of uploadTile to dedupe
  // already-on-GPU keys; an empty Map fakes "nothing on GPU yet".
  ;(vtr as unknown as { gpuCache: Map<string, Map<number, unknown>> }).gpuCache = new Map()
  return vtr
}

// `uploadTile` is private; reach in via type assertion (same pattern
// as multi-layer-overzoom and tile-catalog-skeleton tests).
function callUploadTile(vtr: VectorTileRenderer, key: number, sourceLayer: string): void {
  ;(vtr as unknown as { uploadTile(k: number, d: TileData, s: string): void })
    .uploadTile(key, stubTileData(), sourceLayer)
}

function callResetUploadFrameCap(vtr: VectorTileRenderer): void {
  ;(vtr as unknown as { resetUploadFrameCap(): void }).resetUploadFrameCap()
}

describe('VectorTileRenderer — _heldUploadKeys tracking for coherent fallback', () => {
  it('records every tile key whose slice gets pushed onto _heldUploads', () => {
    const vtr = makeVtr()
    // Force the cap by jamming _uploadsThisFrame past any plausible
    // cap (desktop=4, mobile=1).
    ;(vtr as unknown as { _uploadsThisFrame: number })._uploadsThisFrame = 9999
    const kA = tileKey(14, 14000, 6500)
    const kB = tileKey(14, 14001, 6500)
    callUploadTile(vtr, kA, 'water')
    callUploadTile(vtr, kA, 'landcover')   // same key, different slice
    callUploadTile(vtr, kB, 'water')

    const heldKeys = (vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
    expect(heldKeys.has(kA)).toBe(true)
    expect(heldKeys.has(kB)).toBe(true)
    // 2 unique keys despite 3 push calls (kA appears twice — sliceLayer-collapsed).
    expect(heldKeys.size).toBe(2)
    // Underlying _heldUploads should still hold all 3 sliceLayer entries.
    const heldUploads = (vtr as unknown as { _heldUploads: unknown[] })._heldUploads
    expect(heldUploads).toHaveLength(3)
  })

  it('does NOT record keys for slices that bypass the held queue (cap not reached)', () => {
    const vtr = makeVtr()
    // Cap not jammed → uploadTile takes the success path (stub queue
    // makes it silent). _heldUploadKeys must stay empty.
    callUploadTile(vtr, tileKey(14, 14000, 6500), 'water')
    callUploadTile(vtr, tileKey(14, 14001, 6500), 'water')
    const heldKeys = (vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
    expect(heldKeys.size).toBe(0)
    // Counter advanced for each successful upload.
    const upCount = (vtr as unknown as { _uploadsThisFrame: number })._uploadsThisFrame
    expect(upCount).toBe(2)
  })

  it('resetUploadFrameCap rebuilds _heldUploadKeys from the replay outcome', () => {
    const vtr = makeVtr()
    // Stage 6 distinct keys into the held queue.
    ;(vtr as unknown as { _uploadsThisFrame: number })._uploadsThisFrame = 9999
    const keys: number[] = []
    for (let i = 0; i < 6; i++) {
      const k = tileKey(14, 14000 + i, 6500)
      keys.push(k)
      callUploadTile(vtr, k, 'water')
    }
    let heldKeys = (vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
    expect(heldKeys.size).toBe(6)

    // Replay with no jamming — desktop cap=4 (jsdom env has window
    // with innerWidth defaulting > 900) so 4 succeed and 2 re-defer.
    // First flip _uploadsThisFrame back to 0 so the replay loop sees
    // an open budget.
    callResetUploadFrameCap(vtr)
    heldKeys = (vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
    // Either 0 (mobile cap=1 → wait no, that's worse) or 2 (desktop
    // cap=4) re-deferrals. The exact count depends on the test env's
    // window.innerWidth, but it MUST be ≤ 6 and consistent with
    // `_heldUploads.length`.
    const heldUploads = (vtr as unknown as { _heldUploads: unknown[] })._heldUploads
    expect(heldKeys.size).toBe(heldUploads.length)
    // Replay must have processed AT LEAST one slice (cap ≥ 1 always).
    expect(heldKeys.size).toBeLessThan(6)
  })
})
