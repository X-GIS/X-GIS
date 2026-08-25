// renameVarrefsInFunc — the varref renamer host modules use to re-point
// compiler-spliced dotted uniform reads (`u.zoom` → `frame.zoom`) when a
// block is renamed or split. Pins: renames reach NESTED expression shapes
// (call args, compare arms, if-arm conds/bodies) and statement shapes,
// non-matches are untouched, and the no-change case returns the SAME
// FuncDecl reference.

import { describe, it, expect } from 'vitest'
import { renameVarrefsInFunc } from './rename-varrefs.js'
import type { Expr, FuncDecl, Stmt } from '../ir/nodes.js'

const F32 = { kind: 'scalar', scalar: 'f32' } as const
const vr = (name: string): Expr => ({ op: 'varref', type: F32, name })
const lit1: Expr = { op: 'lit', type: F32, value: '1.0' } as unknown as Expr

function fnWith(body: Stmt[]): FuncDecl {
  return { name: 'probe', params: [], ret: F32, body }
}

const route = (name: string): string | undefined =>
  name.startsWith('u.') ? `frame.${name.slice(2)}` : undefined

describe('renameVarrefsInFunc', () => {
  it('renames varrefs nested in calls, compares, and if-arm bodies', () => {
    const body: Stmt[] = [
      {
        s: 'let',
        name: 'a',
        expr: { op: 'call', type: F32, fn: 'max', args: [vr('u.zoom'), lit1] } as Expr,
      },
      {
        s: 'if',
        arms: [
          {
            cond: { op: 'compare', type: F32, cop: '>', a: vr('u.opacity'), b: lit1 } as Expr,
            body: [{ s: 'return', expr: vr('u.zoom') } as Stmt],
          },
        ],
      } as Stmt,
      { s: 'return', expr: vr('local') } as Stmt,
    ]
    const out = renameVarrefsInFunc(fnWith(body), route)
    const text = JSON.stringify(out.body)
    expect(text).toContain('frame.zoom')
    expect(text).toContain('frame.opacity')
    expect(text).not.toContain('"u.')
    // Non-dotted locals untouched.
    expect(text).toContain('"local"')
  })

  it('returns the SAME FuncDecl when nothing matches (referential no-op)', () => {
    const f = fnWith([{ s: 'return', expr: vr('local') } as Stmt])
    expect(renameVarrefsInFunc(f, route)).toBe(f)
  })
})

describe('rewriteExprsInFunc — the identity contract (#2042 INC-4b vanished-fills)', () => {
  // auto-vars (opt) correlates a mutable value's declaration, assignments,
  // and reads by Expr OBJECT identity. The first walker cloned every
  // ancestor of a change PER OCCURRENCE: one shared assign-target/read
  // object became N clones, auto-vars minted a var per clone, and every
  // read collapsed to the initializer — split-draw vertices all landed at
  // (0,0,0,0). These pins make that regression impossible to reintroduce
  // silently.
  it('an UNCHANGED shared subtree keeps its object identity at every occurrence', async () => {
    const { rewriteExprsInFunc } = await import('./rename-varrefs.js')
    // shared: the construct object both an assign target and a read embed.
    const shared: Expr = { op: 'construct', type: F32, args: [lit1] } as unknown as Expr
    const read: Expr = { op: 'call', type: F32, fn: 'sin', args: [shared] } as unknown as Expr
    const body: Stmt[] = [
      { s: 'assign', target: shared, expr: vr('u.zoom') } as unknown as Stmt,
      { s: 'return', expr: read } as Stmt,
    ]
    const out = rewriteExprsInFunc(fnWith(body), (x) =>
      x.op === 'varref' && x.name === 'u.zoom' ? { ...x, name: 'frame.zoom' } : x,
    )
    const outAssign = out.body[0] as unknown as { target: Expr; expr: Expr }
    const outReturn = out.body[1] as unknown as { expr: { args: Expr[] } }
    // the rename landed…
    expect((outAssign.expr as { name?: string }).name).toBe('frame.zoom')
    // …and the UNTOUCHED shared object is still the ORIGINAL, everywhere.
    expect(outAssign.target).toBe(shared)
    expect(outReturn.expr.args[0]).toBe(shared)
  })

  it('a CHANGED shared subtree maps to ONE new object, reused at every occurrence', async () => {
    const { rewriteExprsInFunc } = await import('./rename-varrefs.js')
    const shared: Expr = {
      op: 'construct',
      type: F32,
      args: [vr('u.zoom')],
    } as unknown as Expr
    const wrapA: Expr = { op: 'call', type: F32, fn: 'sin', args: [shared] } as unknown as Expr
    const wrapB: Expr = { op: 'call', type: F32, fn: 'cos', args: [shared] } as unknown as Expr
    const body: Stmt[] = [
      { s: 'let', name: 'a', expr: wrapA } as Stmt,
      { s: 'return', expr: wrapB } as Stmt,
    ]
    const out = rewriteExprsInFunc(fnWith(body), (x) =>
      x.op === 'varref' && x.name === 'u.zoom' ? { ...x, name: 'frame.zoom' } : x,
    )
    const a = (out.body[0] as unknown as { expr: { args: Expr[] } }).expr.args[0]
    const b = (out.body[1] as unknown as { expr: { args: Expr[] } }).expr.args[0]
    expect(a).not.toBe(shared) // it WAS rewritten (contains the renamed read)
    expect(a).toBe(b) // …into ONE object shared by both occurrences
  })
})
