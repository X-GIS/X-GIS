// Regression spec for BUG D4 — `cancelStale` leaked uncounted bytes by
// retaining prebuilt SDF segment buffers on dropped uploads.
//
// `TileCatalog.sizeOfTileData` DELIBERATELY omits `prebuiltLineSegments` /
// `prebuiltOutlineSegments` from `_cachedBytes` because the upload path nulls
// them right after GPU upload (a ~180 MB / 256-tile heap saving). But
// `cancelStale` drops queued + held upload jobs WITHOUT ever running that
// post-upload null, while the TileData stays in the catalog's dataCache. The
// retained multi-MB segment buffers are then uncounted by `_cachedBytes` →
// the byte-cap eviction under-fires.
//
// The fix nulls the prebuilt segments when an upload is dropped (they're
// rebuilt on demand by `buildLineSegments` at the next upload, exactly as the
// post-upload null relies on), keeping the size-omission invariant true.
//
// The stale-cancel logic now lives on UploadCoordinator, which takes an
// injected host port — no GPU needed. We inject a stub priority queue
// (removeByFilter is a no-op) and reach into the coordinator's queued/held
// state privates to seed the stale items.

import { describe, expect, it, vi } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { PriorityQueue } from '@xgis/shared'
import { UploadCoordinator, type UploadHost, type UploadStore } from './upload-coordinator'
import type { StagingBufferPool } from '@xgis/engine'
import type { TileData } from '@xgis/data'

/** TileData carrying non-empty prebuilt SDF segment buffers — the bytes the
 *  catalog does NOT count and the upload path is responsible for nulling. */
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

/** Coordinator with the upload-queue collaborators stubbed so cancelStale can
 *  run against injected state. */
function makeCoordinator() {
  const removeByFilter = vi.fn()
  const queue = { removeByFilter } as unknown as PriorityQueue<string, void>
  const host: UploadHost = {
    device: {} as unknown as GPUDevice,
    stagingPool: {} as unknown as StagingBufferPool,
    store: {} as unknown as UploadStore,
    lineRenderer: () => null,
    buildPerTileFeatureData: () => null,
    frameCount: () => 0,
    stableKeys: () => [],
    releaseTileHook: () => {},
    hasWarned: () => false,
    markWarned: () => {},
  }
  const coord = new UploadCoordinator(host, queue)
  return { coord, removeByFilter }
}

function heldUploadsOf(c: UploadCoordinator) {
  return (c as unknown as { _heldUploads: { key: number; data: TileData; sourceLayer: string }[] })._heldUploads
}
function heldIdsOf(c: UploadCoordinator) {
  return (c as unknown as { _heldUploadIds: Set<string> })._heldUploadIds
}
function heldKeysOf(c: UploadCoordinator) {
  return (c as unknown as { _heldUploadKeys: Set<number> })._heldUploadKeys
}
function itemDataOf(c: UploadCoordinator) {
  return (c as unknown as { uploadItemData: Map<string, { key: number; data: TileData; sourceLayer: string }> }).uploadItemData
}

describe('BUG D4 — UploadCoordinator.cancelStale releases prebuilt segments on dropped uploads', () => {
  it('HELD path: a dropped held upload has its prebuilt segments nulled (was retained → uncounted bytes)', () => {
    const { coord } = makeCoordinator()
    const staleKey = tileKey(14, 14000, 6500)
    const data = tileDataWithPrebuilt()

    // Seed the held queue with the stale tile (the cap-deferred path).
    heldUploadsOf(coord).push({ key: staleKey, data, sourceLayer: 'water' })
    heldIdsOf(coord).add(`${staleKey}:water`)
    heldKeysOf(coord).add(staleKey)

    // Sanity: bytes are present BEFORE cancel.
    expect(data.prebuiltLineSegments).not.toBeUndefined()
    expect(data.prebuiltOutlineSegments).not.toBeUndefined()

    // activeKeys does NOT contain staleKey → the held item is dropped.
    coord.cancelStale(new Set<number>())

    // The held item was dropped (not kept)…
    expect(heldUploadsOf(coord)).toHaveLength(0)
    // …and the FIX nulled its prebuilt segments.
    expect(data.prebuiltLineSegments).toBeUndefined()
    expect(data.prebuiltOutlineSegments).toBeUndefined()
  })

  it('QUEUED path: a dropped queued upload has its prebuilt segments nulled', () => {
    const { coord } = makeCoordinator()
    const staleKey = tileKey(14, 14010, 6500)
    const data = tileDataWithPrebuilt()
    const id = `${staleKey}:water`

    // Seed uploadItemData (the in-flight queue's per-item record).
    itemDataOf(coord).set(id, { key: staleKey, data, sourceLayer: 'water' })

    expect(data.prebuiltLineSegments).not.toBeUndefined()

    // activeKeys excludes staleKey → the queued item is stale + dropped.
    coord.cancelStale(new Set<number>())

    // Item removed from the queue record…
    expect(itemDataOf(coord).has(id)).toBe(false)
    // …and its prebuilt segments nulled by the fix.
    expect(data.prebuiltLineSegments).toBeUndefined()
    expect(data.prebuiltOutlineSegments).toBeUndefined()
  })

  it('does NOT release segments for an upload that stays ACTIVE (still needs them for its pending upload)', () => {
    const { coord } = makeCoordinator()
    const liveKey = tileKey(14, 14020, 6500)
    const data = tileDataWithPrebuilt()

    heldUploadsOf(coord).push({ key: liveKey, data, sourceLayer: 'water' })
    heldIdsOf(coord).add(`${liveKey}:water`)
    heldKeysOf(coord).add(liveKey)

    // liveKey IS active → the held item is kept, segments untouched so the
    // pending upload can still build its GPU buffers from them.
    coord.cancelStale(new Set<number>([liveKey]))

    expect(heldUploadsOf(coord)).toHaveLength(1)
    expect(data.prebuiltLineSegments).not.toBeUndefined()
    expect(data.prebuiltOutlineSegments).not.toBeUndefined()
  })
})
