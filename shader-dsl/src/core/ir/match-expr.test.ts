// ═══ matchExpr IR primitive — Phase 2.5 US-001 ═══
//
// Covers the AC2 enumeration from the polygon-shader-dsl-phase-2-5 plan:
//   1. i32 scrutinee → Stmt.switch + var-slot emit
//   2. u32 scrutinee → u32 case labels
//   3. f32 scrutinee → i32() cast on the switch scrut
//   4. >=10-arm match → Stmt.switch lowering (the matchExpr perf gate)
//   5. cpu eval round-trip picks correct case + default
//   6. lowering choice is deterministic and observable
//   7. tsc rejects case-type mismatch (`@ts-expect-error` probe)
//   8. matchExpr inside Stmt.for body → hoist scoped to loop body
//   9. matchExpr inside Stmt.if arm → hoist scoped to arm body
//  10. nested matchExpr depth-2 → both lowered, deepest first
//  11. emitModule defensive throw if matchExpr leaks past the lowerer

import { describe, it, expect } from 'vitest'
import { matchExpr, f32, i32, u32, vec4, type Node } from './node'
import type { Expr, Stmt, FuncDecl, ModuleDecl } from './nodes'
import { f32T, i32T, u32T, vec4fT } from './types'
import { emitModule } from '../backends/wgsl'
import { lowerModule } from '../passes/match-lower'
import { compileModule } from '../oracle'

// ── Helpers — build IR fragments without the Builder (so tests stay
// explicit about the Stmt/Expr shape each one asserts). ────────────────

const scrutI32: Expr = { op: 'param', type: i32T, name: 's' }
const scrutU32: Expr = { op: 'param', type: u32T, name: 's' }
const scrutF32: Expr = { op: 'param', type: f32T, name: 's' }

function returnStmt(e: Expr): Stmt {
  return { s: 'return', expr: e }
}

function moduleFromBody(name: string, paramType: typeof f32T | typeof i32T | typeof u32T, retType: typeof i32T | typeof vec4fT, body: Stmt[]): ModuleDecl {
  const fn: FuncDecl = {
    name,
    params: [{ name: 's', type: paramType }],
    ret: retType,
    body,
  }
  return { consts: [], structs: [], bindings: [], funcs: [fn] }
}

// ── Lowering shape assertions (observable + deterministic) ─────────────

describe('matchExpr — IR construction', () => {
  it('builds an Expr with op=matchExpr, type from default, deterministic case ordering', () => {
    const e = matchExpr(
      i32(0) as Node<'i32'>,
      [[0, i32(10)], [1, i32(20)], [2, i32(30)]],
      i32(99),
    )
    expect(e.expr.op).toBe('matchExpr')
    expect(e.expr.type.kind).toBe('scalar')
    if (e.expr.op === 'matchExpr') {
      expect(e.expr.cases.length).toBe(3)
      expect(e.expr.cases[0]![0]).toBe(0)
      expect(e.expr.cases[2]![0]).toBe(2)
      expect((e.expr.default as { op: string }).op).toBe('lit')
    }
  })

  it('throws on case type mismatch vs default (runtime)', () => {
    expect(() => {
      // i32 case value with a vec4f default — incompatible Node types.
      matchExpr(
        i32(0) as Node<'i32'>,
        [[0, vec4(1, 0, 0, 1) as unknown as Node<'i32'>]],
        i32(99),
      )
    }).toThrow(/matchExpr case Node type/)
  })

  it('tsc rejects case type mismatch when R is pinned (compile-time gate)', () => {
    // Pin R='i32' explicitly so a vec4f case value mismatches the generic
    // bound — exercises the AC2 compile-time-rejection probe. The call is
    // wrapped in expect().toThrow() because the runtime cross-check fires
    // before the @ts-expect-error directive could ever go un-asserted.
    expect(() => {
      matchExpr<'u32', 'i32'>(
        u32(0) as Node<'u32'>,
        // @ts-expect-error case Node<'vec4<f32>'> does not satisfy R='i32'
        [[0, vec4(1, 0, 0, 1)]],
        i32(99),
      )
    }).toThrow(/matchExpr case Node type/)
  })
})

describe('matchExpr — lowerModule pre-emit pass (i32 / u32 scrutinee)', () => {
  it('hoists `var _mr_0` + Stmt.switch with assigns into each case body; i32 scrutinee yields untyped case labels', () => {
    const e = matchExpr(
      i32(0) as Node<'i32'>,
      [[0, i32(10)], [1, i32(20)]],
      i32(99),
    )
    // matchExpr lives inside a `return` Stmt's expr.
    const mod = moduleFromBody('t_i32', i32T, i32T, [
      // The matchExpr Expr is wrapped by an outer `return`. We replace
      // the matchExpr Expr with what the user authored.
      // To exercise the lowering, also replace scrutinee with `scrutI32`
      // (which references the fn param `s`).
      { s: 'return', expr: replaceScrutinee(e.expr, scrutI32) },
    ])
    const lowered = lowerModule(mod)
    const body = lowered.funcs[0]!.body
    // 3 Stmts: var slot, switch, return _mr_0
    expect(body.length).toBe(3)
    expect(body[0]!.s).toBe('var')
    if (body[0]!.s === 'var') {
      expect(body[0]!.name).toBe('_mr_0')
      expect(body[0]!.type).toEqual(i32T)
    }
    expect(body[1]!.s).toBe('switch')
    if (body[1]!.s === 'switch') {
      // i32 scrutinee passes through unchanged (no i32() cast).
      expect(body[1]!.scrut.op).toBe('param')
      expect(body[1]!.cases.length).toBe(2)
      const armBody = body[1]!.cases[0]!.body
      expect(armBody.length).toBe(1)
      expect(armBody[0]!.s).toBe('assign')
      expect(body[1]!.defaultBody).toBeDefined()
      expect(body[1]!.defaultBody!.length).toBe(1)
    }
    expect(body[2]!.s).toBe('return')
    if (body[2]!.s === 'return') {
      expect((body[2]!.expr as { op: string; name?: string }).op).toBe('varref')
      expect((body[2]!.expr as { name?: string }).name).toBe('_mr_0')
    }
  })

  it('u32 scrutinee → emitted WGSL switch carries u32 case labels (`0u`, `1u`)', () => {
    const e = matchExpr(
      u32(0) as Node<'u32'>,
      [[0, i32(10)], [1, i32(20)]],
      i32(99),
    )
    const mod = moduleFromBody('t_u32', u32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const wgsl = emitModule(mod)
    expect(wgsl).toMatch(/switch\s+s\s*\{/)
    expect(wgsl).toContain('case 0u: {')
    expect(wgsl).toContain('case 1u: {')
    expect(wgsl).toContain('default: {')
  })
})

describe('matchExpr — non-integer scrutinee cast', () => {
  it('f32 scrutinee → switch scrut wrapped in i32(...)', () => {
    const e = matchExpr(
      f32(0) as Node<'f32'>,
      [[0, i32(10)], [1, i32(20)]],
      i32(99),
    )
    const mod = moduleFromBody('t_f32', f32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutF32) },
    ])
    const lowered = lowerModule(mod)
    const sw = lowered.funcs[0]!.body[1]
    expect(sw!.s).toBe('switch')
    if (sw!.s === 'switch') {
      expect(sw.scrut.op).toBe('call')
      if (sw.scrut.op === 'call') {
        expect(sw.scrut.fn).toBe('i32')
        expect(sw.scrut.args.length).toBe(1)
      }
    }
    const wgsl = emitModule(mod)
    expect(wgsl).toMatch(/switch\s+i32\(s\)/)
  })
})

describe('matchExpr — perf gate (>=10 arms always uses Stmt.switch)', () => {
  it('10-arm match yields a single Stmt.switch with 10 cases (linear-scaling lowering)', () => {
    const cases: ReadonlyArray<readonly [number, Node<'i32'>]> = Array.from({ length: 10 }, (_, k) => [k, i32(k * 10)] as const)
    const e = matchExpr(u32(0) as Node<'u32'>, cases, i32(-1))
    const mod = moduleFromBody('t_ten', u32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const lowered = lowerModule(mod)
    const body = lowered.funcs[0]!.body
    expect(body.length).toBe(3)
    expect(body[1]!.s).toBe('switch')
    if (body[1]!.s === 'switch') {
      expect(body[1]!.cases.length).toBe(10)
    }
    // The emitted WGSL must NOT use a nested select() chain for the dispatch.
    const wgsl = emitModule(mod)
    expect(wgsl).not.toMatch(/select\s*\(/)
  })

  it('13-arm match (real OFM landuse shape) reproducibly lowers', () => {
    const cases: ReadonlyArray<readonly [number, Node<'i32'>]> = Array.from({ length: 13 }, (_, k) => [k, i32(k)] as const)
    const e = matchExpr(u32(0) as Node<'u32'>, cases, i32(99))
    const mod = moduleFromBody('t_13', u32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const wgsl = emitModule(mod)
    expect((wgsl.match(/case \d+u:/g) ?? []).length).toBe(13)
    expect(wgsl).toContain('default: {')
  })
})

describe('matchExpr — CPU eval round-trip', () => {
  it('picks matched case', () => {
    const e = matchExpr(u32(0) as Node<'u32'>, [[0, i32(10)], [1, i32(20)], [2, i32(30)]], i32(99))
    const mod = moduleFromBody('pick', u32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const cpu = compileModule(mod)
    expect(cpu.fns['pick']!(1)).toBe(20)
    expect(cpu.fns['pick']!(2)).toBe(30)
  })

  it('falls back to default when no case matches', () => {
    const e = matchExpr(u32(0) as Node<'u32'>, [[0, i32(10)], [1, i32(20)]], i32(99))
    const mod = moduleFromBody('dflt', u32T, i32T, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const cpu = compileModule(mod)
    expect(cpu.fns['dflt']!(7)).toBe(99)
  })

  it('cpu vec4 default + matched case', () => {
    const e = matchExpr(
      u32(0) as Node<'u32'>,
      [[0, vec4(1, 0, 0, 1)], [1, vec4(0, 1, 0, 1)]],
      vec4(0.5, 0.5, 0.5, 1),
    )
    const mod = moduleFromBody('color', u32T, vec4fT, [
      { s: 'return', expr: replaceScrutinee(e.expr, scrutU32) },
    ])
    const cpu = compileModule(mod)
    expect(cpu.fns['color']!(0)).toEqual([1, 0, 0, 1])
    expect(cpu.fns['color']!(2)).toEqual([0.5, 0.5, 0.5, 1])
  })
})

describe('matchExpr — walk semantics (hoist scope)', () => {
  it('matchExpr inside a Stmt.for body → hoist scoped to the loop body, NOT outside', () => {
    const e = matchExpr(u32(0) as Node<'u32'>, [[0, i32(10)]], i32(99))
    // Build a manual for: for (var i: u32 = 0u; i < 4u; i = i + 1u) { return matchExpr(...) }
    const iVar: Stmt = { s: 'var', name: 'i', type: u32T, init: { op: 'lit', type: u32T, value: 0 } }
    const cond: Expr = { op: 'compare', type: { kind: 'scalar', scalar: 'bool' }, cop: '<', a: { op: 'varref', type: u32T, name: 'i' }, b: { op: 'lit', type: u32T, value: 4 } }
    const update: Stmt = { s: 'assign', target: { op: 'varref', type: u32T, name: 'i' }, expr: { op: 'binop', type: u32T, bop: '+', a: { op: 'varref', type: u32T, name: 'i' }, b: { op: 'lit', type: u32T, value: 1 } } }
    const forStmt: Stmt = {
      s: 'for', init: iVar, cond, update,
      body: [returnStmt(replaceScrutinee(e.expr, scrutU32))],
    }
    const mod = moduleFromBody('t_for', u32T, i32T, [forStmt, returnStmt(i32(0).expr)])
    const lowered = lowerModule(mod)
    const fnBody = lowered.funcs[0]!.body
    // OUTER body MUST still be [for-stmt, return-0] — no hoist bubbled out.
    expect(fnBody.length).toBe(2)
    expect(fnBody[0]!.s).toBe('for')
    expect(fnBody[1]!.s).toBe('return')
    if (fnBody[0]!.s === 'for') {
      // INNER for body: [var _mr_0, switch, return _mr_0]
      const inner = fnBody[0]!.body
      expect(inner.length).toBe(3)
      expect(inner[0]!.s).toBe('var')
      expect(inner[1]!.s).toBe('switch')
      expect(inner[2]!.s).toBe('return')
    }
  })

  it('matchExpr inside Stmt.if arm → hoist scoped to that arm, NOT outside', () => {
    const e = matchExpr(u32(0) as Node<'u32'>, [[0, i32(10)]], i32(99))
    const ifStmt: Stmt = {
      s: 'if',
      arms: [{
        cond: { op: 'lit', type: { kind: 'scalar', scalar: 'bool' }, value: true },
        body: [returnStmt(replaceScrutinee(e.expr, scrutU32))],
      }],
    }
    const mod = moduleFromBody('t_if', u32T, i32T, [ifStmt, returnStmt(i32(0).expr)])
    const lowered = lowerModule(mod)
    const fnBody = lowered.funcs[0]!.body
    expect(fnBody.length).toBe(2)
    expect(fnBody[0]!.s).toBe('if')
    if (fnBody[0]!.s === 'if') {
      const armBody = fnBody[0]!.arms[0]!.body
      expect(armBody.length).toBe(3)
      expect(armBody[0]!.s).toBe('var')
      expect(armBody[1]!.s).toBe('switch')
      expect(armBody[2]!.s).toBe('return')
    }
  })

  it('nested matchExpr depth-2 → deepest lowered first, outer references first slot', () => {
    // Inner matchExpr: emits to _mr_0 slot (case body inside outer's case body).
    const inner = matchExpr(u32(0) as Node<'u32'>, [[10, i32(100)]], i32(999))
    // Outer matchExpr uses inner as the value of its first case.
    // We have to construct this manually because matchExpr() validates the
    // Node type — both must produce i32, which they do.
    const outer = matchExpr(
      u32(0) as Node<'u32'>,
      [[0, new MockNodeFromExpr<'i32'>(inner.expr, i32T).asNode()]],
      i32(99),
    )
    const mod = moduleFromBody('t_nested', u32T, i32T, [
      returnStmt(replaceScrutinee(outer.expr, scrutU32)),
    ])
    const lowered = lowerModule(mod)
    const body = lowered.funcs[0]!.body
    // Body shape: [var _mr_0, switch_inner, var _mr_1, switch_outer, return _mr_1]
    expect(body.length).toBe(5)
    expect(body[0]!.s).toBe('var')
    expect(body[1]!.s).toBe('switch')
    expect(body[2]!.s).toBe('var')
    expect(body[3]!.s).toBe('switch')
    expect(body[4]!.s).toBe('return')
    if (body[0]!.s === 'var') expect(body[0]!.name).toBe('_mr_0')
    if (body[2]!.s === 'var') expect(body[2]!.name).toBe('_mr_1')
    // Outer switch's case 0 body assigns the INNER slot reference (varref _mr_0)
    // to the outer slot (_mr_1) — proves inside-out lowering.
    if (body[3]!.s === 'switch') {
      const innerCaseAssign = body[3]!.cases[0]!.body[0]!
      expect(innerCaseAssign.s).toBe('assign')
      if (innerCaseAssign.s === 'assign') {
        expect((innerCaseAssign.expr as { op: string; name?: string }).op).toBe('varref')
        expect((innerCaseAssign.expr as { name?: string }).name).toBe('_mr_0')
      }
    }
  })
})

describe('matchExpr — lowering invariants', () => {
  it('lowerModule leaves no matchExpr Expr anywhere in the rewritten fn bodies', () => {
    // Outer + nested matchExpr stack the way the compiler's real palette /
    // categorical chains would. If the pre-emit pass missed one, the
    // emit-side defensive throw in emitExpr would fire — but we assert the
    // invariant up front by walking the lowered IR.
    const inner = matchExpr(u32(0) as Node<'u32'>, [[10, i32(100)]], i32(999))
    const outer = matchExpr(
      u32(0) as Node<'u32'>,
      [[0, new MockNodeFromExpr<'i32'>(inner.expr, i32T).asNode()]],
      i32(99),
    )
    const mod = moduleFromBody('t_invariant', u32T, i32T, [
      returnStmt(replaceScrutinee(outer.expr, scrutU32)),
    ])
    const lowered = lowerModule(mod)
    expect(countMatchExprs(lowered)).toBe(0)
  })
})

function countMatchExprs(m: ModuleDecl): number {
  let n = 0
  const visitExpr = (e: Expr): void => {
    if (e.op === 'matchExpr') n++
    switch (e.op) {
      case 'binop': case 'compare': case 'logical': visitExpr(e.a); visitExpr(e.b); break
      case 'unop': visitExpr(e.a); break
      case 'call': case 'construct': e.args.forEach(visitExpr); break
      case 'member': visitExpr(e.base); break
      case 'select': visitExpr(e.cond); visitExpr(e.ifTrue); visitExpr(e.ifFalse); break
      case 'index': visitExpr(e.base); visitExpr(e.idx); break
      case 'matchExpr':
        visitExpr(e.scrutinee)
        e.cases.forEach(([, v]) => visitExpr(v))
        visitExpr(e.default)
        break
      // leaves
      case 'lit': case 'constref': case 'param': case 'varref': break
    }
  }
  const visitStmt = (s: Stmt): void => {
    switch (s.s) {
      case 'let': visitExpr(s.expr); break
      case 'var': if (s.init) visitExpr(s.init); break
      case 'assign': case 'assignOp': visitExpr(s.target); visitExpr(s.expr); break
      case 'return': if (s.expr) visitExpr(s.expr); break
      case 'if': s.arms.forEach(a => { visitExpr(a.cond); a.body.forEach(visitStmt) }); s.elseBody?.forEach(visitStmt); break
      case 'for': visitStmt(s.init); visitExpr(s.cond); visitStmt(s.update); s.body.forEach(visitStmt); break
      case 'switch': visitExpr(s.scrut); s.cases.forEach(c => c.body.forEach(visitStmt)); s.defaultBody?.forEach(visitStmt); break
      case 'break': case 'continue': case 'discard': break
    }
  }
  for (const f of m.funcs) f.body.forEach(visitStmt)
  return n
}

// ── Local helpers ─────────────────────────────────────────────────────

// Swap a matchExpr's scrutinee with a different Expr (used so the tests can
// reference an authored param/varref instead of the `u32(0)` literal we used
// when constructing the matchExpr for the test fixture).
function replaceScrutinee(e: Expr, scrut: Expr): Expr {
  if (e.op !== 'matchExpr') return e
  return { ...e, scrutinee: scrut }
}

// Adapter that lets us pass an arbitrary Expr through matchExpr's type
// constructor — needed because the public matchExpr() requires a Node<R>,
// not a raw Expr, and we're feeding it an already-built matchExpr Expr to
// exercise nested lowering. Kept local to this test file.
class MockNodeFromExpr<K extends string> {
  constructor(private readonly e: Expr, private readonly _t: typeof i32T | typeof vec4fT) {}
  asNode(): Node<K> {
    const _t = this._t
    return { expr: this.e, type: _t, __k: undefined as K | undefined } as unknown as Node<K>
  }
}
