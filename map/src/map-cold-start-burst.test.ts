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

/** Controller wired to observable stub deps + a mutable clock/pending state. */
function harness() {
  const applied: boolean[] = []
  const state = { pending: true, now: 1000 }
  const ctl = new ColdStartBurstController({
    applyToAllSources: (on) => applied.push(on),
    hasPendingSourceWork: () => state.pending,
    now: () => state.now,
  })
  return { ctl, applied, state }
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

describe('ColdStartBurstController — hard 10 s wall-clock cap (#1155 F3)', () => {
  it('exits even when hasPendingSourceWork stays true', () => {
    const base = pool.coldStartBurstRefcount
    const { ctl, state } = harness() // now starts at 1000
    ctl.enter() // enterTime = 1000
    ctl.noteRenderedFrame()
    state.pending = true // an endless source that never goes idle

    state.now = 1000 + 9_999
    ctl.tickExit()
    expect(ctl.isOn).toBe(true) // below the cap → still burst

    state.now = 1000 + 10_000
    ctl.tickExit()
    expect(ctl.isOn).toBe(false) // cap fires despite pending work
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})
