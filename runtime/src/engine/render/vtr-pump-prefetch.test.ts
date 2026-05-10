// Frame-scope orchestration test for VectorTileRenderer.pumpPrefetch.
//
// The pure decision functions (projectPanPrefetchTarget +
// collectSiblingPrefetchKeys) are exhaustively covered in
// tile-decision-prefetch.test.ts. This file verifies the *integration*
// invariant that motivated the whole structural decision: pumpPrefetch
// must do its work exactly once per wall-clock frame regardless of
// how many ShowCommands the bucket scheduler downstream issues, and
// it must capture _prevPanCam so the SECOND frame's velocity vector is
// correct.
//
// VTR's constructor does heavy WebGPU init we can't run in vitest, so
// we build the instance with Object.create + manual field injection —
// pumpPrefetch only touches `source`, `_prevPanCam`, `currentFrameId`,
// and `_frameTileCache`, none of which need GPU. Same escape hatch
// the multi-layer-overzoom test uses against TileCatalog's private
// setSlice.

import { describe, expect, it, vi } from 'vitest'
import { tileKey, tileKeyChildren } from '@xgis/compiler'
import { Camera } from '../projection/camera'
import { VectorTileRenderer } from './vector-tile-renderer'
import { PrefetchScheduler } from './prefetch-scheduler'

// Build a minimal "catalog" that records prefetchTiles calls. Only
// the fields pumpPrefetch reads need to be present; everything else
// throws if accidentally invoked (catches drift if pumpPrefetch ever
// calls a different catalog method).
function makeMockCatalog(opts: {
  inArchive?: (key: number) => boolean
  cached?: (key: number) => boolean
  maxLevel?: number
} = {}): {
  catalog: unknown
  prefetchSpy: ReturnType<typeof vi.fn>
} {
  const inArchive = opts.inArchive ?? (() => true)
  const cached = opts.cached ?? (() => false)
  const prefetchSpy = vi.fn<(keys: number[]) => void>()
  const catalog = {
    hasData: () => true,
    hasTileData: cached,
    hasEntryInIndex: inArchive,
    maxLevel: opts.maxLevel ?? 14,
    prefetchTiles: prefetchSpy,
  }
  return { catalog, prefetchSpy }
}

// Construct a VTR instance bypassing GPU init. Class field initializers
// don't run with Object.create, so the dependency-injected fields
// pumpPrefetch reads (prefetchScheduler, source, _frameTileCache,
// currentFrameId) are wired in manually.
function makeVtr(catalog: unknown, neededKeys: number[], frameId: number): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { source: unknown }).source = catalog
  ;(vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler = new PrefetchScheduler()
  ;(vtr as unknown as { currentFrameId: number }).currentFrameId = frameId
  ;(vtr as unknown as { _frameTileCache: unknown })._frameTileCache = {
    frameId,
    neededKeys,
    tiles: [],
    protectedAncestors: [],
    worldOffDeg: [],
    maxLevel: 14,
    parentAtMaxLevel: [],
    archiveAncestor: [],
    marginPx: 0,
    currentZ: 14,
  }
  return vtr
}

const SEOUL = { lon: 127.0, lat: 37.5 }

describe('VectorTileRenderer.pumpPrefetch — frame-scope orchestration', () => {
  it('fires prefetchTiles ONCE per call regardless of subsequent render() calls', () => {
    // Simulate the Bright 80-ShowCommand frame: pumpPrefetch is called
    // exactly once by map.ts:renderFrame, then render() runs 80 times
    // (which is OUTSIDE the scope of this test — pumpPrefetch must
    // complete its work in that single call).
    const visible = [tileKey(14, 14000, 6500), tileKey(14, 14001, 6500)]
    const { catalog, prefetchSpy } = makeMockCatalog()
    const vtr = makeVtr(catalog, visible, 1)
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)

    vtr.pumpPrefetch(camera, 0, 1024, 768, 1)

    // First frame: no _prevPanCam yet, so pan-direction prefetch is
    // skipped. loadSiblings still fires once (the visible tiles have
    // siblings that are off-screen + uncached).
    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    const siblingCall = prefetchSpy.mock.calls[0][0]
    expect(siblingCall.length).toBeGreaterThan(0)
    // Each visible tile contributes its 3 quad siblings; the two
    // visible tiles share a parent, so output is 2 unique
    // off-screen siblings (children of the shared parent that aren't
    // visible).
    const parent = tileKey(13, 7000, 3250)
    const childrenOfParent = tileKeyChildren(parent)
    const expectedSiblings = childrenOfParent.filter(c => !visible.includes(c))
    expect(new Set(siblingCall)).toEqual(new Set(expectedSiblings))
  })

  it('captures the previous-frame snapshot so the second frame can project velocity', () => {
    // The previous-frame camera snapshot now lives inside
    // PrefetchScheduler. Reach in via the same private-field bypass
    // pattern this test file already uses for VTR's own internals.
    const visible = [tileKey(14, 14000, 6500)]
    const { catalog } = makeMockCatalog()
    const vtr = makeVtr(catalog, visible, 1)
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)

    vtr.pumpPrefetch(camera, 0, 1024, 768, 1)
    const scheduler = (vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler
    const prev = (scheduler as unknown as { prevPanCam: { cx: number; cy: number; zoom: number; t: number } | null }).prevPanCam
    expect(prev).not.toBeNull()
    expect(prev!.cx).toBeCloseTo(camera.centerX, 6)
    expect(prev!.cy).toBeCloseTo(camera.centerY, 6)
    expect(prev!.zoom).toBe(14)
    expect(prev!.t).toBeGreaterThan(0)
  })

  it('skips both routes when no source is attached', () => {
    const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
    ;(vtr as unknown as { source: unknown }).source = null
    ;(vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler = new PrefetchScheduler()
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)
    // Should not throw, just early-return.
    expect(() => vtr.pumpPrefetch(camera, 0, 1024, 768, 1)).not.toThrow()
  })

  it('skips both routes when neededKeys is empty (cache not yet populated)', () => {
    const { catalog, prefetchSpy } = makeMockCatalog()
    const vtr = makeVtr(catalog, [], 1)
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)
    vtr.pumpPrefetch(camera, 0, 1024, 768, 1)
    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  it('skips loadSiblings when all siblings are already cached', () => {
    const visible = [tileKey(14, 14000, 6500)]
    const parent = tileKey(13, 7000, 3250)
    const allChildren = new Set(tileKeyChildren(parent))
    const { catalog, prefetchSpy } = makeMockCatalog({
      cached: (k) => allChildren.has(k),
    })
    const vtr = makeVtr(catalog, visible, 1)
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)
    vtr.pumpPrefetch(camera, 0, 1024, 768, 1)
    // No call: siblings filtered out by cached predicate, and prev is
    // null so pan-direction is also skipped.
    expect(prefetchSpy).not.toHaveBeenCalled()
  })
})
