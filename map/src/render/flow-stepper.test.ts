import { describe, it, expect } from 'vitest'
import { FlowStepper, FLOW_STEP_DEFAULTS } from './flow-stepper'

// Advection step SEQUENCING (#1333). Every gate here is about ORDER, because a recursive
// filter sequenced wrongly still animates — it just animates something wrong, which is exactly
// what a GPU-less environment cannot catch by looking.

interface Tex {
  __id: number
}

function makeRhi() {
  let id = 0
  const rhi = {
    createTexture: () => ({ __id: id++ }) as Tex,
    createView: (t: Tex) => ({ __view: t.__id }),
    destroyTexture: () => {},
  }
  return rhi as never
}

const FIELD = { width: 8, height: 8, spanDeg: [2, 2] as const, midLatDeg: 40 }
const DT = 1 / 60

describe('FlowStepper — advection sequencing (#1333)', () => {
  it('reads and writes DIFFERENT textures — never samples the attachment it writes', () => {
    // A sampler reading its own colour attachment is undefined behaviour on both backends.
    const s = new FlowStepper()
    const d = s.step(makeRhi(), FIELD, DT, false)!
    expect(d.read).not.toEqual(d.write)
  })

  it('THE CLEAR GATE: demanded on the FIRST step only, and consumed so it cannot fire twice', () => {
    // Undefined texture contents are not overwritten by a recursive filter — they are fed on,
    // so they persist in the history indefinitely. Clearing EVERY frame is the opposite
    // failure: the trail would never accumulate.
    const s = new FlowStepper()
    const rhi = makeRhi()
    expect(s.step(rhi, FIELD, DT, false)!.clearFirst).toBe(true)
    expect(s.step(rhi, FIELD, DT, false)!.clearFirst).toBe(false)
    expect(s.step(rhi, FIELD, DT, false)!.clearFirst).toBe(false)
  })

  it('a grid CHANGE re-arms the clear — the new pair is unclean too', () => {
    const s = new FlowStepper()
    const rhi = makeRhi()
    s.step(rhi, FIELD, DT, false)
    expect(s.step(rhi, FIELD, DT, false)!.clearFirst).toBe(false)
    const bigger = { ...FIELD, width: 16, height: 16 }
    expect(s.step(rhi, bigger, DT, false)!.clearFirst).toBe(true)
  })

  it('THE SWAP GATE: this step WRITES what the next step READS', () => {
    // Swapping before the draw would advect into the history and read the stale target —
    // silently halving the effective frame rate and doubling the trail length.
    const s = new FlowStepper()
    const rhi = makeRhi()
    const a = s.step(rhi, FIELD, DT, false)!
    const b = s.step(rhi, FIELD, DT, false)!
    expect(b.read).toEqual(a.write) // the history is what we just produced
    expect(b.write).toEqual(a.read) // and the old history is now the target
    const c = s.step(rhi, FIELD, DT, false)!
    expect(c.read).toEqual(b.write)
  })

  it('currentView is the image the LAST step produced — what the drape samples', () => {
    const s = new FlowStepper()
    const rhi = makeRhi()
    expect(s.currentView).toBeNull() // nothing advected yet
    const a = s.step(rhi, FIELD, DT, false)!
    expect(s.currentView).toEqual(a.write)
    const b = s.step(rhi, FIELD, DT, false)!
    expect(s.currentView).toEqual(b.write)
  })

  it('the noise phase advances per STEP, not per wall-clock second', () => {
    // A dropped frame must not jump the noise pattern: the history was not advected across
    // that gap either, so jumping would tear the trail.
    const s = new FlowStepper()
    const rhi = makeRhi()
    const p1 = s.step(rhi, FIELD, DT, false)!.noisePhase
    const p2 = s.step(rhi, FIELD, DT, false)!.noisePhase
    expect(p2).toBe(p1 + 1)
    // A far larger dt still advances the phase by exactly one — it is a step counter.
    const p3 = s.step(rhi, FIELD, 5, false)!.noisePhase
    expect(p3).toBe(p2 + 1)
  })

  it('a degenerate field yields NO step rather than a zero-sized draw', () => {
    const s = new FlowStepper()
    const rhi = makeRhi()
    expect(s.step(rhi, { ...FIELD, width: 0 }, DT, false)).toBeNull()
    expect(s.step(rhi, { ...FIELD, height: -1 }, DT, false)).toBeNull()
  })

  it('threads the float-target capability through to the pair', () => {
    // The fallback lives in FlowTargets; this asserts the stepper does not swallow the flag.
    const s = new FlowStepper()
    s.step(makeRhi(), FIELD, DT, true)
    expect(s.targets.storageFormat).toBe('r16float')
    const s2 = new FlowStepper()
    s2.step(makeRhi(), FIELD, DT, false)
    expect(s2.targets.storageFormat).toBe('rgba8unorm')
  })

  it('carries the display options into the params (defaults are NOT tuned)', () => {
    const s = new FlowStepper()
    const d = s.step(makeRhi(), FIELD, DT, false, {
      ratePerSec: 0.5,
      decay: 0.9,
      inject: 0.2,
    })!
    expect(d.params.decay).toBe(0.9)
    expect(d.params.inject).toBe(0.2)
    // The default rate is a principled placeholder, not a verified look — see the design's
    // pending real-GPU gate. Asserted only to pin that a default EXISTS and is sane.
    expect(FLOW_STEP_DEFAULTS.ratePerSec).toBeGreaterThan(0)
    expect(FLOW_STEP_DEFAULTS.decay).toBeLessThan(1)
  })

  it('destroy() frees the pair and re-arms the clear for a later restart', () => {
    const s = new FlowStepper()
    const rhi = makeRhi()
    s.step(rhi, FIELD, DT, false)
    s.destroy()
    expect(s.currentView).toBeNull()
    expect(s.step(rhi, FIELD, DT, false)!.clearFirst).toBe(true)
  })
})
