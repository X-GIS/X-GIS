import { test, expect } from '@playwright/test'
import { captureMapFrame } from './helpers/visual'

// #2101 PREMISE GATE — `_wasIdle` is stale for one tick after a camera change.
//
// This pins the ENGINE fact that `awaitMapIdle`'s fix depends on; it does not
// exercise the helper itself, and is named accordingly. An end-to-end arm was
// tried and measured VACUOUS — see the note below — so calling it here would
// have added a passing assertion that distinguishes nothing.
//
// `_wasIdle` is recomputed once per rAF tick (map-event-bus.ts, driven from
// map.ts's renderLoop), so right after a camera change it still holds the
// PREVIOUS tick's answer. The helper used to read it once and return, so a
// spec that changed the camera and awaited idle measured the frame BEFORE its
// own change — silently, and in the helper `capture-canvas` mandates over
// `waitForTimeout`, so the vacuity spreads to every caller.
//
// Local fixture, zero network, SwiftShader-safe.

type W = {
  __xgisReady?: boolean
  __xgisMap?: {
    _eventBus?: { _wasIdle?: boolean }
    flyTo?: (o: { center?: [number, number]; zoom?: number; duration?: number }) => void
    getCamera?: () => { bearing: number }
    invalidate?: () => void
  }
  __xgisAwaitIdleStats?: { ticks: number; sawBusy: boolean; resolvedBy: string }
}

const boot = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto('/demo.html?id=minimal&e2e=1&forcegl2=1&adaptive=0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, {
    timeout: 60_000,
  })
  await captureMapFrame(page)
}

// ARM A — the PREMISE witness. If a future engine change starts clearing
// `_wasIdle` eagerly at the camera setters, the staleness this helper defends
// against is gone and Arm B below would pass for a new reason. This arm fails
// FIRST and names the dead premise, instead of the gate going quietly vacuous
// (the #996 / #2165 shape).
test('#2101 premise: `_wasIdle` is still stale for a tick after a camera change', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await boot(page)
  // Mutation and read in ONE evaluate — a CDP round-trip between them would let
  // a tick land and measure the engine's timing rather than the flag's staleness.
  const stillIdle = await page.evaluate(() => {
    const m = (window as unknown as W).__xgisMap!
    const before = m._eventBus?._wasIdle === true
    m.getCamera!().bearing += 30
    m.invalidate!()
    return { before, after: m._eventBus?._wasIdle === true }
  })
  expect(
    stillIdle.before,
    'the map must be idle before the mutation, or the arm proves nothing',
  ).toBe(true)
  expect(
    stillIdle.after,
    'the flag cleared synchronously — the staleness #2101 defends against is gone, so the ' +
      'freshness arm below is now passing for a different reason and must be re-derived',
  ).toBe(true)
})

// ARM B is DELIBERATELY ABSENT, and this is the record of why.
//
// An end-to-end arm was written and MEASURED VACUOUS: with the fix reverted to
// the one-shot stale read, it still passed. `awaitMapIdle` is itself a
// `page.evaluate`, so invoking it from Node always costs a CDP round-trip, and
// on this fixture a rAF tick (measured 31-60 ms) lands INSIDE that round-trip
// and refreshes the flag before the helper ever reads it. Measured on the same
// fixture: `staleTicksAfterMutation = 0` — the flag is stale only synchronously,
// which Arm A above is what actually pins.
//
// The defect is still real: it is reachable by any caller whose tick is slower
// than the round-trip, which is the regime this repo measures on heavy
// SwiftShader scenes (frames of ~1-2 s, per _adaptive-quality-ladder-gate).
// `minimal` is simply not in it.
//
// A non-vacuous end-to-end witness therefore needs either a fixture whose ticks
// are slower than a CDP round-trip, or the helper's decision logic extracted so
// vitest can construct the one-tick stale window deterministically. Both are
// larger than this fix; neither is done here. What is NOT acceptable is the
// arm that was tried, which passed with and without the fix.
