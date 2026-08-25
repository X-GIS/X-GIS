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

import { describe, it, expect } from 'vitest'
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
 *  synthetic earth surface (maxLevel 0) that ships in globe/background scenes. */
function shallowCatalog(maxLevel: number): TileCatalog {
  return {
    maxLevel,
    getLayerZoomRange: () => null,
    hasEntryInIndex: () => false,
    hasData: () => true,
    hasTileData: () => false,
    prefetchTiles: () => {},
    indexGeneration: () => 0,
  } as unknown as TileCatalog
}

function flatCam(zoom: number): Camera {
  const c = new Camera(0, 0, zoom)
  c.pitch = 0
  return c
}

function drive(
  cache: TileSelectionCache,
  cam: Camera,
  frameId: number,
  source: TileCatalog,
  maxLevel: number,
): void {
  cache.selectForFrame(cam, 0, 0, 0, W, H, DPR, frameId, source, '', MARGIN, maxLevel, NO_STATS)
}

/** The real consumer: `keepLoopWarm` with every OTHER signal quiet, so the
 *  pending-advance flag is the only thing that can hold the loop warm. */
function loopWarm(cache: TileSelectionCache): boolean {
  const quiet = {
    hasPendingLoads: () => false,
    failedTiles: { hasPendingRetries: () => false },
  }
  return keepLoopWarm({
    totalMissed: 0,
    raster: quiet,
    hillshade: quiet,
    vtRenderers: [
      { renderer: { hasPendingUploads: () => false, _selection: cache } },
    ] as unknown as Parameters<typeof keepLoopWarm>[0]['vtRenderers'],
  })
}

describe('#2091 — the readiness gate cannot pin an unreachable target', () => {
  it('a maxLevel-0 source at camera zoom 3 settles: no pending advance, loop can idle', () => {
    const cache = new TileSelectionCache()
    const source = shallowCatalog(0)
    // Frame 1 anchors the hysteresis (the gate is inert while _hysteresisZ < 0).
    drive(cache, flatCam(3), 1, source, 0)
    // Frames 2..6 — a STATIC camera. Pre-fix, frame 2 armed the flag
    // (target 3 > cz 0) and no later frame could clear it, because the
    // post-gate clamp put cz back to 0 every time.
    for (let f = 2; f <= 6; f++) drive(cache, flatCam(3), f, source, 0)

    expect(
      cache._czPendingAdvance,
      'pending advance pinned on a target the source can never reach (#2091)',
    ).toBeNull()
    expect(loopWarm(cache), 'the render loop stays warm forever, so idle never fires').toBe(false)
  })

  it('a reachable climb still gates step-by-step (the fix does not disarm the gate)', () => {
    const cache = new TileSelectionCache()
    // maxLevel 10 — target 3 IS reachable, and nothing is cached, so the gate
    // must HOLD (a pending advance is exactly what should be armed here).
    const source = shallowCatalog(10)
    drive(cache, flatCam(0), 1, source, 10)
    drive(cache, flatCam(3), 2, source, 10)
    expect(
      cache._czPendingAdvance,
      'a real, reachable transition must still arm the gate',
    ).not.toBeNull()
    expect(loopWarm(cache), 'and must still keep the loop warm while it converges').toBe(true)
  })
})
