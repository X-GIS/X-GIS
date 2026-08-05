// ═══ #1575 — the end-of-frame keep-warm gate ═══
//
// This predicate is the difference between a map that converges and one that fossilises
// half-loaded, and until it was extracted it was reachable only through a full GPU frame
// — so the disjunct that was MISSING from it could not be gated at all.
//
// The missing one: a raster/DEM tile waiting out a retry backoff. Nothing else here can
// see that state — `hasPendingLoads` returns 0 the moment the failed load settles, and
// `totalMissed` counts VT sources only. The retry is re-attempted solely from inside
// `render()`, so on a static camera the loop stopped and the backoff was never read: a
// transiently failed basemap tile stayed a hole after the server had recovered. (With the
// backoff on a rendered-FRAME counter it was worse still — the clock itself froze.)

import { describe, it, expect } from 'vitest'
import { keepLoopWarm, type KeepWarmTiles } from './render-loop-keep-warm'

const tiles = (loads: boolean, retries: boolean): KeepWarmTiles => ({
  hasPendingLoads: () => loads,
  failedTiles: { hasPendingRetries: () => retries },
})
const quiet = (): KeepWarmTiles => tiles(false, false)

function inputs(over: Partial<Parameters<typeof keepLoopWarm>[0]> = {}) {
  return {
    totalMissed: 0,
    raster: quiet(),
    hillshade: quiet(),
    vtRenderers: [] as Array<{ renderer: { hasPendingUploads(): boolean } }>,
    ...over,
  }
}

describe('keepLoopWarm', () => {
  it('a fully settled scene lets the loop idle', () => {
    // The control every case below leans on: without it, a gate that returned true
    // unconditionally would satisfy all of them and destroy idle-skip entirely.
    expect(keepLoopWarm(inputs())).toBe(false)
  })

  it('#1575 — a raster tile awaiting a retry keeps the loop warm', () => {
    expect(keepLoopWarm(inputs({ raster: tiles(false, true) }))).toBe(true)
  })

  it('#1575 — and so does a DEM tile: the hillshade sibling is not forgotten', () => {
    // This pair has drifted before (#1057 reached two of four renderers, #1436 landed on
    // one of two backend arms, #1477 on one of two fade ramps). Pin both arms.
    expect(keepLoopWarm(inputs({ hillshade: tiles(false, true) }))).toBe(true)
  })

  it('keeps every pre-existing signal — missed tiles, both mid-fetch arms, VT uploads', () => {
    expect(keepLoopWarm(inputs({ totalMissed: 1 }))).toBe(true)
    expect(keepLoopWarm(inputs({ raster: tiles(true, false) }))).toBe(true)
    expect(keepLoopWarm(inputs({ hillshade: tiles(true, false) }))).toBe(true)
    expect(
      keepLoopWarm(inputs({ vtRenderers: [{ renderer: { hasPendingUploads: () => true } }] })),
    ).toBe(true)
  })

  it('the VT upload scan is reached only when nothing cheaper fired', () => {
    // Ordering is load-bearing: the upload scan is the one signal that costs a loop over
    // every source, so it must sit behind the O(1) checks rather than beside them.
    let scanned = 0
    keepLoopWarm(
      inputs({
        totalMissed: 1,
        vtRenderers: [
          {
            renderer: {
              hasPendingUploads: () => {
                scanned++
                return false
              },
            },
          },
        ],
      }),
    )
    expect(scanned, 'an earlier signal short-circuits the scan').toBe(0)
  })
})
