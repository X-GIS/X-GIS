import { describe, it, expect, vi } from 'vitest'
import { XGISMap } from './map'
import { QUALITY } from '@xgis/engine'

// destroy() teardown is GPU-free in its guard/null-safety paths, so the
// idempotency + post-destroy-inert contract is unit-testable on a
// never-run map (ctx undefined, controller null, vtSources empty). The
// full heap/GPU unmount-leak assertion lives in the browser e2e gate.

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

describe('XGISMap.destroy()', () => {
  it('tears down a never-run map without throwing, and is idempotent', () => {
    const map = new XGISMap(stubCanvas())
    expect(() => map.destroy()).not.toThrow()
    expect(() => map.destroy()).not.toThrow()
  })

  it('leaves the map inert — post-destroy invalidate() no-ops safely', () => {
    const map = new XGISMap(stubCanvas())
    map.destroy()
    expect(() => map.invalidate()).not.toThrow()
  })
})

// ═══ #1569 — the coverage teardown spine ═══════════════════════════════════
//
// destroy() is thorough — #1359 verified it healthy for rAF, timers, pointer /
// keyboard / media-query / visibility listeners, the four __xgis* window globals
// and the RHI device. That is exactly why these gaps were easy to miss: the
// coverage renderer was the one renderer its release list did not name, and
// `_teardownForReinit` is a DIFFERENT, shorter path that was never brought level
// with it. Both now run one shared stop-block.
describe('#1569 coverage machinery does not outlive the map', () => {
  it('destroy() leaves autoRefreshCoverage inert instead of arming an unstoppable loop', () => {
    vi.useFakeTimers()
    try {
      const map = new XGISMap(stubCanvas())
      map.destroy()

      const onError = vi.fn()
      // The WORST member of the unguarded family: destroy() already ran stopAll(),
      // so nothing calls stop() again on a map the host believes gone; the
      // scheduler's tick re-arms whenever timers.get(id)?.gen === gen, which is
      // true forever. Each tick threw ("not a declared coverage source"), was
      // caught, reported, and re-armed — unbounded post-destroy periodic activity
      // plus a permanent GC pin of the whole map graph through the closure.
      map.autoRefreshCoverage('ghost', { intervalMs: 1000, onError })
      vi.advanceTimersByTime(10_000)

      expect(onError, 'a destroyed map must not run refresh ticks').not.toHaveBeenCalled()
      expect(
        (
          map as unknown as { _coverageRefresh: { isRunning(id: string): boolean } }
        )._coverageRefresh.isRunning('ghost'),
        'and must not be left holding a timer',
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('setQuality on a destroyed map does not mutate the process-global quality', () => {
    // "Does not throw" is NOT the assertion here: on a never-run map most of
    // setQuality's body is unreachable anyway, so a not-throw check passes with or
    // without the latch and distinguishes nothing. What IS observable is the
    // PROCESS-GLOBAL `QUALITY` record — `updateQuality(patch)` mutates it before any
    // of the rebuild calls, so an unlatched destroyed map silently re-tunes every
    // OTHER map in the page.
    const map = new XGISMap(stubCanvas())
    const before = QUALITY.msaa
    map.destroy()
    map.setQuality({ msaa: before === 4 ? 1 : 4 })
    expect(QUALITY.msaa, 'a destroyed map must not re-tune the shared quality').toBe(before)
  })

  it('setBackgroundFill on a destroyed map mutates no state', () => {
    // Same reasoning as setQuality above: assert on something that MOVES. On a
    // never-run map the install branch is unreachable (`this.renderer` undefined),
    // so the distinguishing effect available here is the style state itself —
    // `_backgroundColor`, which the unlatched method writes before tagging STYLE
    // dirty. On a RUN map the same latch also stops `teardownSource` /
    // `underOccluder.destroy()` / `_installSyntheticEarthSurfaceSource` from
    // touching a torn-down device, which this harness cannot reach.
    const map = new XGISMap(stubCanvas())
    const inner = map as unknown as { _backgroundColor: unknown }
    const before = inner._backgroundColor
    map.destroy()
    map.setBackgroundFill([0.1, 0.2, 0.3, 1])
    expect(inner._backgroundColor, 'a destroyed map must not restyle itself').toBe(before)
  })

  it('destroy() drops retained coverage payloads, so getCoverage() stops answering', () => {
    const map = new XGISMap(stubCanvas())
    const raw = (map as unknown as { rawDatasets: Map<string, unknown> }).rawDatasets
    raw.set('cell-2026-08-04', { _vectorTile: true })
    map.destroy()
    expect(raw.size, 'retained CPU payloads must be released').toBe(0)
  })

  it('_teardownForReinit runs the SAME stop-block destroy() runs', () => {
    // The scene-swap path. Before this, a re-run stopped none of it: the refresh
    // scheduler lives on a MAP field (not on the torn-down ctx), so
    // _releaseGpuResources never touched it, and because rawDatasets survived the
    // swap the "not a declared coverage source" throw that would have killed a
    // ghost tick never fired — so the loop stayed healthy forever, re-arming the
    // OLD scene's region into the NEW scene's renderer on a validator roll.
    const map = new XGISMap(stubCanvas())
    const inner = map as unknown as {
      rawDatasets: Map<string, unknown>
      _coverageRefresh: { isRunning(id: string): boolean }
      _teardownForReinit(): void
    }
    inner.rawDatasets.set('scene-a-only', { _vectorTile: true })
    map.autoRefreshCoverage('scene-a-only', { intervalMs: 1000, onError: () => {} })
    expect(inner._coverageRefresh.isRunning('scene-a-only')).toBe(true)

    inner._teardownForReinit()

    expect(inner._coverageRefresh.isRunning('scene-a-only'), 'the poll loop stops').toBe(false)
    expect(inner.rawDatasets.has('scene-a-only'), 'the ghost payload is pruned').toBe(false)
    // …and the map is NOT destroyed — reinit must stay re-runnable.
    expect(() => map.invalidate()).not.toThrow()
  })
})

// ═══ #1570 — in-flight work is CANCELLED, not just unscheduled ═════════════
describe('#1570 teardown cancels the coverage read chain', () => {
  /** The map injects its abort signal through `_coverageDeps.guardedFetch`, which is
   *  the ONE fetch the whole coverage ladder goes through — the range probe, every
   *  chunk read, and the whole-file fallback. Reading the signal back out of it is
   *  therefore the honest assertion: it proves the plumbing, not a mock. */
  function signalFrom(map: XGISMap): AbortSignal | null | undefined {
    const deps = (
      map as unknown as { _coverageDeps: { guardedFetch: (l: string) => typeof fetch } }
    )._coverageDeps
    let seen: AbortSignal | null | undefined
    const realFetch = globalThis.fetch
    globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
      seen = init?.signal
      return Promise.reject(new Error('probe'))
    }) as typeof fetch
    try {
      void deps
        .guardedFetch('probe')('https://example.invalid/cell.h5')
        .catch(() => {})
    } finally {
      globalThis.fetch = realFetch
    }
    return seen
  }

  it('every coverage fetch carries the map-scoped signal, and destroy() fires it', () => {
    const map = new XGISMap(stubCanvas())
    const live = signalFrom(map)
    expect(live, 'the coverage ladder had NO AbortSignal at all before this').toBeInstanceOf(
      AbortSignal,
    )
    expect(live!.aborted).toBe(false)

    map.destroy()
    // A signal-less fetch is uncancellable BY SPEC, so an in-flight cell read
    // (10-250 MB, capped at 256 MB) streamed to completion, was fully buffered and
    // parsed, and only then discarded at a landing guard — on a dead map, competing
    // with the replacement scene's own fetches.
    expect(live!.aborted, 'destroy() must cancel reads already in flight').toBe(true)
  })

  it('a scene swap cancels the OUTGOING scene and hands the next one a live signal', () => {
    const map = new XGISMap(stubCanvas())
    const first = signalFrom(map)
    ;(map as unknown as { _teardownForReinit(): void })._teardownForReinit()
    expect(first!.aborted, 'the old scene-s reads are cancelled').toBe(true)
    const second = signalFrom(map)
    expect(second!.aborted, 'the next run must not be born pre-aborted').toBe(false)
    expect(second).not.toBe(first)
  })
})
