// ═══ #1664 — a per-feature colour that did not resolve REPORTS itself ═══
//
// The point / arrow paints resolve a data-driven `fill` / `stroke` on the CPU and hand the
// runtime a baked RGBA. When the expression cannot be evaluated they fall back to the layer
// constant, which for a data-driven colour is `null` by construction — so the dots paint
// fill_a = 0 and the arrows paint flat white. That fallback used to be entirely silent, and
// the shipped `coops-currents` style sat wrong on screen for the life of #1592 because of it.
//
// These drive the REAL `warnPerFeatureColorUnresolved` through its injected sink (the
// `stage-block-warning.test.ts` idiom) rather than mocking `xlog`, so what is pinned is the
// message the author actually receives — its layer name, its axis, and its issue number.
//
// What is NOT pinned here is which expressions still fail: that set is the compiler's
// (`point-fill-color-expr.test.ts` — `gradient()` and palette tokens now resolve,
// `categorical()` deliberately still throws), and restating it here would be a second
// authority that drifts.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  warnPerFeatureColorUnresolved,
  resetPerFeatureColorWarnings,
} from './per-feature-color-warning'

function collect(): { calls: string[]; sink: (msg: string) => void } {
  const calls: string[] = []
  return { calls, sink: (msg) => calls.push(msg) }
}

beforeEach(() => resetPerFeatureColorWarnings())

describe('warnPerFeatureColorUnresolved (#1664)', () => {
  it('names the layer, the axis and the issue when the evaluator THREW', () => {
    const { calls, sink } = collect()
    warnPerFeatureColorUnresolved(
      'stations',
      'fill',
      new Error("unknown function 'categorical'"),
      sink,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('stations')
    expect(calls[0]).toContain('fill')
    expect(calls[0]).toContain('#1664')
    // The thrown message is the single most diagnostic thing available — an author
    // who sees only "no colour" has to go find which callee was rejected.
    expect(calls[0]).toContain("unknown function 'categorical'")
  })

  it('reports the VALUE when the expression evaluated but not to a colour', () => {
    // The other failure mode, and the one that produced no signal at all: a
    // palette token read as arithmetic came back as the number -300, the caller's
    // `typeof r === 'string'` check rejected it, and nothing was said.
    const { calls, sink } = collect()
    warnPerFeatureColorUnresolved('stations', 'stroke', -300, sink)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('evaluated to -300')
    expect(calls[0]).toContain('stroke')
  })

  it('latches per layer: a 50k-feature source reports ONCE, not 50k times', () => {
    // The caller runs per FEATURE per scene rebuild. Unlatched, the message scrolls
    // itself away, which for the author it is written for is the same as silence.
    const { calls, sink } = collect()
    for (let i = 0; i < 5000; i++) warnPerFeatureColorUnresolved('stations', 'fill', null, sink)
    expect(calls).toHaveLength(1)
  })

  it('fill and stroke are independent keys — a layer failing both has two problems', () => {
    const { calls, sink } = collect()
    warnPerFeatureColorUnresolved('stations', 'fill', null, sink)
    warnPerFeatureColorUnresolved('stations', 'stroke', null, sink)
    expect(calls).toHaveLength(2)
  })

  it('two layers failing the same axis both report', () => {
    const { calls, sink } = collect()
    warnPerFeatureColorUnresolved('station_dots', 'fill', null, sink)
    warnPerFeatureColorUnresolved('arrows', 'fill', null, sink)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('station_dots')
    expect(calls[1]).toContain('arrows')
  })
})
