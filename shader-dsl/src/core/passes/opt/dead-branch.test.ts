import { describe, it, expect } from 'vitest'
import { deadBranch, constFold } from './index'
import { module, f32T, boolT, type Stmt, type Expr, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
const litBool = (value: boolean): Expr => ({ op: 'lit', type: boolT, value })
const ret = (value: number): Stmt => ({ s: 'return', expr: lit(value) })

// P2 — dead-branch elimination: drop a lit-false arm, collapse a lit-true arm.
// Pure structural removal, so modules are hand-built with literal conditions (the
// shape const-fold produces). Correctness pinned by oracle value-equality. Funcs
// carry allowEarlyReturn (the if/else arms each return — an intentional deviation).
describe('optimize — dead-branch elimination', () => {
  it('drops an if-arm whose condition is literal false (keeps the else)', () => {
    const m: ModuleDecl = module({ funcs: [{
      name: 'k', params: [], ret: f32T, allowEarlyReturn: true,
      body: [{ s: 'if', arms: [{ cond: litBool(false), body: [ret(1)] }], elseBody: [ret(2)] }] as Stmt[],
    }] })
    const wgsl = emitModule(deadBranch(m))
    expect(wgsl).not.toContain('if')
    expect(wgsl).toContain('return 2.0')
    expect(wgsl).not.toContain('1.0')
  })

  it('collapses a first-arm literal-true condition to its body', () => {
    const m: ModuleDecl = module({ funcs: [{
      name: 'k', params: [], ret: f32T, allowEarlyReturn: true,
      body: [{ s: 'if', arms: [{ cond: litBool(true), body: [ret(7)] }], elseBody: [ret(9)] }] as Stmt[],
    }] })
    const wgsl = emitModule(deadBranch(m))
    expect(wgsl).not.toContain('if')
    expect(wgsl).toContain('return 7.0')
    expect(wgsl).not.toContain('9.0')
  })

  it('preserves oracle value-equality', () => {
    const m: ModuleDecl = module({ funcs: [{
      name: 'k', params: [], ret: f32T, allowEarlyReturn: true,
      body: [{ s: 'if', arms: [{ cond: litBool(false), body: [ret(1)] }], elseBody: [ret(2)] }] as Stmt[],
    }] })
    expect(compileModule(deadBranch(m)).fns.k()).toBe(compileModule(m).fns.k()) // 2
  })

  it('const-fold + dead-branch chain removes a comparison-decided branch', () => {
    // if (0 > 1) { return 1 } else { return x }  ->  0>1 folds false  ->  return x
    const m: ModuleDecl = module({ funcs: [{
      name: 'k', params: [{ name: 'x', type: f32T }], ret: f32T, allowEarlyReturn: true,
      body: [{
        s: 'if',
        arms: [{ cond: { op: 'compare', type: boolT, cop: '>', a: lit(0), b: lit(1) }, body: [ret(1)] }],
        elseBody: [{ s: 'return', expr: { op: 'param', type: f32T, name: 'x' } }],
      }] as Stmt[],
    }] })
    const out = deadBranch(constFold(m))
    expect(emitModule(out)).not.toContain('if')
    expect(compileModule(out).fns.k(3)).toBe(compileModule(m).fns.k(3)) // 3
  })
})
