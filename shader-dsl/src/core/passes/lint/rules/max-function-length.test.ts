import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import { module, fn, f32T, f32 } from '../../../ir'
import { maxFunctionLength } from './max-function-length'

const ruleIds = (m: ReturnType<typeof module>, max?: number) =>
  lint(m, [maxFunctionLength], max === undefined ? undefined : { options: { 'max-function-length': { max } } }).map(
    (d) => d.ruleId,
  )

describe('max-function-length', () => {
  // body has a let, an if whose arm/else hold nested statements, and a final return —
  // the nested ones only count if the helper recurses into if/for/switch bodies.
  const m = module({
    funcs: [
      fn('busy', { x: f32T }, f32T, (b, { x }) => {
        b.let('y', x.mul(2)) // 1
        b.if(x.gt(f32(0)), (c) => { c.let('z', x.add(1)) }) // if = 1; then-arm let = 1 (needs recursion)
          .else((e) => { e.let('w', x.sub(1)) }) // else let = 1 (needs recursion)
        b.ret(x) // 1
      }),
    ],
  })

  it('fires when statement count exceeds the configured max', () => {
    expect(ruleIds(m, 1)).toContain('max-function-length')
  })

  it('stays silent under a high max', () => {
    expect(ruleIds(m, 99)).not.toContain('max-function-length')
  })

  it('a tiny clean fn is silent at the default threshold', () => {
    const ok = module({ funcs: [fn('ok', { x: f32T }, f32T, (_b, { x }) => x.mul(2))] })
    expect(ruleIds(ok)).toEqual([])
  })
})
