import { describe, it, expect } from 'vitest'
import { profileEmit } from './measure.js'
import { module, fn, f32, f32T, sin, cos } from './ir/index.js'

// #2449 — the profiler's own correctness. Timing values are wall-clock and machine-dependent,
// so NOTHING here asserts a duration: the assertions are structural (which stages ran, that the
// parts sum to the whole, that the instrumented optimizer produced the production module).
// A profiler whose parts do not add up to its total is measuring something other than the run.

const m = module({
  funcs: [
    fn('k', { x: f32T }, f32T, ({ x }, b) => {
      // Enough repeated subexpressions that the CSE family has real work to do.
      const a = b.let('a', sin(x).mul(cos(x)))
      const c = b.let('c', sin(x).mul(cos(x)))
      b.ret(
        a
          .add(c)
          .add(sin(x).mul(cos(x)))
          .add(f32(1)),
      )
    }),
  ],
})

describe('profileEmit', () => {
  it('reports every pre-emit stage, in pipeline order', () => {
    const p = profileEmit(m)
    expect(p.stages.map((s) => s.stage)).toEqual([
      'validate',
      'assertCaps',
      'assertBuiltins',
      'autoVars',
      'lowerModule',
      'fp64Lower',
      'spellExterns',
      'optimize',
    ])
    expect(p.target).toBe('wgsl')
  })

  it('the stages sum to the total — the parts add up to the whole', () => {
    const p = profileEmit(m)
    const sum = p.stages.reduce((a, s) => a + s.ms, 0)
    expect(Math.abs(sum - p.totalMs)).toBeLessThan(1e-9)
    for (const s of p.stages) expect(s.ms, `${s.stage} timed negative`).toBeGreaterThanOrEqual(0)
  })

  it('the pass breakdown covers the optimize stage and names the real passes', () => {
    const p = profileEmit(m)
    const optimize = p.stages.find((s) => s.stage === 'optimize')!
    const passSum = p.passes.reduce((a, x) => a + x.ms, 0)
    // The pass sum is the INNER time, so it cannot exceed the stage that contains it.
    expect(passSum).toBeLessThanOrEqual(optimize.ms + 1e-9)
    // The CSE family is what the D1.1 measurement found dominating; at minimum the pass names
    // must be real pass names rather than empty strings from an anonymous function.
    const names = p.passes.map((x) => x.pass)
    expect(names).toContain('cse')
    expect(names).toContain('gvn')
    expect(names.every((n) => n.length > 0)).toBe(true)
    // Every pass ran at least once per function per iteration.
    for (const x of p.passes) expect(x.runs).toBeGreaterThan(0)
  })

  it('is sorted heaviest first, so the reader sees the target', () => {
    const p = profileEmit(m)
    const ms = p.passes.map((x) => x.ms)
    expect([...ms].sort((a, b) => b - a)).toEqual(ms)
  })

  it('profiles the GLSL backend too', () => {
    const p = profileEmit(m, 'glsl-es300')
    expect(p.target).toBe('glsl-es300')
    expect(p.stages.map((s) => s.stage)).toContain('optimize')
  })

  // profileEmit swaps the backend's `optimize` for the same `fixpoint` carrying a sink, then
  // asserts the swap produced an irEqual module. That assertion is the reason the numbers can
  // be trusted as the production pipeline's rather than an adjacent one's.
  it('does not throw — the instrumented optimizer matches the production one', () => {
    expect(() => profileEmit(m)).not.toThrow()
    expect(() => profileEmit(m, 'glsl-es300')).not.toThrow()
  })
})
