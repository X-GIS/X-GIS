// Regression spec for BUG D4 — `cancelStaleUploads` leaked uncounted
// bytes by retaining prebuilt SDF segment buffers on dropped uploads.
//
// `TileCatalog.sizeOfTileData` DELIBERATELY omits `prebuiltLineSegments`
// / `prebuiltOutlineSegments` from `_cachedBytes` because `doUploadTile`
// nulls them right after GPU upload (a ~180 MB / 256-tile heap saving).
// But `cancelStaleUploads` drops queued + held upload jobs WITHOUT ever
// running that post-upload null, while the TileData stays in the
// catalog's dataCache. The retained multi-MB segment buffers are then
// uncounted by `_cachedBytes` → the byte-cap eviction under-fires.
//
// The fix nulls the prebuilt segments when an upload is dropped (they're
// rebuilt on demand by `buildLineSegments` at the next upload, exactly as
// the post-upload null relies on), keeping the size-omission invariant
// true.
//
// FAIL-BEFORE: after cancelStaleUploads drops the (now-stale) upload, the
// retained TileData still carries non-null prebuiltLineSegments /
// prebuiltOutlineSegments. POST-FIX both are null.
//
// VTR's constructor needs WebGPU we can't run in vitest, so we build the
// instance with Object.create + manual field injection — same escape
// hatch as vtr-held-keys.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { VectorTileRenderer } from './vector-tile-renderer'
import type { TileData } from '../../data/tile-types'

/** TileData carrying non-empty prebuilt SDF segment buffers — the bytes
 *  the catalog does NOT count and the upload path is responsible for
 *  nulling. */
function tileDataWithPrebuilt(): TileData {
  return {
    vertices: new Float32Array(0),
    dequantScale: 0,
    dequantHalf: 0,
    indices: new Uint32Array(0),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    outlineIndices: new Uint32Array(0),
    prebuiltLineSegments: new Float32Array(1024),    // multi-element → "real" uncounted bytes
    prebuiltOutlineSegments: new Float32Array(512),
    tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
  }
}

/** VTR instance bypassing GPU init, with the upload-queue collaborators
 *  stubbed so cancelStaleUploads can run against injected state. */
function makeVtr(): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { _uploadsThisFrame: number })._uploadsThisFrame = 0
  ;(vtr as unknown as { _heldUploads: unknown[] })._heldUploads = []
  ;(vtr as unknown as { _heldUploadIds: Set<string> })._heldUploadIds = new Set()
  ;(vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys = new Set()
  ;(vtr as unknown as { uploadItemData: Map<string, unknown> }).uploadItemData = new Map()
  // removeByFilter is invoked for the queued-drop path; stub it as a no-op
  // (the queue's own removal is unrelated to the byte-leak under test).
  ;(vtr as unknown as { uploadQueue: { removeByFilter: () => void } }).uploadQueue = {
    removeByFilter: vi.fn(),
  }
  return vtr
}

function cancelStale(vtr: VectorTileRenderer, activeKeys: Set<number>): void {
  ;(vtr as unknown as { cancelStaleUploads(k: ReadonlySet<number>): void }).cancelStaleUploads(activeKeys)
}

describe('BUG D4 — cancelStaleUploads releases prebuilt segments on dropped uploads', () => {
  it('HELD path: a dropped held upload has its prebuilt segments nulled (was retained → uncounted bytes)', () => {
    const vtr = makeVtr()
    const staleKey = tileKey(14, 14000, 6500)
    const data = tileDataWithPrebuilt()

    // Seed the held queue with the stale tile (the cap-deferred path).
    ;(vtr as unknown as { _heldUploads: { key: number; data: TileData; sourceLayer: string }[] })._heldUploads = [
      { key: staleKey, data, sourceLayer: 'water' },
    ]
    ;(vtr as unknown as { _heldUploadIds: Set<string> })._heldUploadIds.add(`${staleKey}:water`)
    ;(vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys.add(staleKey)

    // Sanity: bytes are present BEFORE cancel.
    expect(data.prebuiltLineSegments).not.toBeUndefined()
    expect(data.prebuiltOutlineSegments).not.toBeUndefined()

    // activeKeys does NOT contain staleKey → the held item is dropped.
    cancelStale(vtr, new Set<number>())

    // The held item was dropped (not kept)…
    const held = (vtr as unknown as { _heldUploads: unknown[] })._heldUploads
    expect(held).toHaveLength(0)
    // …and the FIX nulled its prebuilt segments. Pre-fix these stayed set,
    // leaving multi-MB buffers the catalog's _cachedBytes never counted.
    expect(data.prebuiltLineSegments).toBeUndefined()
    expect(data.prebuiltOutlineSegments).toBeUndefined()
  })

  it('QUEUED path: a dropped queued upload has its prebuilt segments nulled', () => {
    const vtr = makeVtr()
    const staleKey = tileKey(14, 14010, 6500)
    const data = tileDataWithPrebuilt()
    const id = `${staleKey}:water`

    // Seed uploadItemData (the in-flight queue's per-item record).
    ;(vtr as unknown as { uploadItemData: Map<string, { key: number; data: TileData; sourceLayer: string }> })
      .uploadItemData.set(id, { key: staleKey, data, sourceLayer: 'water' })

    expect(data.prebuiltLineSegments).not.toBeUndefined()

    // activeKeys excludes staleKey → the queued item is stale + dropped.
    cancelStale(vtr, new Set<number>())

    // Item removed from the queue record…
    const itemData = (vtr as unknown as { uploadItemData: Map<string, unknown> }).uploadItemData
    expect(itemData.has(id)).toBe(false)
    // …and its prebuilt segments nulled by the fix.
    expect(data.prebuiltLineSegments).toBeUndefined()
    expect(data.prebuiltOutlineSegments).toBeUndefined()
  })

  it('does NOT release segments for an upload that stays ACTIVE (still needs them for its pending upload)', () => {
    const vtr = makeVtr()
    const liveKey = tileKey(14, 14020, 6500)
    const data = tileDataWithPrebuilt()

    ;(vtr as unknown as { _heldUploads: { key: number; data: TileData; sourceLayer: string }[] })._heldUploads = [
      { key: liveKey, data, sourceLayer: 'water' },
    ]
    ;(vtr as unknown as { _heldUploadIds: Set<string> })._heldUploadIds.add(`${liveKey}:water`)
    ;(vtr as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys.add(liveKey)

    // liveKey IS active → the held item is kept, segments untouched so the
    // pending upload can still build its GPU buffers from them.
    cancelStale(vtr, new Set<number>([liveKey]))

    const held = (vtr as unknown as { _heldUploads: unknown[] })._heldUploads
    expect(held).toHaveLength(1)
    expect(data.prebuiltLineSegments).not.toBeUndefined()
    expect(data.prebuiltOutlineSegments).not.toBeUndefined()
  })
})
