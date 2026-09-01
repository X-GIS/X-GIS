// ═══ awaitMapIdle's decision logic, lifted out of the browser (#2231) ═══
//
// `awaitMapIdle` waits for the map's MapLibre-semantics `idle`. #2101 replaced
// its one-shot read of `_wasIdle` with a two-consecutive-tick rAF poll, because
// the flag is recomputed once per rAF tick and therefore still holds the PREVIOUS
// tick's answer immediately after a camera mutation.
//
// That fix had no non-vacuous end-to-end witness, and the reason is structural:
// `awaitMapIdle` is itself a `page.evaluate`, so calling it from Node costs a CDP
// round-trip, and on a fast fixture (`minimal&forcegl2=1&adaptive=0`, measured:
// rAF intervals 31-60 ms, `staleTicksAfterMutation = 0`) the round-trip is longer
// than the staleness window. An end-to-end arm was written, and it PASSED with the
// fix reverted — so it distinguished nothing and was deleted rather than shipped
// (#2231). The defect is only observable where a tick is SLOWER than the round
// trip, which is the heavy-SwiftShader regime, not `minimal`.
//
// So the decision moves here, where a fake clock can construct the one-tick stale
// window deterministically: `readIdle` returns true once and false after, and a
// one-shot read resolves 'idle' while the two-tick rule does not.
//
// ── The serialisation constraint this file exists under ─────────────────────
//
// Both exported functions are STRINGIFIED and evaluated inside the page, so
// neither may close over anything outside its own body: no imports, no
// module-level constants, no helper functions. Thresholds live inside
// `decideIdle`. `visual.ts` composes the two sources into one expression and
// hands it to `page.evaluate`, which evaluates the string directly — there is no
// `eval` or `new Function` in the page, and no second copy of this logic.
// The types below are erased at build time and cost the page nothing.

/** Diagnostics the page leaves on `window.__xgisAwaitIdleStats`; read by
 *  `_map-idle-flag-staleness-premise.spec.ts`. */
export interface IdleStats {
  ticks: number
  sawBusy: boolean
  resolvedBy: string
}

/** Everything `decideIdle` is not allowed to reach for itself. In the page these
 *  are the real bus / rAF / timers; in vitest they are fakes. */
export interface IdleDeps {
  /** The map's own idle flag, as of the last recompute. */
  readIdle: () => boolean
  /** Subscribe / unsubscribe the bus's `idle` event. */
  subscribe: (onIdle: () => void) => void
  unsubscribe: (onIdle: () => void) => void
  requestFrame: (cb: () => void) => number
  cancelFrame: (handle: number) => void
  setTimer: (cb: () => void, ms: number) => number
  clearTimer: (handle: number) => void
  /** Caller's overall budget. */
  budgetMs: number
  /** Mutated in place so the page can publish it before this ever resolves. */
  stats: IdleStats
}

/** Resolve when the map is idle, or when `budgetMs` runs out.
 *
 *  MUST stay closure-free — see the serialisation note at the top of this file.
 *  Written without `async`/`await` and without optional chaining on purpose: the
 *  source is transpiled before it is stringified, and helper-free syntax keeps
 *  the emitted text a plain self-contained function. */
export function decideIdle(deps: IdleDeps): Promise<'idle' | 'timeout'> {
  return new Promise<'idle' | 'timeout'>((resolve) => {
    // TWO consecutive ticks, not one: the map re-arms its own rAF from inside
    // its frame callback, so depending on registration order this poll's
    // callback for a given frame can run BEFORE the bus recomputes. One `true`
    // can still be the stale value; two cannot, because at least one full
    // recompute separates them (#2101).
    const REQUIRED_CONSECUTIVE = 2
    // Bounded no-progress guard. `RenderLoop.render()` early-returns on device
    // loss WITHOUT re-arming rAF, and a hidden page stops rAF outright — in both
    // the poll never advances and a caller with a long budget (220 s at
    // _split-bind-parity-gate) would sit out the whole thing, where the old
    // snapshot returned at once. If no tick has run AT ALL, fall back to the
    // snapshot: a loop that is not rendering has nothing left to draw.
    //
    // 5 s, not 1 s, and the threshold is the whole point. This escape cannot
    // distinguish "rAF is dead" from "rAF is slow" — it only sees that no tick
    // has run yet — so a threshold under the worst frame time re-creates the
    // very bug above: on a scene whose frames cost ~1-2 s (measured on
    // SwiftShader, see _adaptive-quality-ladder-gate's header) the first tick
    // lands after 1 s, this fires with `ticks === 0`, and `readIdle()` returns
    // the stale pre-mutation value — exactly the slow-tick regime where the CDP
    // round-trip no longer masks the staleness, i.e. the only regime where the
    // fix matters. 5 s clears the measured worst frame; the cost when rAF really
    // is dead is 5 s against budgets of 30-220 s.
    const STALL_MS = 5000

    let done = false
    let frame = 0
    let consecutive = 0

    const finish = (result: 'idle' | 'timeout', by: string): void => {
      if (done) return
      done = true
      deps.stats.resolvedBy = by
      deps.unsubscribe(onIdle)
      deps.clearTimer(budgetTimer)
      deps.clearTimer(stallTimer)
      deps.cancelFrame(frame)
      resolve(result)
    }
    const onIdle = (): void => finish('idle', 'event')

    const budgetTimer = deps.setTimer(() => finish('timeout', 'budget'), deps.budgetMs)

    const tick = (): void => {
      if (done) return
      deps.stats.ticks++
      if (deps.readIdle()) {
        consecutive++
        if (consecutive >= REQUIRED_CONSECUTIVE) {
          finish('idle', 'poll')
          return
        }
      } else {
        consecutive = 0
        deps.stats.sawBusy = true
      }
      frame = deps.requestFrame(tick)
    }
    frame = deps.requestFrame(tick)

    const stallTimer = deps.setTimer(() => {
      if (deps.stats.ticks === 0) finish(deps.readIdle() ? 'idle' : 'timeout', 'no-raf')
    }, STALL_MS)

    deps.subscribe(onIdle)
  })
}

/** The browser-side glue: builds the real deps off `window` and calls the
 *  decision. Also closure-free — `decide` arrives as a parameter, which is what
 *  keeps `decideIdle` the single authority rather than a copy.
 *
 *  Untestable in vitest by construction (it IS the globals), and it needs no
 *  test of its own: every e2e spec that settles runs it. */
export function runIdleDecisionInPage(
  decide: (deps: IdleDeps) => Promise<'idle' | 'timeout'>,
  budgetMs: number,
): Promise<'idle' | 'timeout'> {
  type MapLike = {
    _wasIdle?: boolean
    on?: (t: string, l: () => void) => void
    off?: (t: string, l: () => void) => void
  }
  const w = window as unknown as {
    __xgisMap?: { _eventBus?: MapLike } & MapLike
    __xgisAwaitIdleStats?: IdleStats
  }
  // FIRST, before any early return: a stale object left by a previous call in
  // the same page would let a broken helper read someone else's numbers.
  const stats: IdleStats = { ticks: 0, sawBusy: false, resolvedBy: '' }
  w.__xgisAwaitIdleStats = stats

  const bus = w.__xgisMap
  if (!bus) {
    stats.resolvedBy = 'no-map'
    return Promise.resolve('timeout')
  }
  if (typeof bus.on !== 'function' || typeof bus.off !== 'function') {
    return Promise.resolve('timeout')
  }

  return decide({
    readIdle: () => {
      const eb = bus._eventBus
      return (eb !== undefined && eb._wasIdle === true) || bus._wasIdle === true
    },
    subscribe: (onIdle) => bus.on!('idle', onIdle),
    unsubscribe: (onIdle) => bus.off!('idle', onIdle),
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (h) => cancelAnimationFrame(h),
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (h) => clearTimeout(h),
    budgetMs,
    stats,
  })
}
