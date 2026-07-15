import { describe, it, expect } from 'vitest'
import { fn, module, f32, f32T, vec2, vec2fT, when, ifExpr, condExpr } from './index'
import { emitModule } from '../backends/wgsl'

describe('when — unified condition dispatch', () => {
  it('2-arm: emits an if/else chain (not select) and is byte-identical to the deprecated ifExpr', () => {
    const w = emitModule(
      module({
        funcs: [
          fn('f', { x: f32T }, vec2fT, ({ x }) =>
            when(
              x.lt(1),
              () => vec2(1, 0),
              () => vec2(0, 1),
            ),
          ),
        ],
      }),
    )
    expect(w).toContain('if')
    expect(w).not.toContain('select(')
    const old = emitModule(
      module({
        funcs: [
          fn('f', { x: f32T }, vec2fT, ({ x }) =>
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- this test's purpose is to prove `when` is byte-identical to the deprecated `ifExpr`; it must call `ifExpr` directly
            ifExpr(
              x.lt(1),
              () => vec2(1, 0),
              () => vec2(0, 1),
            ),
          ),
        ],
      }),
    )
    expect(w).toBe(old)
  })

  it('N-arm: byte-identical to the deprecated condExpr', () => {
    const w = emitModule(
      module({
        funcs: [
          fn('f', { x: f32T }, f32T, ({ x }) =>
            when(
              [
                [x.lt(0), () => f32(1)],
                [x.lt(1), () => f32(2)],
              ],
              () => f32(3),
            ),
          ),
        ],
      }),
    )
    const old = emitModule(
      module({
        funcs: [
          fn('f', { x: f32T }, f32T, ({ x }) =>
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- this test's purpose is to prove `when` is byte-identical to the deprecated `condExpr`; it must call `condExpr` directly
            condExpr(
              [
                [x.lt(0), () => f32(1)],
                [x.lt(1), () => f32(2)],
              ],
              () => f32(3),
            ),
          ),
        ],
      }),
    )
    expect(w).toBe(old)
    expect(w).toContain('else if')
  })
})
