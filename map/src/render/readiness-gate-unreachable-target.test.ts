// Regression for #2091 — the readiness gate must not pin `_czPendingAdvance`
// on a target the source can never reach.
//
// `keepLoopWarm` (render-loop-keep-warm.ts:80) keeps the render loop warm
// while any VT selection has a pending LOD advance, and `render-loop.ts:682`
// assigns that to `_needsRender` every frame — which `shouldRenderThisFrame()`
// reads first, and `map-event-bus.ts` folds into the `idle` predicate. So a
// pending flag that never clears means the map NEVER fires `idle` and the loop
// never stops: measured on the sweep scene as permanent rAF churn with a
// static camera, zero pending loads, zero missed tiles.
//
// The pin: the gate cleared the flag only at `cz === target` with
// `target = floor(camera.zoom)`, but `cz` is clamped to `source.maxLevel`
// right after the gate — so a source whose data stops below floor(z) (the
// synthetic earth surface is maxLevel 0, installed for every globe/background
// fill) stepped cz up, had it clamped back, and kept the flag forever.
//
// Fail-before: with maxLevel 0 and the camera at zoom 3 the flag is non-null
// on every frame after the first; fixed, it is null and the loop can idle.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Camera } from '../camera'
import { TileSelectionCache } from './tile-selection-cache'
import { keepLoopWarm } from '../render-loop-keep-warm'
import type { TileCatalog } from '@xgis/data'
import type { FrameDrawStats } from './frame-draw-stats'

const W = 512
const H = 320
const DPR = 1
const MARGIN = 2

const NO_STATS = { setGlobeTilesSelected: () => {} } as unknown as FrameDrawStats

/** Catalog that has NOTHING cached and stops at `maxLevel` — the shape of the
 *  synthetic earth surface (maxLevel 0) that ships in globe/background scenes.
 *  Records every prefetch so a test can assert the gate stopped probing LODs
 *  the source does not have (the observable a flag-only "fix" leaves untouched). */
function shallowCatalog(maxLevel: number): {
  source: TileCatalog
  prefetched: number[]
} {
  const prefetched: number[] = []
  const source = {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: (keys: number[]) => {
      prefetched.push(...keys)
    },
    indexGeneration: () => 0,
  } as unknown as TileCatalog
  return { source, prefetched }
}

function flatCam(zoom: number): Camera {
  const c = new Camera(0, 0, zoom)
  c.pitch = 0
  return c
}

/** `maxLevel` (the selectForFrame PARAMETER, a per-show sub-tile ceiling) is
 *  deliberately passed HIGHER than `source.maxLevel` so a test cannot pass by
 *  confusing the two — the gate's reachability question is about the SOURCE. */
function drive(
  cache: TileSelectionCache,
  cam: Camera,
  frameId: number,
  source: TileCatalog,
  paramMaxLevel = 22,
): void {
  cache.selectForFrame(
    cam,
    0,
    0,
    0,
    W,
    H,
    DPR,
    frameId,
    source,
    '',
    MARGIN,
    paramMaxLevel,
    NO_STATS,
  )
}

/** The real consumer: `keepLoopWarm` with every OTHER signal quiet, so the
 *  pending-advance flag is the only thing that can hold the loop warm. */
function loopWarm(cache: TileSelectionCache): boolean {
  return keepLoopWarm({
    totalMissed: 0,
    // #2149 — the raster/DEM signals now arrive through the registry scope; quiet here.
    pendingWork: { hasPending: () => false },
    vtRenderers: [
      { renderer: { hasPendingUploads: () => false, _selection: cache } },
    ] as unknown as Parameters<typeof keepLoopWarm>[0]['vtRenderers'],
  })
}

describe('#2091 — the readiness gate cannot pin an unreachable target', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('THE BEHAVIOUR DELTA: a camera moving above source.maxLevel no longer starves the 5 s net', () => {
    // Recorded deliberately — this diff is NOT render-neutral, and an
    // adversarial review pass caught the author claiming it was.
    //
    // The gate re-arms its timer whenever `target` CHANGES:
    //     if (!this._czPendingAdvance || this._czPendingAdvance.target !== target)
    // Pre-fix `target` was floor(z), so a camera crossing integer zooms ABOVE
    // `source.maxLevel` reset `since` on every crossing and the 5 s safety net
    // — the one whose comment promises "after 5 s of holding, advance anyway so
    // the user isn't stuck on a permanently-stale LOD" — could never fire. The
    // LOD stayed pinned at the pre-transition level for as long as the gesture
    // continued. Post-fix `target` is `min(floor(z), maxLevel)`, constant across
    // those crossings, so the net fires and the LOD climbs to the source's
    // ceiling. Same END state once tiles are ready; different DRAWN LOD while
    // they are not. This is the documented intent being restored, not a
    // regression — but it IS an observable change, so it is pinned here.
    let clock = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const cache = new TileSelectionCache()
    const { source } = shallowCatalog(2) // archive stops at z2
    // Anchor at z0 so the gate (not the >4-LOD bulk-jump branch) owns the climb.
    drive(cache, flatCam(0), 1, source)
    // Camera crosses 3 -> 4 -> 3 -> 4 with 2 s between frames: pre-fix every
    // crossing changed `target` (3,4,3,4) and reset the timer; post-fix target
    // is 2 throughout, so 5 s of holding actually elapses.
    const zs = [3, 4, 3, 4, 3, 4]
    zs.forEach((z, i) => {
      clock += 2_000
      drive(cache, flatCam(z), i + 2, source)
    })
    const sel = cache.selectForFrame(
      flatCam(4),
      0,
      0,
      0,
      W,
      H,
      DPR,
      99,
      source,
      '',
      MARGIN,
      22,
      NO_STATS,
    )
    expect(sel).not.toBeNull()
    // Post-fix: the net fired and the LOD reached the archive ceiling.
    // Pre-fix: starved timer, currentZ still 0 — a 2-LOD difference in the
    // tiles actually drawn.
    expect(sel!.currentZ, 'the 5 s readiness net stayed starved above maxLevel').toBe(2)
    // And assert it at the layer that actually feeds the renderer: the SELECTED
    // TILE SET, not just the scalar. Pre-fix this frame selected z0 tiles
    // (one root tile); post-fix it selects z2 tiles. Anything downstream —
    // which keys are fetched, which geometry is drawn — follows from this set,
    // so pinning it here is the render-input assertion the scalar alone is not.
    const drawnLods = [...new Set(sel!.tiles.map((t) => t.z))].sort()
    expect(drawnLods, 'the drawn tile LODs did not move with the gate').toEqual([2])
  })

  it('a maxLevel-0 source at camera zoom 3 settles: no pending advance, loop can idle', () => {
    const cache = new TileSelectionCache()
    const { source } = shallowCatalog(0)
    // Frame 1 anchors the hysteresis (the gate is inert while _hysteresisZ < 0).
    drive(cache, flatCam(3), 1, source)
    // Frames 2..6 — a STATIC camera. Pre-fix, frame 2 armed the flag
    // (target 3 > cz 0) and no later frame could clear it, because the
    // post-gate clamp put cz back to 0 every time.
    for (let f = 2; f <= 6; f++) drive(cache, flatCam(3), f, source)

    expect(
      cache._czPendingAdvance,
      'pending advance pinned on a target the source can never reach (#2091)',
    ).toBeNull()
    expect(loopWarm(cache), 'the render loop stays warm forever, so idle never fires').toBe(false)
  })

  it('and it stops PROBING LODs the source does not have (kills the flag-only mutant)', () => {
    // Non-vacuity guard, added after an adversarial review pass found a mutant
    // that survives the assertions above: keep the unreachable target and just
    // null the flag in the hold branch. That mutant leaves the gate running a
    // full readiness walk + prefetch at step = maxLevel + 1 EVERY frame —
    // selecting tiles the archive cannot serve. The real fix (a reachable
    // target) never enters the block, so nothing is probed.
    const cache = new TileSelectionCache()
    const { source, prefetched } = shallowCatalog(0)
    drive(cache, flatCam(3), 1, source)
    for (let f = 2; f <= 6; f++) drive(cache, flatCam(3), f, source)
    expect(
      prefetched,
      'the gate kept prefetching step LODs above the source maxLevel (#2091)',
    ).toEqual([])
  })

  it('a reachable climb still gates step-by-step (the fix does not disarm the gate)', () => {
    const cache = new TileSelectionCache()
    // maxLevel 10 — target 3 IS reachable, and nothing is cached, so the gate
    // must HOLD (a pending advance is exactly what should be armed here).
    const { source } = shallowCatalog(10)
    drive(cache, flatCam(0), 1, source)
    drive(cache, flatCam(3), 2, source)
    expect(
      cache._czPendingAdvance,
      'a real, reachable transition must still arm the gate',
    ).not.toBeNull()
    expect(loopWarm(cache), 'and must still keep the loop warm while it converges').toBe(true)
  })
})
