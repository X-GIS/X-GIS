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
import { tileKey } from '@xgis/compiler'
import { keepLoopWarm, type KeepWarmTiles } from './render-loop-keep-warm'
import { classifyTile, KEEP_WARM_MAX_FAILURES } from './tile-decision'

const tiles = (loads: boolean, retries: boolean): KeepWarmTiles => ({
  hasPendingLoads: () => loads,
  failedTiles: { hasPendingRetries: () => retries },
})
const quiet = (): KeepWarmTiles => tiles(false, false)

/** One VT renderer as the gate sees it. BOTH arms are explicit so a case meaning to
 *  exercise one cannot pass on the other still firing. */
const vt = (
  uploads: boolean,
  lodAdvance: boolean,
): { renderer: { hasPendingUploads(): boolean; _selection: { _czPendingAdvance: unknown } } } => ({
  renderer: {
    hasPendingUploads: () => uploads,
    // The real shape: `{ target, since } | null`, non-null exactly while a transition
    // is in flight. The gate only ever asks whether it is null.
    _selection: { _czPendingAdvance: lodAdvance ? { target: 2, since: 0 } : null },
  },
})

function inputs(over: Partial<Parameters<typeof keepLoopWarm>[0]> = {}) {
  return {
    totalMissed: 0,
    raster: quiet(),
    hillshade: quiet(),
    vtRenderers: [] as Array<ReturnType<typeof vt>>,
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
    expect(keepLoopWarm(inputs({ vtRenderers: [vt(true, false)] }))).toBe(true)
  })

  it('#1997 — an unconverged LOD ramp keeps the loop warm', () => {
    // The state every OTHER signal here is structurally blind to. The readiness gate
    // advances the tile LOD one step per RENDERED frame, and a selection whose LOD is
    // still behind the camera can be legitimately EMPTY — a z=0 root tile is not inside
    // a zoom-2 sphere frustum. Empty selection ⇒ nothing requested, nothing missed,
    // nothing to upload: `totalMissed`, both raster arms and the upload scan all read
    // quiet in the very frame the ramp still owes work. The loop idled there and could
    // not restart, because the LOD (and the 5 s readiness timeout) only advance inside a
    // rendered frame — so the map fossilised at zero tiles until an invalidate().
    expect(keepLoopWarm(inputs({ vtRenderers: [vt(false, true)] }))).toBe(true)
    // Non-vacuity: a settled renderer must still let the loop idle, or the assertion
    // above would pass against a gate that had simply stopped discriminating.
    expect(keepLoopWarm(inputs({ vtRenderers: [vt(false, false)] }))).toBe(false)
  })

  it('the VT scan is reached only when nothing cheaper fired', () => {
    // Ordering is load-bearing: the VT scan is the one signal that costs a loop over
    // every source, so it must sit behind the O(1) checks rather than beside them.
    let uploadsScanned = 0
    let lodScanned = 0
    keepLoopWarm(
      inputs({
        totalMissed: 1,
        vtRenderers: [
          {
            renderer: {
              hasPendingUploads: () => {
                uploadsScanned++
                return false
              },
              get _selection() {
                lodScanned++
                return { _czPendingAdvance: null }
              },
            },
          },
        ],
      }),
    )
    expect(uploadsScanned, 'an earlier signal short-circuits the scan').toBe(0)
    expect(lodScanned, 'an earlier signal short-circuits the scan').toBe(0)
  })
})

// ═══ #1575's VT twin — #1596 ═══
//
// The raster arm above is bounded by `FailedTileLedger.hasPendingRetries()`. The VT arm
// has no ledger of its own: a failing VT tile reaches this gate ONLY as `totalMissed`,
// fed by the renderer's one line
//
//   if (!inner.terminal) this._drawStats.recordMissedTile()   (vector-tile-renderer.ts)
//
// applied to a `classifyTile` 'pending' decision. So the VT keep-warm window IS
// tile-decision's `KEEP_WARM_MAX_FAILURES` bound, and both arms of the policy are
// observable here without a GPU. The renderer needs a device; the decision it applies
// does not, which is why that subsystem was extracted in the first place.
describe('#1596 — a failing VT tile reaches this gate through totalMissed', () => {
  /** The renderer's consumer line above, replayed over ONE visible tile whose fetch has
   *  failed `failures` times in a row. Returns what `totalMissed` would be that frame. */
  const missedFor = (failures: number): number => {
    const d = classifyTile({
      visible: { z: 8, x: 100, y: 50, ox: 100 },
      visibleKey: tileKey(8, 100, 50),
      maxLevel: 14,
      parentAtMaxLevel: -1,
      archiveAncestor: -1,
      layerCache: new Map<number, unknown>(),
      hasSliceInCatalog: () => false,
      hasAnySliceInCatalog: () => false,
      hasEntryInIndex: () => true,
      failureCount: () => failures,
      sliceLayer: 'water',
    })
    return d.kind === 'pending' && !d.terminal ? 1 : 0
  }

  it('transient: the loop stays warm across the source backoff, so the retry can run', () => {
    // The pre-fix predicate (the source's `isFailed` boolean) made the FIRST failure
    // terminal: totalMissed hit 0 inside the first negative-cache window, the loop idled,
    // and the TTL then expired with no frame left to re-request — one 500 stranded the
    // tile until a user interaction. These two assertions are false under that policy.
    expect(missedFor(1)).toBe(1)
    expect(keepLoopWarm(inputs({ totalMissed: missedFor(1) }))).toBe(true)
    expect(keepLoopWarm(inputs({ totalMissed: missedFor(KEEP_WARM_MAX_FAILURES - 1) }))).toBe(true)
  })

  it('permanent: past the budget the miss stops counting and the loop idles', () => {
    // The other half — and false under the PRE-#1596 code, where every 'pending' counted
    // and totalMissed>0 kept an unfetchable tile hot-looping at 60 fps forever.
    expect(missedFor(KEEP_WARM_MAX_FAILURES)).toBe(0)
    expect(keepLoopWarm(inputs({ totalMissed: missedFor(KEEP_WARM_MAX_FAILURES) }))).toBe(false)
    expect(keepLoopWarm(inputs({ totalMissed: missedFor(KEEP_WARM_MAX_FAILURES + 9) }))).toBe(false)
  })
})
