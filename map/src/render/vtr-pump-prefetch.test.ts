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
// pumpPrefetch only touches `source`, `prefetchScheduler`, and the
// selection collaborator's per-frame tile cache (`_selection`), none of
// which need GPU. Same escape hatch the multi-layer-overzoom test uses
// against TileCatalog's private setSlice.

import { describe, expect, it, vi } from 'vitest'
import { tileKey, tileKeyChildren } from '@xgis/compiler'
import { Camera } from '../camera'
import { VectorTileRenderer } from './vector-tile-renderer'
import { PrefetchScheduler } from './prefetch-scheduler'
import { TileSelectionCache, type FrameTileCache } from './tile-selection-cache'

// Build a minimal "catalog" that records prefetchTiles calls. Only
// the fields pumpPrefetch reads need to be present; everything else
// throws if accidentally invoked (catches drift if pumpPrefetch ever
// calls a different catalog method).
function makeMockCatalog(
  opts: {
    inArchive?: (key: number) => boolean
    cached?: (key: number) => boolean
    maxLevel?: number
  } = {},
): {
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
// pumpPrefetch reads (prefetchScheduler, source, _selection) are wired
// in manually. The per-frame tile cache now lives on the selection
// collaborator as a per-margin LRU (#1153 #12), so we seed a real
// TileSelectionCache's internal `_frameTileCacheLru` (read back via its
// `frameTileCache()` MRU accessor).
function makeVtr(catalog: unknown, neededKeys: number[], frameId: number): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { source: unknown }).source = catalog
  ;(vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler =
    new PrefetchScheduler()
  ;(vtr as unknown as { currentFrameId: number }).currentFrameId = frameId
  const selection = new TileSelectionCache()
  const frameTileCache: FrameTileCache = {
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
  ;(
    selection as unknown as { _frameTileCacheLru: Map<number, FrameTileCache> }
  )._frameTileCacheLru.set(frameTileCache.marginPx, frameTileCache)
  ;(vtr as unknown as { _selection: TileSelectionCache })._selection = selection
  return vtr
}

const SEOUL = { lon: 127.0, lat: 37.5 }

// Drive `frames` consecutive wall-clock frames of a decisive pan.
// `performance.now` is stubbed rather than slept on: projectPanPrefetchTarget
// discards dt <= 0 (tile-decision.ts:474) and two back-to-back real now()
// calls can return the same value, so a real clock makes route 2 flaky. The
// defaults put the camera well past minSpeedSq (500 m / 16 ms = 31 m/ms vs the
// 1.9 m/ms floor) and hold zoom constant, so route 2 is *eligible* every frame
// after the first — whether it actually walks is what the tests below measure.
function drivePumps(
  vtr: VectorTileRenderer,
  camera: Camera,
  frames: number,
  opts: { stepMetres?: number; frameMs?: number } = {},
): void {
  const step = opts.stepMetres ?? 500
  const frameMs = opts.frameMs ?? 16
  let t = 1000
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => t)
  try {
    for (let i = 0; i < frames; i++) {
      vtr.pumpPrefetch(camera, 0, 1024, 768, 1)
      t += frameMs
      camera.centerX += step
    }
  } finally {
    nowSpy.mockRestore()
  }
}

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
    const expectedSiblings = childrenOfParent.filter((c) => !visible.includes(c))
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
    const prev = (
      scheduler as unknown as {
        prevPanCam: { cx: number; cy: number; zoom: number; t: number } | null
      }
    ).prevPanCam
    expect(prev).not.toBeNull()
    expect(prev!.cx).toBeCloseTo(camera.centerX, 6)
    expect(prev!.cy).toBeCloseTo(camera.centerY, 6)
    expect(prev!.zoom).toBe(14)
    expect(prev!.t).toBeGreaterThan(0)
  })

  it('skips both routes when no source is attached', () => {
    const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
    ;(vtr as unknown as { source: unknown }).source = null
    ;(vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler =
      new PrefetchScheduler()
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

// The pan-direction route (route 2) is the only per-frame consumer of a full
// visibleTilesFrustumSampled quadtree walk that had NO gate, while both of its
// siblings in VTR were throttled (prefetchAdjacent :3657, Tier-2 :3683). These
// tests pin the throttle BEHAVIOURALLY — they count route-2 side effects across
// real frames rather than asserting a stride constant exists, so they still hold
// if the stride is retuned, and they fail if the gate is removed or widened.
//
// Route isolation: route 1's only side effect is prefetchTiles(siblings), so
// marking every sibling cached silences it and leaves prefetchTiles as a clean
// route-2 probe. Route 2's tiles come from the walk around the camera's true
// z14 tile (x≈13972 at lon 127) and are disjoint from the fixture's 14000-based
// sibling set, so nothing bleeds between the routes.
describe('VectorTileRenderer.pumpPrefetch — pan-speculation walk throttle', () => {
  function makeSiblingsSilencedVtr(): {
    vtr: VectorTileRenderer
    camera: Camera
    prefetchSpy: ReturnType<typeof vi.fn>
  } {
    const visible = [tileKey(14, 14000, 6500)]
    const allChildren = new Set(tileKeyChildren(tileKey(13, 7000, 3250)))
    const { catalog, prefetchSpy } = makeMockCatalog({ cached: (k) => allChildren.has(k) })
    return {
      vtr: makeVtr(catalog, visible, 1),
      camera: new Camera(SEOUL.lon, SEOUL.lat, 14),
      prefetchSpy,
    }
  }

  it('walks the future frustum on ONE frame in six while the camera pans hard', () => {
    // 12 frames of sustained decisive pan — route 2 is eligible on all but
    // frame 0 (no prev snapshot yet). Ungated, this walked on 11 of them:
    // that is the 15.0 ms median / 165.7 ms max frame, against 6.9 ms for a
    // frame that walks nothing. Strided, only frame 6 walks.
    const { vtr, camera, prefetchSpy } = makeSiblingsSilencedVtr()
    drivePumps(vtr, camera, 12)
    expect(prefetchSpy).toHaveBeenCalledTimes(1)
    // Non-vacuous: the one call that DID happen is a real route-2 emission
    // (a non-empty in-archive future-tile set), not an empty no-op.
    expect(prefetchSpy.mock.calls[0][0].length).toBeGreaterThan(0)
  })

  it('does not walk at all across a five-frame pan that clears no stride boundary', () => {
    // Frames 0-4: frame 0 has no prev, frames 1-4 are off-stride. A regression
    // that drops the gate makes this 4.
    const { vtr, camera, prefetchSpy } = makeSiblingsSilencedVtr()
    drivePumps(vtr, camera, 5)
    expect(prefetchSpy).not.toHaveBeenCalled()
  })

  it('keeps route 1 (sibling prefetch) firing on EVERY moving frame', () => {
    // The mirror-image guard: route 1 is O(neededKeys) with no walk and its
    // whole job is the "camera nudged 1 px, fresh tile appeared" bridge, which
    // only exists in motion. Throttling the whole pump would make this 1;
    // gating the pump on cameraIdle would make it 0. Frames 0-4 are off-stride
    // so every call here is route 1.
    const visible = [tileKey(14, 14000, 6500)]
    const { catalog, prefetchSpy } = makeMockCatalog()
    const vtr = makeVtr(catalog, visible, 1)
    const camera = new Camera(SEOUL.lon, SEOUL.lat, 14)

    drivePumps(vtr, camera, 5)

    expect(prefetchSpy).toHaveBeenCalledTimes(5)
    const expectedSiblings = new Set(
      tileKeyChildren(tileKey(13, 7000, 3250)).filter((c) => !visible.includes(c)),
    )
    for (const [keys] of prefetchSpy.mock.calls) expect(new Set(keys)).toEqual(expectedSiblings)
  })

  it('keeps the velocity snapshot a 1-frame measurement, not a strided one', () => {
    // Guards the hazard the throttle could have introduced: prevPanCam is
    // captured BEFORE the stride check, so prev->cur dt stays ~16 ms. Had the
    // snapshot been throttled too, dt would stretch to 6 frames = 200 ms at the
    // 30 fps mobile cadence, and projectPanPrefetchTarget discards dt >= 200
    // (tile-decision.ts:474) — the throttle would have killed the route it
    // meant to amortise. After 5 frames prev must be frame 4's snapshot.
    const { vtr, camera } = makeSiblingsSilencedVtr()
    const startX = camera.centerX
    drivePumps(vtr, camera, 5)
    const scheduler = (vtr as unknown as { prefetchScheduler: PrefetchScheduler }).prefetchScheduler
    const prev = (scheduler as unknown as { prevPanCam: { cx: number; t: number } }).prevPanCam
    // Frame 4 read t = 1000 + 4*16 and cx = startX + 4*500 (drivePumps advances
    // both AFTER each pump). A snapshot strided to every 6th frame would still
    // hold frame 0's values here.
    expect(prev.t).toBe(1064)
    expect(prev.cx).toBeCloseTo(startX + 2000, 6)
  })
})
