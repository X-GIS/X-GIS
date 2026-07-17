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
  const state = { pending: true, eligible: true }
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const ctl = new ColdStartBurstController({
    applyToAllSources: (on) => applied.push(on),
    hasPendingSourceWork: () => state.pending,
    viewportEligible: () => state.eligible,
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

  it('ends only after 3 CONSECUTIVE idle frame-starts; a one-frame dip keeps burst', () => {
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
    ctl.tickExit() // idle 3 → exit
    expect(ctl.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
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
