import { describe, it, expect } from 'vitest'
import { lint, applyFixes } from '../engine'
import { module, fn, f32T, f32 } from '../../../ir'
import { emitFunc } from '../../../backends/wgsl'
import { preferLetOverVar } from './prefer-let-over-var'

const ids = (m: ReturnType<typeof module>) => lint(m, [preferLetOverVar]).map((d) => d.ruleId)

describe('prefer-let-over-var', () => {
  it('flags a var that is declared, never reassigned, and just returned', () => {
    const m = module({
      funcs: [fn('only_var', { x: f32T }, f32T, (b, { x }) => {
        const v = b.var('v', f32T, f32(0))
        b.ret(v.add(x))
      }, { allowEarlyReturn: true })],
    })
    expect(ids(m)).toContain('prefer-let-over-var')
  })

  it('does not flag a var that IS reassigned', () => {
    const m = module({
      funcs: [fn('reassigned', { x: f32T }, f32T, (b, { x }) => {
        const v = b.var('v', f32T, f32(0))
        b.assign(v, x)
        b.ret(v)
      }, { allowEarlyReturn: true })],
    })
    expect(ids(m)).not.toContain('prefer-let-over-var')
  })

  it('a clean fn with no var declarations is silent', () => {
    const m = module({ funcs: [fn('clean', { x: f32T }, f32T, (_b, { x }) => x.mul(2))] })
    expect(ids(m)).toEqual([])
  })

  it('auto-fix rewrites a never-reassigned var to a let', () => {
    const m = module({
      funcs: [fn('only_var', { x: f32T }, f32T, (b, { x }) => {
        const v = b.var('v', f32T, f32(0))
        b.ret(v.add(x))
      }, { allowEarlyReturn: true })],
    })
    expect(ids(m)).toContain('prefer-let-over-var') // before
    const { module: fixed, applied } = applyFixes(m, [preferLetOverVar])
    expect(applied).toContain('prefer-let-over-var')
    expect(ids(fixed)).toEqual([]) // after: clean
    expect(emitFunc(fixed.funcs[0])).toContain('let v') // var → let in the emit
    expect(emitFunc(fixed.funcs[0])).not.toContain('var v')
  })
})
