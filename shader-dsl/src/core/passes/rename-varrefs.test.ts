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
