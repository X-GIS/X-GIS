import { describe, it, expect } from 'vitest'
import { madd, outsideRange, insideRange, param, f32T } from './index'
import { emitExpr } from '../backends/wgsl'

// Readability killer #2 — composite arithmetic helpers. The arithmetic chains C2
// can't touch (no JS infix) read worst as guards/fma: `arc.lt(lo).or(arc.gt(hi))`,
// `k.mul(s).add(start)`. These helpers name the pattern; they are pure builder-call
// compositions, so the emitted IR is BYTE-IDENTICAL to the manual chain.
const x = param('x', f32T)
const lo = param('lo', f32T)
const hi = param('hi', f32T)
const m = param('m', f32T)
const a = param('a', f32T)

describe('ir — composite arithmetic sugar (#2)', () => {
  it('madd(a, b, c) emits identically to a.mul(b).add(c)', () => {
    expect(emitExpr(madd(x, m, a).expr)).toBe(emitExpr(x.mul(m).add(a).expr))
  })

  it('outsideRange(x, lo, hi) emits identically to x.lt(lo).or(x.gt(hi))', () => {
    expect(emitExpr(outsideRange(x, lo, hi).expr)).toBe(emitExpr(x.lt(lo).or(x.gt(hi)).expr))
  })

  it('insideRange(x, lo, hi) emits identically to x.ge(lo).and(x.le(hi))', () => {
    expect(emitExpr(insideRange(x, lo, hi).expr)).toBe(emitExpr(x.ge(lo).and(x.le(hi)).expr))
  })
})
