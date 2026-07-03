import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import { module, fn, f32T } from '../../../ir'
import { noDeadBinding } from './no-dead-binding'

const ruleIds = (m: ReturnType<typeof module>) => lint(m, [noDeadBinding]).map((d) => d.ruleId)

describe('no-dead-binding', () => {
  it('flags a `let` that is never referenced (binding the value but returning something else)', () => {
    const m = module({
      funcs: [
        fn('dead', { x: f32T }, f32T, ({ x }, b) => {
          const _dead = b.let('dead', x.mul(2)) // bound at WGSL level but never used
          void _dead
          b.ret(x) // returns x, not the `dead` binding
        }),
      ],
    })
    expect(ruleIds(m)).toContain('no-dead-binding')
  })

  it('does not flag a `let` that IS referenced', () => {
    const m = module({
      funcs: [
        fn('alive', { x: f32T }, f32T, ({ x }, b) => {
          const t = b.let('t', x.mul(2))
          b.ret(t.add(1)) // references the `t` binding → varref('t')
        }),
      ],
    })
    expect(ruleIds(m)).not.toContain('no-dead-binding')
  })
})
