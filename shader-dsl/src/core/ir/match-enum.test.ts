import { describe, it, expect } from 'vitest'
import { enumU32, matchEnum, matchExpr, fn, module, f32, f32T, u32T } from './index'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'

const Kind = enumU32({ Line: 0, Fill: 1, Stroke: 2 })

// ── Type-level exhaustiveness probe ──
// Never executed; `tsc -p shader-dsl` validates the @ts-expect-error: matchEnum's arms object is a
// mapped type over the enum's keys, so omitting a member is a compile error (the whole point).
function _exhaustivenessProbe(): void {
  fn('full', { k: u32T }, f32T, ({ k }) =>
    matchEnum(k, Kind, { Line: () => f32(1), Fill: () => f32(2), Stroke: () => f32(3) }),
  )

  fn('partial', { k: u32T }, f32T, ({ k }) =>
    // @ts-expect-error — missing the `Stroke` arm: a non-exhaustive dispatch is a compile error.
    matchEnum(k, Kind, { Line: () => f32(1), Fill: () => f32(2) }),
  )
}
void _exhaustivenessProbe

describe('enumU32 / matchEnum', () => {
  it('members are u32 literals of the declared values', () => {
    expect(Kind.members.Line.expr).toEqual({ op: 'lit', type: u32T, value: 0 })
    expect(Kind.members.Fill.expr).toEqual({ op: 'lit', type: u32T, value: 1 })
    expect(Kind.values).toEqual({ Line: 0, Fill: 1, Stroke: 2 })
  })

  it('lowers byte-identically to the equivalent hand-written matchExpr', () => {
    const viaEnum = module({
      funcs: [
        fn('m', { k: u32T }, f32T, ({ k }) =>
          matchEnum(k, Kind, { Line: () => f32(1), Fill: () => f32(2), Stroke: () => f32(3) }),
        ),
      ],
    })
    // matchEnum makes the LAST member (Stroke) the switch default → cases [0,1], default 3.
    const viaMatch = module({
      funcs: [
        fn('m', { k: u32T }, f32T, ({ k }) =>
          matchExpr(
            k,
            [
              [0, f32(1)],
              [1, f32(2)],
            ],
            f32(3),
          ),
        ),
      ],
    })
    expect(emitModule(viaEnum)).toBe(emitModule(viaMatch))
  })

  it('the CPU oracle dispatches each member to its arm', () => {
    const m = module({
      funcs: [
        fn('m', { k: u32T }, f32T, ({ k }) =>
          matchEnum(k, Kind, { Line: () => f32(10), Fill: () => f32(20), Stroke: () => f32(30) }),
        ),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.m(0)).toBe(10)
    expect(cpu.fns.m(1)).toBe(20)
    expect(cpu.fns.m(2)).toBe(30)
  })
})
