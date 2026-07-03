import { describe, it, expect } from 'vitest'
import { fn, condExpr, ifExpr, f32, f32T } from './index'
import { emitFunc } from '../backends/wgsl'

// Regression gate for the condExpr/ifExpr arm-routing bug (introduced by 6017f125,
// "infer combinator/Var types"). The combinators capture `const b = currentBuilder()`
// at the TOP (the PARENT builder) and the arm closure called `b.assign(...)` — but the
// if/elif/else arm BODIES are collected from a CHILD scope (subBody). So every arm's
// assignment landed UNCONDITIONALLY in the parent (author order, last-write-wins) and
// the if-arms came out EMPTY:
//
//   var _v; _v = arm0; if (c0) {} else if (c1) {} else {}; _v = arm1; _v = armElse;
//
// → every projType position branch (point/heatmap/line/raster vs_*) silently collapsed
// to its LAST arm (the globe/ECEF position), so on a flat view points rendered at
// globe coords (offscreen) and heatmap splats sat at globe positions (#583, #584).
//
// The fix routes the arm assignment through the Node lvalue method `.assign()` (the
// ambient sink → currentBuilder() at call time → the active CHILD scope), so the
// assignments land INSIDE the arms. These tests pin the populated-arm shape so the
// regression cannot silently return (no existing golden asserted it — the gap that let
// it ship).

describe('condExpr / ifExpr — arm assignments land INSIDE the branches', () => {
  it('condExpr emits the assignment inside each if/elif/else arm (not empty arms)', () => {
    const pick = fn('pick3', { sel: f32T }, f32T, ({ sel }) => {
      return condExpr(
        [
          [sel.lt(f32(0.5)), () => f32(10)],
          [sel.lt(f32(6.5)), () => f32(20)],
        ],
        () => f32(30),
      )
    })
    const wgsl = emitFunc(pick)

    // Each arm body holds its own assignment — `{ _vN = <val>; } else if … else { … }`.
    // With the bug the arms were EMPTY (`{ } else if { } else { }`) and the assigns were
    // hoisted unconditionally outside.
    expect(wgsl).toMatch(/\{\s*_v\d+ = 10\.0;\s*\} else if/s)
    expect(wgsl).toMatch(/\{\s*_v\d+ = 20\.0;\s*\} else \{/s)
    expect(wgsl).toMatch(/else \{\s*_v\d+ = 30\.0;\s*\}/s)
    // The empty-then-before-else shape must be ABSENT.
    expect(wgsl).not.toMatch(/\)\s*\{\s*\}\s*else/)
  })

  it('ifExpr emits then/else assignments inside the branches (not empty arms)', () => {
    const pick = fn('pick2', { sel: f32T }, f32T, ({ sel }) => {
      return ifExpr(
        sel.lt(f32(0.5)),
        () => f32(11),
        () => f32(22),
      )
    })
    const wgsl = emitFunc(pick)
    expect(wgsl).toMatch(/\{\s*_v\d+ = 11\.0;\s*\} else \{/s)
    expect(wgsl).toMatch(/else \{\s*_v\d+ = 22\.0;\s*\}/s)
    expect(wgsl).not.toMatch(/\)\s*\{\s*\}\s*else/)
  })
})
