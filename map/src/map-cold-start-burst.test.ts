// #1155 F3 — ColdStartBurstController state-machine unit tests. Device-free: the
// controller holds no map reference, so it is driven with stub deps
// (applyToAllSources / hasPendingSourceWork / injected clock).
//
// The MVT worker pool is a MODULE-LEVEL singleton shared across every map +
// controller, so its burst refcount is asserted RELATIVE to a per-test baseline;
// every test balances its own enter with an exit.

import { describe, expect, it } from 'vitest'
import { ColdStartBurstController } from './map-cold-start-burst'
import { getSharedMvtPool } from '@xgis/data'

const pool = getSharedMvtPool()

/** Controller wired to observable stub deps + mutable pending/eligibility state
 *  and a capturing fake timer, so the wall-clock backstop is driven
 *  deterministically (never a real setTimeout that would outlive the test). */
function harness() {
  const applied: boolean[] = []
  // `clock` drives the idle-DURATION half of the exit hysteresis (#2204); tests advance
  // it explicitly so neither half can be satisfied by accident.
  const state = { pending: true, eligible: true, clock: 1_000 }
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const ctl = new ColdStartBurstController({
    applyToAllSources: (on) => applied.push(on),
    hasPendingSourceWork: () => state.pending,
    viewportEligible: () => state.eligible,
    now: () => state.clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h) => {
      ;(h as unknown as { cleared: boolean }).cleared = true
    },
  })
  /** Fire the most-recently-armed, uncleared cap timer (one-shot, like setTimeout). */
  const fireCapTimer = () => {
    const t = [...timers].reverse().find((x) => !x.cleared)
    if (!t) throw new Error('no armed cap timer')
    t.cleared = true
    t.fn()
  }
  return { ctl, applied, state, timers, fireCapTimer }
}

describe('ColdStartBurstController — enter/exit + shared pool refcount (#1155 F3)', () => {
  it('enter raises the pool refcount + flags all sources; exit releases both', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, applied } = harness()
    ctl.enter()
    expect(ctl.isOn).toBe(true)
    expect(pool.coldStartBurstRefcount).toBe(base + 1)
    expect(applied.at(-1)).toBe(true)

    ctl.exit()
    expect(ctl.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
    expect(applied.at(-1)).toBe(false)
  })

  it('re-entry while already on does NOT double-increment; counters reset', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, applied, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame() // renderedFrames = 1
    ctl.enter() // rapid re-run that did not tear down first
    expect(pool.coldStartBurstRefcount).toBe(base + 1) // NOT base + 2
    expect(applied.filter((x) => x).length).toBe(1) // applyToAllSources(true) once
    // Counters were reset by re-entry → an idle scene can't exit until a fresh
    // rendered frame is noted.
    state.pending = false
    ctl.tickExit()
    ctl.tickExit()
    ctl.tickExit()
    expect(ctl.isOn).toBe(true)
    ctl.exit()
    expect(pool.coldStartBurstRefcount).toBe(base)
  })

  it('exit is idempotent — a double-exit never underflows the shared refcount', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl } = harness()
    ctl.enter()
    ctl.exit()
    ctl.exit() // e.g. exit predicate already fired, then destroy()
    expect(pool.coldStartBurstRefcount).toBe(base) // not base - 1
  })
})

describe('ColdStartBurstController — exit hysteresis + gating (#1155 F3)', () => {
  it('never exits before the first rendered frame (idle signal untrusted)', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, state } = harness()
    ctl.enter()
    state.pending = false // all-idle, but no frame rendered yet
    for (let i = 0; i < 5; i++) ctl.tickExit()
    expect(ctl.isOn).toBe(true)
    ctl.exit()
    expect(pool.coldStartBurstRefcount).toBe(base)
  })

  it('ends only after 3 CONSECUTIVE idle frame-starts AND the idle window (#2204); a one-frame dip keeps burst', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame() // first render → idle signal trustworthy

    state.pending = true
    ctl.tickExit()
    expect(ctl.isOn).toBe(true) // pending → idle counter 0

    state.pending = false
    ctl.tickExit()
    expect(ctl.isOn).toBe(true) // the mid-cascade one-frame all-false window (idle 1)

    state.pending = true
    ctl.tickExit()
    expect(ctl.isOn).toBe(true) // work reappeared → idle counter RESETS

    state.pending = false
    ctl.tickExit() // idle 1
    ctl.tickExit() // idle 2
    expect(ctl.isOn).toBe(true)
    ctl.tickExit() // idle 3 — frame count satisfied, but no time has passed yet (#2204)
    expect(ctl.isOn).toBe(true)
    state.clock += 500 // ...and now the wall-clock window closes too
    ctl.tickExit()
    expect(ctl.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})

// ═══ #2204 — the idle hysteresis must not be a pure frame count ═══
//
// Measured on the #2204 harness: the mid-cascade all-false window lasts 65 ms and occurs
// ONCE in a 26 s cascade, but three frame-starts fit inside it — so burst ended at ~12.5 s
// of a cascade still running at 29 s and 59% of the tiles were fetched afterwards at the
// steady 4/frame drain instead of the burst's 32. Frame counts are worth whatever the
// machine's frame rate makes them (~50 ms at 60 fps), which is the same argument the hard
// cap already makes for riding a non-rAF timer.
describe('ColdStartBurstController — the idle window is wall-clock, not frames (#2204)', () => {
  it('THE REGRESSION: three idle frame-starts inside the measured 65 ms dip do NOT end burst', () => {
    const { ctl, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame()
    state.pending = false
    // Ten frame-starts — far past COLD_START_BURST_IDLE_FRAMES — spread across the real
    // dip duration. Pre-#2204 the third of these ended burst.
    for (let i = 0; i < 10; i++) {
      state.clock += 6.5 // 10 x 6.5 ms = the 65 ms dip
      ctl.tickExit()
    }
    expect(ctl.isOn, 'a 65 ms dip ended the burst the cascade still needed').toBe(true)
  })

  it('still ends once the idle window genuinely closes', () => {
    const { ctl, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame()
    state.pending = false
    ctl.tickExit()
    state.clock += 500
    ctl.tickExit()
    ctl.tickExit()
    expect(ctl.isOn, 'a genuinely settled scene must still release burst').toBe(false)
  })

  it('the FRAME half still guards: a long wait with too few frame-starts keeps burst', () => {
    const { ctl, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame()
    state.pending = false
    state.clock += 10_000
    ctl.tickExit() // idle 1 — window is wide open, but only one frame-start
    expect(ctl.isOn, 'the frame count must still be required').toBe(true)
  })

  it('work reappearing resets the CLOCK too, so two short dips cannot accumulate', () => {
    const { ctl, state } = harness()
    ctl.enter()
    ctl.noteRenderedFrame()
    state.pending = false
    state.clock += 400
    ctl.tickExit()
    state.pending = true // a fetch wave lands — the cascade is not over
    ctl.tickExit()
    state.pending = false
    state.clock += 400 // a second 400 ms dip; 400+400 must NOT count as 800
    ctl.tickExit()
    ctl.tickExit()
    ctl.tickExit()
    expect(ctl.isOn, 'two separate short dips summed into an exit').toBe(true)
  })
})

describe('ColdStartBurstController — hard wall-clock cap via non-rAF timer (#1155 F3 / #1167 C3)', () => {
  it('the backstop timer ends burst even when tickExit never runs and work stays pending (hidden tab: rAF ~0 Hz)', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, state, fireCapTimer } = harness()
    ctl.enter()
    ctl.noteRenderedFrame()
    state.pending = true // endless source: the idle hysteresis can never fire
    // Deliberately NO tickExit() calls — models a hidden tab whose render loop
    // (rAF) is throttled to ~0 Hz, the exact case the old rAF-only cap missed.
    expect(ctl.isOn).toBe(true)
    fireCapTimer()
    expect(ctl.isOn).toBe(false) // the timer, not rAF, closed the cap
    expect(pool.coldStartBurstRefcount).toBe(base)
  })

  it('exit() clears the armed timer so a stale fire cannot underflow the refcount', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, timers } = harness()
    ctl.enter()
    ctl.exit()
    expect(timers.at(-1)?.cleared).toBe(true)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })

  it('re-entry clears the previous timer and arms a fresh one (cap re-converges for the new scene)', () => {
    const { ctl, timers } = harness()
    ctl.enter()
    const first = timers.at(-1)
    ctl.enter() // rapid re-run without a teardown
    expect(first?.cleared).toBe(true)
    expect(timers.length).toBe(2)
    expect(timers.at(-1)?.cleared).toBe(false)
    ctl.exit()
  })
})

describe('ColdStartBurstController — desktop-only viewport gate (#1167)', () => {
  it('enter() on a mobile-class viewport is fully inert: no refcount, no source flags, no backstop', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, applied, state, timers } = harness()
    state.eligible = false // mobile
    ctl.enter()
    expect(ctl.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base) // NOT base + 1
    expect(applied.length).toBe(0) // applyToAllSources never called
    expect(timers.length).toBe(0) // no wall-clock backstop armed on a non-burst
    // Every downstream hook stays a no-op on the inert controller.
    ctl.noteRenderedFrame()
    ctl.tickExit()
    ctl.exit()
    expect(ctl.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})
