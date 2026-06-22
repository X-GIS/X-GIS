import { describe, it, expect } from 'vitest'
import { lint, applyFixes } from '../engine'
import { module, fn, f32T, f32 } from '../../../ir'
import { noSelfAssign } from './no-self-assign'

const ruleIds = (m: ReturnType<typeof module>) => lint(m, [noSelfAssign]).map((d) => d.ruleId)

describe('no-self-assign', () => {
  it('flags a self-assignment (v = v)', () => {
    const m = module({
      funcs: [
        fn('selfassign', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.var('v', f32T, f32(0))
          b.assign(v, v) // self-assign = no-op, likely typo
          b.ret(x)
        }),
      ],
    })
    expect(ruleIds(m)).toContain('no-self-assign')
  })

  it('does not flag a normal assignment', () => {
    const m = module({
      funcs: [
        fn('ok', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.var('v', f32T, f32(0))
          b.assign(v, x) // distinct target/value
          b.ret(v)
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-self-assign')
  })

  it('auto-fix deletes the no-op self-assignment', () => {
    const m = module({
      funcs: [fn('selfassign', { x: f32T }, f32T, ({ x }, b) => {
        const v = b.var('v', f32T, f32(0))
        b.assign(v, v)
        b.ret(x)
      })],
    })
    expect(ruleIds(m)).toContain('no-self-assign') // before
    const { module: fixed, applied } = applyFixes(m, [noSelfAssign])
    expect(applied).toContain('no-self-assign')
    expect(ruleIds(fixed)).toEqual([]) // self-assign stmt removed
  })
})
