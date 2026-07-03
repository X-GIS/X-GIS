import { describe, it, expect } from 'vitest'
import { lint } from './engine'
import { RULES } from './rules'
import { module, fn, callFn, f32T, f32, boolT } from '../../ir'
import type { LintConfig } from './engine'

const ruleIds = (m: ReturnType<typeof module>, cfg?: LintConfig) =>
  lint(m, RULES, cfg).map((d) => d.ruleId)

describe('lint rules — correctness checks + deviations', () => {
  it('no-recursion flags a direct self-call (WGSL has no recursion)', () => {
    const m = module({
      funcs: [fn('rec', { x: f32T }, f32T, ({ x }, _b) => callFn('rec', f32T, x))],
    })
    expect(ruleIds(m)).toContain('no-recursion')
  })

  it('no-unreachable-code flags a statement after a return in the same block', () => {
    const m = module({
      funcs: [
        fn(
          'dead',
          { x: f32T },
          f32T,
          ({ x }, b) => {
            b.if(x.gt(f32(0)), (c) => {
              c.ret(x)
              c.let('z', x.mul(2))
            }) // let after return = dead
            b.ret(f32(0))
          },
          { allowEarlyReturn: true },
        ), // deviate single-exit so only no-unreachable fires
      ],
    })
    expect(ruleIds(m)).toContain('no-unreachable-code')
  })

  it('lintDisable suppresses a rule for that fn (documented deviation)', () => {
    const m = module({
      funcs: [
        fn('rec', { x: f32T }, f32T, ({ x }, _b) => callFn('rec', f32T, x), {
          lintDisable: ['no-recursion'],
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-recursion')
  })

  it('a clean fn produces no diagnostics', () => {
    const m = module({ funcs: [fn('ok', { x: f32T }, f32T, ({ x }, _b) => x.mul(2))] })
    expect(ruleIds(m)).toEqual([])
  })

  it('no-float-eq flags exact float equality (warning)', () => {
    const m = module({ funcs: [fn('cmp', { x: f32T }, boolT, ({ x }, _b) => x.eq(f32(0)))] })
    expect(ruleIds(m)).toContain('no-float-eq')
  })

  it('cyclomatic-complexity fires past the configured threshold', () => {
    const m = module({
      funcs: [
        fn('branchy', { x: f32T }, f32T, ({ x }, b) => {
          b.if(x.gt(f32(0)), () => {})
          b.if(x.lt(f32(0)), () => {})
          b.ret(x)
        }),
      ],
    })
    expect(ruleIds(m, { options: { 'cyclomatic-complexity': { max: 1 } } })).toContain(
      'cyclomatic-complexity',
    )
    expect(ruleIds(m, { options: { 'cyclomatic-complexity': { max: 99 } } })).not.toContain(
      'cyclomatic-complexity',
    )
  })

  it('param-count fires past the configured threshold', () => {
    const m = module({ funcs: [fn('wide', { a: f32T, b: f32T, c: f32T }, f32T, ({ a }, _b) => a)] })
    expect(ruleIds(m, { options: { 'param-count': { max: 2 } } })).toContain('param-count')
    expect(ruleIds(m, { options: { 'param-count': { max: 6 } } })).not.toContain('param-count')
  })

  it('naming-convention flags a non-snake_case fn name', () => {
    const m = module({ funcs: [fn('fooBar', { x: f32T }, f32T, ({ x }, _b) => x)] })
    expect(ruleIds(m)).toContain('naming-convention')
  })

  it('max-nesting-depth fires past the configured threshold', () => {
    const m = module({
      funcs: [
        fn('nested', { x: f32T }, f32T, ({ x }, b) => {
          b.if(x.gt(f32(0)), (c) => {
            c.if(x.lt(f32(1)), () => {})
          }) // depth 2
          b.ret(x)
        }),
      ],
    })
    expect(ruleIds(m, { options: { 'max-nesting-depth': { max: 1 } } })).toContain(
      'max-nesting-depth',
    )
    expect(ruleIds(m, { options: { 'max-nesting-depth': { max: 9 } } })).not.toContain(
      'max-nesting-depth',
    )
  })
})
