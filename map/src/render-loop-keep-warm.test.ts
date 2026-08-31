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
//
// #2149 increment 6 — every signal except `totalMissed` now reaches the gate through ONE
// registry scope read (SCOPE_KEEP_WARM). The per-kind truths (the real ledgers, their
// bounds, the VT walks) are pinned against the real chains in pending-work.test.ts; what
// THIS suite owns is the gate's contract: the scoped read is consulted, its verdict
// passes through, the scope is SCOPE_KEEP_WARM exactly, and `totalMissed` short-circuits
// ahead of it.

import { describe, it, expect } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { keepLoopWarm } from './render-loop-keep-warm'
import { SCOPE_KEEP_WARM, type PendingWorkScope } from './pending-work'
import { classifyTile, KEEP_WARM_MAX_FAILURES } from './tile-decision'

const work = (pending: boolean, seen?: PendingWorkScope[]) => ({
  hasPending: (scope: PendingWorkScope = []) => {
    seen?.push(scope)
    return pending
  },
})

function inputs(over: Partial<Parameters<typeof keepLoopWarm>[0]> = {}) {
  return {
    totalMissed: 0,
    pendingWork: work(false),
    ...over,
  }
}

describe('keepLoopWarm', () => {
  it('a fully settled scene lets the loop idle', () => {
    // The control every case below leans on: without it, a gate that returned true
    // unconditionally would satisfy all of them and destroy idle-skip entirely.
    expect(keepLoopWarm(inputs())).toBe(false)
  })

  it('#1575/#2149 — pending registered work keeps the loop warm', () => {
    expect(keepLoopWarm(inputs({ pendingWork: work(true) }))).toBe(true)
  })

  it('#2149 — the read is SCOPE_KEEP_WARM exactly, not SCOPE_ALL and not a subset', () => {
    // Scope identity is load-bearing in BOTH directions: an unscoped read would silently
    // widen this end-of-frame gate to every registered kind (glyphs, sprites, coverage),
    // and a narrowed one would re-open the #1997 fossilised-mid-ramp hole — either drift
    // changes which signals re-arm _needsRender without any verdict check going red.
    const seen: PendingWorkScope[] = []
    keepLoopWarm(inputs({ pendingWork: work(false, seen) }))
    expect(seen).toEqual([SCOPE_KEEP_WARM])
  })

  it('keeps the pre-existing totalMissed signal', () => {
    expect(keepLoopWarm(inputs({ totalMissed: 1 }))).toBe(true)
  })

  it('totalMissed short-circuits ahead of the registry read', () => {
    // Ordering is load-bearing: the scope's VT kinds each cost a loop over the sources,
    // so the cheap per-frame count must sit in front of the registry read, not beside it
    // — the same cheap-first ordering the hand-rolled body kept.
    const seen: PendingWorkScope[] = []
    keepLoopWarm(inputs({ totalMissed: 1, pendingWork: work(false, seen) }))
    expect(seen, 'an earlier signal short-circuits the registry read').toEqual([])
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
