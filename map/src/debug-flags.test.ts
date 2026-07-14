import { describe, it, expect, afterEach } from 'vitest'
import { animTimePinnedSeconds } from './debug-flags'

// #826 — the particle-flow animation-clock pin (design §3.0 / §5.3 deterministic-probe seam). The
// candidate-(b) particle position is a pure function of (seed, t), so pinning `t` makes the frame
// byte-reproducible. The URL param (`?animt`) is unavailable in the node test env (no window), so
// this covers the live `__xgisAnimT` global mirror + the unpinned default.
describe('#826 particle animation-clock pin (animTimePinnedSeconds)', () => {
  afterEach(() => {
    delete (globalThis as { __xgisAnimT?: unknown }).__xgisAnimT
  })

  it('is unpinned (null) by default — the live performance.now() clock runs', () => {
    expect(animTimePinnedSeconds()).toBeNull()
  })

  it('the live global mirror pins the clock, and sweeps WITHOUT a reload', () => {
    ;(globalThis as { __xgisAnimT?: number }).__xgisAnimT = 0.25
    expect(animTimePinnedSeconds()).toBe(0.25)
    ;(globalThis as { __xgisAnimT?: number }).__xgisAnimT = 0.75
    expect(animTimePinnedSeconds()).toBe(0.75)
  })

  it('ignores a non-finite / non-number global (falls back to the live clock)', () => {
    ;(globalThis as { __xgisAnimT?: unknown }).__xgisAnimT = Number.NaN
    expect(animTimePinnedSeconds()).toBeNull()
    ;(globalThis as { __xgisAnimT?: unknown }).__xgisAnimT = 'nope'
    expect(animTimePinnedSeconds()).toBeNull()
  })
})
