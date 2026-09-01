// ═══ The witness awaitMapIdle could not have end-to-end (#2231) ═══
//
// #2101 replaced `awaitMapIdle`'s one-shot read of the map's `_wasIdle` flag with
// a two-consecutive-tick rAF poll, because the flag is recomputed once per rAF
// tick and so still holds the PREVIOUS tick's answer right after a camera
// mutation. The engine premise is pinned by
// `_map-idle-flag-staleness-premise.spec.ts`; the HELPER's own behaviour was not,
// and an end-to-end arm could not pin it: `awaitMapIdle` is a `page.evaluate`, so
// invoking it costs a CDP round-trip, and on `minimal&forcegl2=1&adaptive=0` the
// measured rAF interval is 31-60 ms with `staleTicksAfterMutation = 0` — the
// round-trip outlasts the whole staleness window. The arm that was written
// PASSED with the fix reverted, and was deleted rather than shipped (#2231).
//
// A fake clock has no round-trip, so the stale window is constructible here:
// `readIdle` answers true once and false after, exactly the shape a one-shot read
// mistakes for a settled map.
//
// Fail-before, both cuts measured (see the PR):
//   - REQUIRED_CONSECUTIVE 2 → 1: "the stale first true settled it" reds.
//   - a pre-tick one-shot `if (readIdle()) resolve('idle')`: reds with ticks 0.

import { describe, it, expect } from 'vitest'
import { decideIdle, runIdleDecisionInPage, type IdleDeps, type IdleStats } from './idle-decision'

/** A synchronous fake clock: rAF frames and timers fire only when pumped, so
 *  every ordering this asserts is constructed rather than raced. */
function harness(
  readIdleSeq: readonly boolean[],
  budgetMs = 30_000,
  decide: typeof decideIdle = decideIdle,
) {
  let now = 0
  let nextId = 1
  let reads = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const frames = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const stats: IdleStats = { ticks: 0, sawBusy: false, resolvedBy: '' }

  const deps: IdleDeps = {
    // Past the end of the sequence, the map stays settled — the tail of every
    // scenario here is "and then it really did go idle".
    readIdle: () => readIdleSeq[reads++] ?? true,
    subscribe: (l) => void listeners.add(l),
    unsubscribe: (l) => void listeners.delete(l),
    requestFrame: (cb) => {
      const id = nextId++
      frames.set(id, cb)
      return id
    },
    cancelFrame: (h) => void frames.delete(h),
    setTimer: (cb, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, cb })
      return id
    },
    clearTimer: (h) => void timers.delete(h),
    budgetMs,
    stats,
  }

  let settled: 'idle' | 'timeout' | null = null
  const promise = decide(deps).then((r) => {
    settled = r
    return r
  })

  return {
    stats,
    promise,
    listeners,
    get settled() {
      return settled
    },
    /** Live handle counts — what a leak would show up as. */
    get pending() {
      return { timers: timers.size, frames: frames.size, listeners: listeners.size }
    },
    /** Advance the clock and fire every timer that came due, in time order. */
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) break
        const [id, t] = due[0]!
        timers.delete(id)
        t.cb()
      }
    },
    /** Run the rAF callbacks queued right now; re-arms land in the next batch. */
    frame(ms = 16) {
      now += ms
      const batch = [...frames.entries()]
      frames.clear()
      for (const [, cb] of batch) cb()
    },
    emitIdle() {
      for (const l of [...listeners]) l()
    },
  }
}

/** Let the microtask that resolves the promise run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('decideIdle — the stale-flag window (#2101 / #2231)', () => {
  it('does NOT settle on the stale first true; it waits for the map to really go idle', async () => {
    // The one-tick stale window: `true` (the pre-mutation value), then the busy
    // frames, then genuinely idle. A one-shot read — or REQUIRED_CONSECUTIVE 1 —
    // resolves on that first `true` and reports a moving map as settled.
    const h = harness([true, false, false, false, true, true])

    h.frame() // tick 1 → the STALE true
    await flush()
    expect(
      h.settled,
      'resolved on the first tick — that true is the pre-mutation value, and settling on it is the #2101 defect',
    ).toBe(null)

    h.frame() // 2 → false
    h.frame() // 3 → false
    await flush()
    expect(h.settled, 'still moving').toBe(null)
    expect(h.stats.sawBusy, 'the busy frames must be recorded').toBe(true)

    h.frame() // 4 → false
    h.frame() // 5 → true  (one is not enough)
    await flush()
    expect(h.settled, 'one true after busy is still only one').toBe(null)

    h.frame() // 6 → true  → two consecutive
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats.resolvedBy).toBe('poll')
    expect(h.stats.ticks).toBe(6)
  })

  it('two consecutive trues from the start settle it, and no earlier', async () => {
    const h = harness([true, true])
    h.frame()
    await flush()
    expect(h.settled, 'one tick is never enough, however idle it looks').toBe(null)
    h.frame()
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats).toMatchObject({ ticks: 2, sawBusy: false, resolvedBy: 'poll' })
  })

  it('a busy tick between two trues resets the run', async () => {
    // true, false, true, true — the pair must be CONSECUTIVE, not merely two.
    const h = harness([true, false, true, true])
    h.frame()
    h.frame()
    h.frame()
    await flush()
    expect(h.settled, 'the false in the middle must reset the count').toBe(null)
    h.frame()
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats.ticks).toBe(4)
  })
})

describe('decideIdle — the other three exits', () => {
  it("the bus's own `idle` event resolves immediately", async () => {
    const h = harness([false, false, false])
    h.emitIdle()
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats.resolvedBy).toBe('event')
  })

  it('the budget expires loudly rather than hanging', async () => {
    const h = harness([false, false, false, false, false, false, false, false], 1000)
    h.frame()
    h.frame()
    h.advance(1000)
    await expect(h.promise).resolves.toBe('timeout')
    expect(h.stats.resolvedBy).toBe('budget')
  })

  it('rAF never running for 5 s falls back to the snapshot — idle when the flag says so', async () => {
    // Device loss / a hidden page: `RenderLoop.render()` stops re-arming rAF, so
    // the poll can never advance. With ticks 0 the snapshot is all there is.
    const h = harness([true])
    h.advance(5000) // no frame() at all
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats).toMatchObject({ ticks: 0, resolvedBy: 'no-raf' })
  })

  it('…and times out when the snapshot says the map is still busy', async () => {
    const h = harness([false])
    h.advance(5000)
    await expect(h.promise).resolves.toBe('timeout')
    expect(h.stats.resolvedBy).toBe('no-raf')
  })

  it('a single tick disarms the no-raf escape — SLOW is not DEAD', async () => {
    // The threshold's whole point: on a ~1-2 s SwiftShader frame the first tick
    // lands after the escape would have fired on a shorter budget. Once ANY tick
    // has run, the escape must decline and let the poll decide.
    const h = harness([false, false, true, true])
    h.frame() // one tick before the 5 s mark
    h.advance(5000)
    await flush()
    expect(h.settled, 'the escape fired despite rAF demonstrably running').toBe(null)
    h.frame()
    h.frame()
    h.frame()
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats.resolvedBy).toBe('poll')
  })
})

describe('decideIdle — cleanup', () => {
  it('releases every handle it took, and a late tick cannot resolve twice', async () => {
    const h = harness([true, true])
    h.frame()
    h.frame()
    await expect(h.promise).resolves.toBe('idle')
    expect(
      h.pending,
      'a leaked timer keeps the page busy for the rest of the spec; a leaked listener fires into a dead closure',
    ).toEqual({ timers: 0, frames: 0, listeners: 0 })

    // Nothing is queued, so these are no-ops — but they must also not throw or
    // flip `resolvedBy` if the map keeps ticking after we stopped caring.
    h.frame()
    h.emitIdle()
    h.advance(60_000)
    expect(h.stats.resolvedBy).toBe('poll')
    expect(h.stats.ticks).toBe(2)
  })
})

describe('decideIdle — the serialisation constraint it lives under', () => {
  // The decision is STRINGIFIED into the page (visual.ts composes it with
  // runIdleDecisionInPage into one `page.evaluate` expression). A closure — an
  // import, a module-level constant, a shared helper — survives tsc, survives
  // vitest, and dies only in the browser, as a ReferenceError inside a settle
  // helper that every spec depends on.
  //
  // So the check is not a regex over the text. A regex WAS tried and is
  // measurably blind: vitest's esbuild keeps ESM, so an imported binding used
  // inside the function comes back as the bare identifier `readFileSync` with no
  // `mod_1.` prefix to match — planting exactly that import left the pattern
  // green. Instead the function is REBUILT from its own source in a realm that
  // has no module bindings, which is what the page does, and then driven.
  const reconstitute = (): typeof decideIdle =>
    new Function(`return (${decideIdle.toString()})`)() as typeof decideIdle

  it('rebuilt from its own source text alone, it still settles correctly', async () => {
    // Same scenario as the reset test above, so a behavioural difference between
    // the imported function and the page's copy would show as a wrong answer,
    // not just as a throw.
    const h = harness([true, false, true, true], 30_000, reconstitute())
    h.frame()
    h.frame()
    h.frame()
    await flush()
    expect(h.settled, 'the page copy must apply the same reset rule').toBe(null)
    h.frame()
    await expect(h.promise).resolves.toBe('idle')
    expect(h.stats).toMatchObject({ ticks: 4, resolvedBy: 'poll' })
  })

  it('the page glue is standalone too — its only free name is a browser global', () => {
    // It cannot be RUN here (it IS the globals), but rebuilding it proves it
    // parses alone, and the name it fails on proves nothing from module scope
    // got in ahead of the `window` read on its first line.
    const rebuilt = new Function(`return (${runIdleDecisionInPage.toString()})`)() as (
      decide: unknown,
      budgetMs: number,
    ) => unknown
    expect(() => rebuilt(() => Promise.resolve('idle'), 1000)).toThrowError(/window is not defined/)
    // And it takes the decision as a PARAMETER — that is what keeps decideIdle
    // the single authority instead of a second copy pasted into the page.
    const src = runIdleDecisionInPage.toString()
    expect(src.slice(0, src.indexOf(')'))).toContain('decide')
  })
})
