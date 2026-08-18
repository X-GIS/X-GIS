import { describe, it, expect } from 'vitest'
import { lint } from '../engine.js'
import { module, fn, f32T, voidT } from '../../../ir/index.js'
import { noEmptyFunction } from './no-empty-function.js'

const ruleIds = (m: ReturnType<typeof module>) => lint(m, [noEmptyFunction]).map((d) => d.ruleId)

describe('no-empty-function', () => {
  it('fires for a void fn with an empty body', () => {
    const m = module({ funcs: [fn('empty', {}, voidT, () => {})] })
    expect(ruleIds(m)).toContain('no-empty-function')
  })

  it('is silent for a fn with a body', () => {
    const m = module({ funcs: [fn('ok', { x: f32T }, f32T, ({ x }, _b) => x.mul(2))] })
    expect(ruleIds(m)).toEqual([])
  })
})
