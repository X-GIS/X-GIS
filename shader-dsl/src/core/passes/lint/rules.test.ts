import { describe, it, expect } from 'vitest'
import { lint } from './engine'
import { RULES } from './rules'
import { module, fn, callFn, f32T, f32 } from '../../ir'

const ruleIds = (m: ReturnType<typeof module>) => lint(m, RULES).map((d) => d.ruleId)

describe('lint rules — correctness checks + deviations', () => {
  it('no-recursion flags a direct self-call (WGSL has no recursion)', () => {
    const m = module({ funcs: [fn('rec', { x: f32T }, f32T, (_b, { x }) => callFn('rec', f32T, x))] })
    expect(ruleIds(m)).toContain('no-recursion')
  })

  it('no-unreachable-code flags a statement after a return in the same block', () => {
    const m = module({
      funcs: [
        fn('dead', { x: f32T }, f32T, (b, { x }) => {
          b.if(x.gt(f32(0)), (c) => { c.ret(x); c.let('z', x.mul(2)) }) // let after return = dead
          b.ret(f32(0))
        }, { allowEarlyReturn: true }), // deviate single-exit so only no-unreachable fires
      ],
    })
    expect(ruleIds(m)).toContain('no-unreachable-code')
  })

  it('lintDisable suppresses a rule for that fn (documented deviation)', () => {
    const m = module({
      funcs: [fn('rec', { x: f32T }, f32T, (_b, { x }) => callFn('rec', f32T, x), { lintDisable: ['no-recursion'] })],
    })
    expect(ruleIds(m)).not.toContain('no-recursion')
  })

  it('a clean fn produces no diagnostics', () => {
    const m = module({ funcs: [fn('ok', { x: f32T }, f32T, (_b, { x }) => x.mul(2))] })
    expect(ruleIds(m)).toEqual([])
  })
})
