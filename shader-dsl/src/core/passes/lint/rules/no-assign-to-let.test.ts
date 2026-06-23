import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import { module, fn, f32T, f32, vec2fT, vec2 } from '../../../ir'
import { noAssignToLet } from './no-assign-to-let'

const ruleIds = (m: ReturnType<typeof module>) => lint(m, [noAssignToLet]).map((d) => d.ruleId)

describe('no-assign-to-let', () => {
  it('flags assigning to a let-bound binding (let x = …; x = …)', () => {
    const m = module({
      funcs: [
        fn('assignlet', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', f32(0)) // immutable
          b.assign(v, x) // invalid WGSL: assigning to a let
          b.ret(v)
        }),
      ],
    })
    expect(ruleIds(m)).toContain('no-assign-to-let')
  })

  it('does not flag assigning to a var-bound binding', () => {
    const m = module({
      funcs: [
        fn('assignvar', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.var('v', f32T, f32(0)) // mutable
          b.assign(v, x)
          b.ret(v)
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-assign-to-let')
  })

  it('does not flag the auto-var pattern (assign target is a raw expr, not a varref)', () => {
    const m = module({
      funcs: [
        fn('autovar', { x: f32T }, f32T, ({ x }, b) => {
          const y = x.add(f32(1)) // a plain value, materialised into a var by autoVars
          b.assign(y, x)
          b.ret(y)
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-assign-to-let')
  })

  it('flags a member-assign whose root is a let (let v; v.x = …)', () => {
    const m = module({
      funcs: [
        fn('assignletfield', { x: f32T }, vec2fT, ({ x }, b) => {
          const v = b.let('v', vec2(f32(0), f32(0)))
          b.assign(v.x, x) // mutating a component of an immutable let
          b.ret(v)
        }),
      ],
    })
    expect(ruleIds(m)).toContain('no-assign-to-let')
  })

  it('does not flag a member-assign whose root is a var', () => {
    const m = module({
      funcs: [
        fn('assignvarfield', { x: f32T }, vec2fT, ({ x }, b) => {
          const v = b.var('v', vec2fT, vec2(f32(0), f32(0)))
          b.assign(v.x, x)
          b.ret(v)
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-assign-to-let')
  })
})
