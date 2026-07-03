import { describe, it, expect } from 'vitest'
import { Let, Var, param, fn, module, f32, f32T } from './index'
import { emitModule } from '../backends/wgsl'

// ── Type-level probes ──
// Never executed (the function is only referenced, not called) — `tsc -p shader-dsl` validates
// each `@ts-expect-error`: the directive PASSES only if the line below is genuinely a type error.
// This is the gate that proves the no-assign-to-let footgun is caught by the compiler (not just
// the lint rule): Let()/param() return the read-only `ReadonlyNode`, which has no `.assign`.
function _mutabilityProbes(): void {
  const v = Var(f32T, f32(0))
  v.assign(f32(1)) // OK — Var() is mutable (Node)

  const l = Let(f32(0))
  // @ts-expect-error — Let() returns ReadonlyNode; assigning to an immutable binding is a compile error.
  l.assign(f32(1))

  const p = param('x', f32T)
  // @ts-expect-error — a function param is read-only; assigning to it is a compile error.
  p.assign(f32(1))
}
void _mutabilityProbes

describe('mutable-node type safety', () => {
  it('Var() mutation still emits a WGSL var + store (behaviour unchanged)', () => {
    const m = module({
      funcs: [
        fn('m', { x: f32T }, f32T, ({ x }) => {
          const acc = Var(f32(0))
          acc.assign(acc.add(x))
          return acc
        }),
      ],
    })
    expect(emitModule(m)).toContain('var')
  })

  it('the auto-var sugar (plain const + .assign) still type-checks and emits', () => {
    const m = module({
      funcs: [
        fn('av', { x: f32T }, f32T, ({ x }) => {
          const acc = f32(0) // plain value Node (Node, mutable) → auto-var materialises a var
          acc.assign(acc.add(x))
          return acc
        }),
      ],
    })
    expect(emitModule(m)).toContain('var')
  })
})
