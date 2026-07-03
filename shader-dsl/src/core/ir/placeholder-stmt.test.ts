// ═══════════════════════════════════════════════════════════════════
// placeholder Stmt — Phase 2.5 US-007 (sub-steps 13a-13d)
// ═══════════════════════════════════════════════════════════════════
//
// The polygon DSL composer (emitPolygonWgsl, lands at 13e) lays down
// a placeholder Stmt at each variant-injection site and swaps it for
// the actual return-Expr at compose time. This file pins the
// placeholder Stmt's three backend touchpoints:
//
//   13a — IR extension: { s: 'placeholder', tag: string } in Stmt union
//   13b — wgsl backend: emits `// __placeholder: ${tag}` (defensive
//         comment so the WGSL still parses if the composer forgets to
//         splice).
//   13c — cpu backend: throws with the tag (CPU has no comment
//         analogue, and a silent missing-return is much harder to
//         localise — fail loudly).
//   13d — wgsl-lower lowerModule: leaf, no matchExpr descent.

import { describe, it, expect } from 'vitest'
import type { Stmt, FuncDecl, ModuleDecl } from './nodes'
import { i32T, voidT } from './types'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'
import { lowerModule } from '../passes/match-lower'

function moduleWithBody(body: Stmt[]): ModuleDecl {
  const fn: FuncDecl = {
    name: 'host',
    params: [],
    ret: voidT,
    body,
  }
  return { consts: [], structs: [], bindings: [], funcs: [fn] }
}

describe('placeholder Stmt — wgsl backend (13b)', () => {
  it('emits a `// __placeholder: <tag>` comment so the WGSL parses', () => {
    const mod = moduleWithBody([{ s: 'placeholder', tag: 'fill-return' }])
    const wgsl = emitModule(mod)
    expect(wgsl).toContain('// __placeholder: fill-return')
  })

  it('multiple placeholders with distinct tags emit independently', () => {
    const mod = moduleWithBody([
      { s: 'placeholder', tag: 'fill-return' },
      { s: 'placeholder', tag: 'stroke-return' },
    ])
    const wgsl = emitModule(mod)
    expect(wgsl).toContain('// __placeholder: fill-return')
    expect(wgsl).toContain('// __placeholder: stroke-return')
  })
})

describe('placeholder Stmt — cpu backend (13c)', () => {
  it('throws with the placeholder tag when execBody reaches it', () => {
    const mod = moduleWithBody([{ s: 'placeholder', tag: 'fill-return' }])
    const cpu = compileModule(mod)
    expect(() => cpu.fns['host']!()).toThrow(/placeholder Stmt reached CPU backend.*fill-return/)
  })

  it('throws even when the placeholder is nested inside an if arm', () => {
    const mod = moduleWithBody([
      {
        s: 'if',
        arms: [
          {
            cond: { op: 'lit', type: { kind: 'scalar', scalar: 'bool' }, value: true },
            body: [{ s: 'placeholder', tag: 'stroke-return' }],
          },
        ],
      },
    ])
    const cpu = compileModule(mod)
    expect(() => cpu.fns['host']!()).toThrow(/stroke-return/)
  })
})

describe('placeholder Stmt — wgsl-lower (13d, leaf treatment)', () => {
  it('lowerModule passes placeholder through unchanged (no descent attempt)', () => {
    const mod = moduleWithBody([
      { s: 'placeholder', tag: 'fill-return' },
      { s: 'placeholder', tag: 'stroke-return' },
    ])
    const lowered = lowerModule(mod)
    const body = lowered.funcs[0]!.body
    expect(body.length).toBe(2)
    expect(body[0]!.s).toBe('placeholder')
    expect(body[1]!.s).toBe('placeholder')
    if (body[0]!.s === 'placeholder') expect(body[0]!.tag).toBe('fill-return')
    if (body[1]!.s === 'placeholder') expect(body[1]!.tag).toBe('stroke-return')
  })

  it('placeholder coexists with matchExpr-bearing siblings; lowerModule hoists only the matchExpr', () => {
    // Sibling Stmts: a placeholder + an assignment whose RHS contains
    // a matchExpr. lowerModule must hoist the matchExpr's slot +
    // Stmt.switch before the assign, leaving the placeholder
    // structurally identical (no leak into the placeholder's
    // non-existent sub-Expr tree).
    const mod = moduleWithBody([
      { s: 'placeholder', tag: 'fill-return' },
      {
        s: 'var',
        name: 'x',
        type: i32T,
        init: {
          op: 'matchExpr',
          type: i32T,
          scrutinee: { op: 'lit', type: { kind: 'scalar', scalar: 'u32' }, value: 0 },
          cases: [[0, { op: 'lit', type: i32T, value: 10 }]],
          default: { op: 'lit', type: i32T, value: 99 },
        },
      },
    ])
    const lowered = lowerModule(mod)
    const body = lowered.funcs[0]!.body
    // Expected shape: [placeholder, var _mr_0, switch, var x = varref(_mr_0)]
    expect(body.length).toBe(4)
    expect(body[0]!.s).toBe('placeholder')
    expect(body[1]!.s).toBe('var')
    expect(body[2]!.s).toBe('switch')
    expect(body[3]!.s).toBe('var')
  })
})
