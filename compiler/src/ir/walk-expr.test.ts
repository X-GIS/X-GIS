// ═══════════════════════════════════════════════════════════════════
// walk-expr.ts — child-set contract for the two Expr walkers
// ═══════════════════════════════════════════════════════════════════
//
// This file is the guard the consolidation owes (ADR-0013 decision 4):
// `CASES` is keyed `Record<AST.Expr['kind'], …>`, so a new `Expr` kind
// fails to COMPILE here until its child set is written down — the check
// `forEachExprChild` cannot get from its `void` return type the way
// `mapExprChildren` gets it from returning `AST.Expr`.
//
// It also pins the two arms where the walkers deliberately DISAGREE, so
// a later "simplification" that folds them into one shows up as a red
// test rather than as a changed CSEReport nobody reads:
//
//   FnCall        an Identifier callee is a function name, not a value —
//                 the rewriter holds it fixed, the analysis visits it.
//   ObjectLiteral the rewriter descends (it must not drop a subtree),
//                 the analysis treats it as a leaf.

import { describe, expect, it } from 'vitest'
import type * as AST from '../parser/ast'
import { forEachExprChild, mapExprChildren } from './walk-expr'

const s = (value: string): AST.StringLiteral => ({ kind: 'StringLiteral', value })
const id = (name: string): AST.Identifier => ({ kind: 'Identifier', name })

/** The tag a fixture child carries, so an assertion can name it. */
function tag(e: AST.Expr): string {
  if (e.kind === 'StringLiteral') return e.value
  if (e.kind === 'Identifier' || e.kind === 'InputRef') return e.name
  return `<${e.kind}>`
}

interface WalkCase {
  node: AST.Expr
  /** Children `mapExprChildren` hands to `f`, in order. */
  mapped: string[]
  /** Children `forEachExprChild` hands to `f`, in order. */
  visited: string[]
}

// Every Expr kind, with the children each walker reaches. Adding a kind
// to `AST.Expr` makes this object a type error until it is listed.
const CASES: Record<AST.Expr['kind'], WalkCase> = {
  NumberLiteral: { node: { kind: 'NumberLiteral', value: 1, unit: null }, mapped: [], visited: [] },
  StringLiteral: { node: s('leaf'), mapped: [], visited: [] },
  ColorLiteral: { node: { kind: 'ColorLiteral', value: '#ff0000' }, mapped: [], visited: [] },
  BoolLiteral: { node: { kind: 'BoolLiteral', value: true }, mapped: [], visited: [] },
  Identifier: { node: id('leaf'), mapped: [], visited: [] },
  InputRef: {
    node: {
      kind: 'InputRef',
      name: 'leaf',
      type: 'f32',
      slot: 0,
      default: { kind: 'NumberLiteral', value: 0, unit: null },
    },
    mapped: [],
    visited: [],
  },
  FieldAccess: {
    node: { kind: 'FieldAccess', object: s('obj'), field: 'f' },
    mapped: ['obj'],
    visited: ['obj'],
  },
  // The callee is an Identifier: the rewriter holds it fixed, the
  // analysis counts it as a node.
  FnCall: {
    node: {
      kind: 'FnCall',
      callee: id('callee'),
      args: [s('arg0'), s('arg1')],
      matchBlock: { kind: 'MatchBlock', arms: [{ pattern: 'p', value: s('arm') }] },
    },
    mapped: ['arg0', 'arg1', 'arm'],
    visited: ['callee', 'arg0', 'arg1', 'arm'],
  },
  BinaryExpr: {
    node: { kind: 'BinaryExpr', op: '+', left: s('l'), right: s('r') },
    mapped: ['l', 'r'],
    visited: ['l', 'r'],
  },
  UnaryExpr: {
    node: { kind: 'UnaryExpr', op: '-', operand: s('o') },
    mapped: ['o'],
    visited: ['o'],
  },
  ConditionalExpr: {
    node: { kind: 'ConditionalExpr', condition: s('c'), thenExpr: s('t'), elseExpr: s('e') },
    mapped: ['c', 't', 'e'],
    visited: ['c', 't', 'e'],
  },
  ArrayLiteral: {
    node: { kind: 'ArrayLiteral', elements: [s('e0'), s('e1')] },
    mapped: ['e0', 'e1'],
    visited: ['e0', 'e1'],
  },
  // The one arm where the analysis stops and the rewriter does not.
  ObjectLiteral: {
    node: { kind: 'ObjectLiteral', properties: [{ key: 'k', value: s('v') }] },
    mapped: ['v'],
    visited: [],
  },
  ArrayAccess: {
    node: { kind: 'ArrayAccess', array: s('arr'), index: s('idx') },
    mapped: ['arr', 'idx'],
    visited: ['arr', 'idx'],
  },
  MatchBlock: {
    node: {
      kind: 'MatchBlock',
      arms: [
        { pattern: 'a', value: s('m0') },
        { pattern: 'b', value: s('m1') },
      ],
    },
    mapped: ['m0', 'm1'],
    visited: ['m0', 'm1'],
  },
}

describe('walk-expr — child sets, every Expr kind', () => {
  for (const [kind, c] of Object.entries(CASES)) {
    it(`${kind}: mapExprChildren rewrites ${c.mapped.length} child(ren)`, () => {
      const seen: string[] = []
      mapExprChildren(c.node, (child) => {
        seen.push(tag(child))
        return child
      })
      expect(seen).toEqual(c.mapped)
    })

    it(`${kind}: forEachExprChild visits ${c.visited.length} child(ren)`, () => {
      const seen: string[] = []
      forEachExprChild(c.node, (child) => seen.push(tag(child)))
      expect(seen).toEqual(c.visited)
    })
  }
})

describe('walk-expr — arms the fixture table cannot express', () => {
  it('FnCall with a non-Identifier callee: both walkers reach it', () => {
    const node: AST.FnCall = {
      kind: 'FnCall',
      callee: { kind: 'FieldAccess', object: null, field: 'dyn' },
      args: [],
    }
    const mapped: string[] = []
    mapExprChildren(node, (child) => {
      mapped.push(child.kind)
      return child
    })
    const visited: string[] = []
    forEachExprChild(node, (child) => visited.push(child.kind))
    expect(mapped).toEqual(['FieldAccess'])
    expect(visited).toEqual(['FieldAccess'])
  })

  it('FieldAccess with a null object has no child', () => {
    const node: AST.FieldAccess = { kind: 'FieldAccess', object: null, field: 'implicit' }
    const mapped: string[] = []
    mapExprChildren(node, (child) => {
      mapped.push(tag(child))
      return child
    })
    const visited: string[] = []
    forEachExprChild(node, (child) => visited.push(tag(child)))
    expect(mapped).toEqual([])
    expect(visited).toEqual([])
  })

  it('FnCall without a matchBlock does not synthesise one', () => {
    const node: AST.FnCall = { kind: 'FnCall', callee: id('f'), args: [s('a')] }
    const out = mapExprChildren(node, (child) => child) as AST.FnCall
    expect('matchBlock' in out).toBe(false)
  })
})

describe('walk-expr — mapExprChildren node identity', () => {
  it('returns the input node itself when there is nothing to rewrite', () => {
    for (const kind of [
      'NumberLiteral',
      'StringLiteral',
      'ColorLiteral',
      'BoolLiteral',
      'Identifier',
      'InputRef',
    ] as const) {
      const node = CASES[kind].node
      expect(mapExprChildren(node, (child) => child)).toBe(node)
    }
    const implicit: AST.FieldAccess = { kind: 'FieldAccess', object: null, field: 'f' }
    expect(mapExprChildren(implicit, (child) => child)).toBe(implicit)
  })

  it('rebuilds the node around rewritten children without mutating the input', () => {
    const input: AST.BinaryExpr = { kind: 'BinaryExpr', op: '+', left: s('l'), right: s('r') }
    const out = mapExprChildren(input, () => s('X')) as AST.BinaryExpr
    expect(out).not.toBe(input)
    expect(tag(out.left)).toBe('X')
    expect(tag(out.right)).toBe('X')
    expect(tag(input.left)).toBe('l')
    expect(tag(input.right)).toBe('r')
  })
})
