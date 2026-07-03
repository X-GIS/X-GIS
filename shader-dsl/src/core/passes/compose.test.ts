import { describe, it, expect } from 'vitest'
import { composeModule } from './compose'
import { fn, module, f32, f32T, type Stmt } from '../ir'
import { emitModule } from '../backends/wgsl'

const ret = (v: number): Stmt => ({ s: 'return', expr: f32(v).expr })

describe('composeModule', () => {
  it('swaps a top-level placeholder with the swap Stmt list', () => {
    const base = module({
      funcs: [
        fn('f', {}, f32T, (_p, b) => {
          b.placeholder('ret')
        }),
      ],
    })
    const wgsl = emitModule(composeModule(base, { ret: [ret(42)] }))
    expect(wgsl).toContain('return 42')
    expect(wgsl).not.toContain('__placeholder')
  })

  it('descends into nested bodies (placeholder inside an If)', () => {
    const base = module({
      funcs: [
        fn(
          'f',
          { x: f32T },
          f32T,
          ({ x }, b) => {
            b.if(x.gt(0), (bb) => {
              bb.placeholder('hot')
            })
            b.ret(f32(0))
          },
          { allowEarlyReturn: true },
        ),
      ],
    })
    expect(emitModule(composeModule(base, { hot: [ret(7)] }))).toContain('return 7')
  })

  it('throws on a swap key that matches no placeholder (a typo)', () => {
    const base = module({
      funcs: [
        fn('f', {}, f32T, (_p, b) => {
          b.placeholder('ret')
        }),
      ],
    })
    expect(() => composeModule(base, { reto: [ret(1)] })).toThrow(/match no placeholder/)
  })

  it('throws on an un-swapped placeholder by default; allowUnswapped lets it survive', () => {
    const base = module({
      funcs: [
        fn(
          'f',
          {},
          f32T,
          (_p, b) => {
            b.placeholder('ret')
            b.ret(f32(0))
          },
          { allowEarlyReturn: true },
        ),
      ],
    })
    expect(() => composeModule(base, {})).toThrow(/un-swapped/)
    expect(emitModule(composeModule(base, {}, { allowUnswapped: true }))).toContain('__placeholder')
  })
})
