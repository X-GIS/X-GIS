// ═══════════════════════════════════════════════════════════════════
// compute-lowering.ts — AST → ComputeKernel spec adapter tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import {
  lowerConditionalColorToTernary,
  lowerMatchColorToMatch,
} from './compute-lowering'
import type { ColorValue, DataExpr } from '../ir/render-node'
import type { Expr } from '../parser/ast'

const RED: [number, number, number, number] = [1, 0, 0, 1]
const GREEN: [number, number, number, number] = [0, 1, 0, 1]
const BLUE: [number, number, number, number] = [0, 0, 1, 1]

describe('lowerConditionalColorToTernary', () => {
  it('lowers two-branch conditional → TernarySpec with two fields/preds', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'hostile',  value: { kind: 'constant', rgba: RED } },
        { field: 'friendly', value: { kind: 'constant', rgba: GREEN } },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const spec = lowerConditionalColorToTernary(v)
    expect(spec).not.toBeNull()
    expect(spec!.fields).toEqual(['hostile', 'friendly'])
    expect(spec!.branches[0]!.pred).toBe('v_hostile != 0.0')
    expect(spec!.branches[1]!.pred).toBe('v_friendly != 0.0')
    expect(spec!.branches[0]!.colorHex.toLowerCase()).toMatch(/^#ff0000/)
    expect(spec!.branches[1]!.colorHex.toLowerCase()).toMatch(/^#00ff00/)
    expect(spec!.defaultColorHex.toLowerCase()).toMatch(/^#0000ff/)
  })

  it('preserves branch input order (first match wins)', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'b', value: { kind: 'constant', rgba: GREEN } },
        { field: 'a', value: { kind: 'constant', rgba: RED } },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const spec = lowerConditionalColorToTernary(v)!
    // Fields preserved in insertion order — NOT sorted, because case
    // semantics depend on the order the user wrote.
    expect(spec.fields).toEqual(['b', 'a'])
  })

  it('dedups field names (same field referenced in multiple branches)', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'tier', value: { kind: 'constant', rgba: RED } },
        { field: 'tier', value: { kind: 'constant', rgba: GREEN } },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const spec = lowerConditionalColorToTernary(v)!
    expect(spec.fields).toEqual(['tier'])
    expect(spec.branches).toHaveLength(2)
  })

  it('returns null if any branch value is not constant (nested compound)', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [
        // nested zoom-interpolated → can't materialise in one kernel
        {
          field: 'x',
          value: {
            kind: 'zoom-interpolated',
            stops: [{ zoom: 0, value: RED }, { zoom: 20, value: BLUE }],
          },
        },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    expect(lowerConditionalColorToTernary(v)).toBeNull()
  })

  it('returns null if fallback is not constant', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'x', value: { kind: 'constant', rgba: RED } }],
      fallback: { kind: 'none' },
    }
    expect(lowerConditionalColorToTernary(v)).toBeNull()
  })
})

describe('lowerMatchColorToMatch', () => {
  function fieldAccess(name: string): Expr {
    return { kind: 'FieldAccess', object: null, field: name }
  }
  function matchAst(field: string, arms: { pattern: string; hex: string }[]): DataExpr {
    return {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [fieldAccess(field)],
        matchBlock: {
          kind: 'MatchBlock',
          arms: arms.map(a => ({
            pattern: a.pattern,
            value: { kind: 'ColorLiteral', value: a.hex },
          })),
        },
      },
    }
  }

  it('lowers match(.class) { … } with explicit default arm', () => {
    const expr = matchAst('class', [
      { pattern: 'school',   hex: '#f0e8f8' },
      { pattern: 'hospital', hex: '#f5deb3' },
      { pattern: '_',        hex: '#888888' },
    ])
    const spec = lowerMatchColorToMatch(expr)!
    expect(spec).not.toBeNull()
    expect(spec.fieldName).toBe('class')
    expect(spec.arms.map(a => a.pattern)).toEqual(['school', 'hospital'])
    expect(spec.defaultColorHex).toBe('#888888')
  })

  it('synthesises transparent default when no _ arm present', () => {
    // Matches merge-layers convention: missing default → compound
    // fill falls through to nothing.
    const expr = matchAst('class', [
      { pattern: 'school', hex: '#f0e8f8' },
    ])
    const spec = lowerMatchColorToMatch(expr)!
    expect(spec.defaultColorHex).toBe('#00000000')
  })

  it('returns null when AST is not a FnCall', () => {
    const expr: DataExpr = { ast: fieldAccess('class') }
    expect(lowerMatchColorToMatch(expr)).toBeNull()
  })

  it('returns null when FnCall callee is not match()', () => {
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'rgb' },
        args: [{ kind: 'NumberLiteral', value: 0, unit: null }],
      },
    }
    expect(lowerMatchColorToMatch(expr)).toBeNull()
  })

  it('returns null when match() field arg has a non-null object (compound path)', () => {
    // match(props.class) { ... } — multi-segment path can't be loaded
    // by the single-stride compute kernel.
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [{
          kind: 'FieldAccess',
          object: { kind: 'Identifier', name: 'props' },
          field: 'class',
        }],
        matchBlock: { kind: 'MatchBlock', arms: [] },
      },
    }
    expect(lowerMatchColorToMatch(expr)).toBeNull()
  })

  it('returns null when matchBlock is absent (parser produced bare FnCall)', () => {
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [fieldAccess('class')],
      },
    }
    expect(lowerMatchColorToMatch(expr)).toBeNull()
  })

  it('skips arms whose value is not resolvable to hex (mirrors shader-gen)', () => {
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [fieldAccess('class')],
        matchBlock: {
          kind: 'MatchBlock',
          arms: [
            { pattern: 'school', value: { kind: 'ColorLiteral', value: '#f0e8f8' } },
            // BinaryExpr arm — not resolvable by the adapter. Should
            // be silently skipped, matching shader-gen's behaviour.
            {
              pattern: 'hospital',
              value: {
                kind: 'BinaryExpr', op: '+',
                left:  { kind: 'NumberLiteral', value: 1, unit: null },
                right: { kind: 'NumberLiteral', value: 1, unit: null },
              },
            },
          ],
        },
      },
    }
    const spec = lowerMatchColorToMatch(expr)!
    expect(spec.arms.map(a => a.pattern)).toEqual(['school'])
  })

  it('resolves StringLiteral arm value via tokens lookup table', () => {
    // The tokens table uses hyphenated tailwind-style names
    // (`red-500`); parser surfaces these as a BinaryExpr (subtraction
    // form) at the user-authored layer but the canonical token form
    // is a string. The adapter accepts whichever form is given.
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [fieldAccess('class')],
        matchBlock: {
          kind: 'MatchBlock',
          arms: [
            { pattern: 'fire', value: { kind: 'StringLiteral', value: 'red-500' } },
          ],
        },
      },
    }
    const spec = lowerMatchColorToMatch(expr)!
    expect(spec.arms).toHaveLength(1)
    expect(spec.arms[0]!.pattern).toBe('fire')
    expect(spec.arms[0]!.colorHex).toMatch(/^#[0-9a-fA-F]{6,8}$/)
  })
})
