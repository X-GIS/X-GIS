import { describe, it, expect } from 'vitest'
import { coverageDrapeArm } from './coverage-drape-arm'

// When a coverage draws its drape (#1333).
//
// The rule this replaced welded the MOTION to the non-standard colour fill: any field keyword
// without a `ramp` skipped the drape entirely. Since a strictly S-111-conformant style declares
// no ramp (the catalogue defines point symbols and nothing else), that made "catalogue arrows
// PLUS motion" unreachable — you had to accept a non-catalogue colour area to get the
// animation. Backwards: the animation is the optional extra, not the colour scale.

describe('coverage drape arming (#1333)', () => {
  it('THE STRICT CATALOGUE CASE: `| arrow` with no ramp draws NO drape', () => {
    // The one case that draws nothing. The catalogue is coloured symbols at grid points; a
    // colour area under them would be an addition it does not define.
    expect(coverageDrapeArm({ isArrow: true })).toEqual({ draw: false })
  })

  it('THE FIX: `| flow` with no ramp DOES draw, flow-only', () => {
    // Without this the motion layer is unreachable from a conformant style — the whole point.
    expect(coverageDrapeArm({ isFlow: true })).toEqual({ draw: true, flowOnly: true })
  })

  it('`| arrow | flow` with no ramp draws flow-only — arrows stay the colour authority', () => {
    // The composed case the live demo uses: static catalogue arrows over a neutral motion
    // texture. `flowOnly` must survive the presence of the arrow marker, or the drape would
    // fall back to a colour ramp nobody asked for.
    expect(coverageDrapeArm({ isArrow: true, isFlow: true })).toEqual({
      draw: true,
      flowOnly: true,
    })
  })

  it('a declared ramp is the explicit opt-in to the colour fill, and it WINS', () => {
    // Declaring a ramp says "I want the non-standard colour area". It then composes under
    // whatever field layers run, so flowOnly must be false even with `| flow` present —
    // otherwise asking for a ramp would silently discard it.
    for (const show of [
      { ramp: 's111-speed' },
      { ramp: 's111-speed', isArrow: true },
      { ramp: 's111-speed', isFlow: true },
      { ramp: 's111-speed', isArrow: true, isFlow: true },
    ]) {
      expect(coverageDrapeArm(show), JSON.stringify(show)).toEqual({
        draw: true,
        flowOnly: false,
      })
    }
  })

  it('a bare coverage is unchanged — it still draws its fill', () => {
    // Every pre-#1333 coverage layer. If this regressed, an S-102 bathymetry map would go
    // blank, which is a far louder failure than anything else here — and it is exactly what a
    // careless "skip the drape unless ramped" rule would cause.
    expect(coverageDrapeArm({})).toEqual({ draw: true, flowOnly: false })
  })

  it('the decision reads ONLY the three paint axes — no hidden state', () => {
    // It is a pure function of the show, which is why both arm sites (the layer rebuild and
    // the transient forecast-hour re-arm) can share it and cannot drift apart.
    const show = { isArrow: true, isFlow: true, ramp: undefined }
    expect(coverageDrapeArm(show)).toEqual(coverageDrapeArm({ ...show }))
  })
})
