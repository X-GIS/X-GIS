import { describe, it, expect } from 'vitest'
import { checkSingleExit } from './single-exit'
import { fn, If, Return, ReturnIf, select, f32, f32T } from '../ir'

describe('checkSingleExit — MISRA-style single point of exit', () => {
  it('passes a single-exit fn (one return, at the end)', () => {
    const f = fn('ok', { x: f32T }, f32T, (_b, { x }) => x.mul(2))
    expect(checkSingleExit(f)).toEqual([])
  })

  it('passes a select-based single-exit refactor of a guard', () => {
    const f = fn('ok2', { x: f32T }, f32T, (_b, { x }) => select(x.lt(f32(0)), x.neg(), x))
    expect(checkSingleExit(f)).toEqual([])
  })

  it('flags an early return (ReturnIf guard)', () => {
    const f = fn('bad', { x: f32T }, f32T, (_b, { x }) => {
      ReturnIf(x.lt(f32(0)), x.neg())
      return x
    })
    expect(checkSingleExit(f).length).toBeGreaterThan(0)
  })

  it('flags multiple returns in branches', () => {
    const f = fn('bad2', { x: f32T }, f32T, (_b, { x }) => {
      If(x.gt(f32(0)), () => Return(x)).else(() => Return(x.neg()))
    })
    expect(checkSingleExit(f).length).toBeGreaterThan(0)
  })
})
