// ═══ The Stmt traversal SoT — coverage ratchet (#2534, audit rows 1 + 8) ═══
//
// The walkers in `visit.ts` replaced nine hand-written `switch (s.s)` copies, so a
// statement kind they forget is now forgotten EVERYWHERE at once. Neither switch is
// exhaustive to tsc — each ends in the `default` the five Expr-less kinds need — so the
// guard is here instead:
//
//   FIXTURE is `Record<Stmt['s'], …>`, so adding a member to the `Stmt` union fails to
//   COMPILE until an entry is written for it. Writing that entry means deciding how many
//   Exprs the new kind holds, which is the moment the author has to open `visit.ts`.

import { describe, it, expect } from 'vitest'
import { f32T, boolT, u32T } from './types.js'
import type { Expr, Stmt } from './nodes.js'
import { eachExpr, eachStmtExpr, mapStmtExpr } from './visit.js'

const lit = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
const ref = (name: string): Expr => ({ op: 'varref', type: f32T, name })
const cond: Expr = { op: 'lit', type: boolT, value: true }
const inner: Stmt = { s: 'let', name: '_inner', expr: lit(99) }

/** One instance per `Stmt` kind and the number of Exprs a full walk of it must reach —
 *  the statement's OWN slots plus every slot in its nested bodies. */
const FIXTURE: Record<Stmt['s'], { stmt: Stmt; slots: number }> = {
  let: { stmt: { s: 'let', name: 'a', expr: lit(1) }, slots: 1 },
  var: { stmt: { s: 'var', name: 'b', type: f32T, init: lit(2) }, slots: 1 },
  assign: { stmt: { s: 'assign', target: ref('a'), expr: lit(3) }, slots: 2 },
  assignOp: { stmt: { s: 'assignOp', target: ref('a'), bop: '+', expr: lit(4) }, slots: 2 },
  return: { stmt: { s: 'return', expr: lit(5) }, slots: 1 },
  // 1 arm cond + one `let` per arm body and else body.
  if: { stmt: { s: 'if', arms: [{ cond, body: [inner] }], elseBody: [inner] }, slots: 3 },
  for: {
    stmt: {
      s: 'for',
      init: { s: 'var', name: 'i', type: u32T, init: lit(0) },
      cond,
      update: { s: 'assignOp', target: ref('i'), bop: '+', expr: lit(1) },
      body: [inner],
    },
    // cond + the init var's 1 + the update assignOp's 2 + the body `let`'s 1: the header's
    // init/update are STATEMENTS, so their Exprs arrive through the nested walk.
    slots: 5,
  },
  switch: {
    stmt: {
      s: 'switch',
      scrut: lit(0),
      cases: [{ value: 1, body: [inner] }],
      defaultBody: [inner],
    },
    slots: 3,
  },
  break: { stmt: { s: 'break' }, slots: 0 },
  continue: { stmt: { s: 'continue' }, slots: 0 },
  discard: { stmt: { s: 'discard' }, slots: 0 },
  placeholder: { stmt: { s: 'placeholder', tag: 'x' }, slots: 0 },
  raw: { stmt: { s: 'raw', wgsl: 'x = 1;' }, slots: 0 },
}

const entries = Object.entries(FIXTURE) as [Stmt['s'], (typeof FIXTURE)[Stmt['s']]][]

describe('ir/visit — every Stmt kind is walked', () => {
  it.each(entries)('%s: eachStmtExpr reaches every Expr, own and nested', (_k, f) => {
    let n = 0
    eachStmtExpr(f.stmt, () => {
      n++
    })
    expect(n).toBe(f.slots)
  })

  it.each(entries)('%s: mapStmtExpr rewrites every Expr, own and nested', (_k, f) => {
    let n = 0
    const out = mapStmtExpr(f.stmt, (e) => {
      n++
      return e
    })
    expect(n).toBe(f.slots)
    // A statement with no Expr keeps its identity (the passes skip work on that).
    if (f.slots === 0) expect(out).toBe(f.stmt)
  })

  it('mapStmtExpr keeps a `var` without an initialiser identical', () => {
    const s: Stmt = { s: 'var', name: 'b', type: f32T }
    expect(mapStmtExpr(s, () => lit(0))).toBe(s)
  })

  it('open recursion: an eachStmtExpr override applies inside nested bodies', () => {
    const seen: Stmt['s'][] = []
    const walk = (s: Stmt): void => {
      seen.push(s.s)
      eachStmtExpr(s, () => {}, walk)
    }
    walk(FIXTURE.for.stmt)
    expect(seen).toEqual(['for', 'var', 'assignOp', 'let'])
  })

  it('open recursion: a mapStmtExpr override applies inside nested bodies', () => {
    const rewrite = (s: Stmt): Stmt =>
      s.s === 'let' ? { ...s, name: s.name.toUpperCase() } : mapStmtExpr(s, (e) => e, rewrite)
    const out = rewrite(FIXTURE.if.stmt) as Extract<Stmt, { s: 'if' }>
    expect(out.arms[0]!.body[0]).toMatchObject({ s: 'let', name: '_INNER' })
    expect(out.elseBody![0]).toMatchObject({ s: 'let', name: '_INNER' })
  })

  it('eachExpr is pre-order over the whole expression tree', () => {
    const e: Expr = {
      op: 'binop',
      type: f32T,
      bop: '+',
      a: { op: 'unop', type: f32T, a: lit(1) },
      b: lit(2),
    }
    const ops: Expr['op'][] = []
    eachExpr(e, (x) => ops.push(x.op))
    expect(ops).toEqual(['binop', 'unop', 'lit', 'lit'])
  })
})
