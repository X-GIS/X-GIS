// ═══════════════════════════════════════════════════════════════════
// expr-analyze.ts — per-Expr structural analysis tests (iter-269)
// ═══════════════════════════════════════════════════════════════════
//
// Pins the metadata produced for each kind of Expr — depth count,
// match-arm detection, literal-arm detection, dataflow flag
// propagation — against handcrafted Scenes.

import { describe, expect, it } from 'vitest'
import { analyzeExprs, exprAnalyzePass } from './expr-analyze'
import type { ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue } from '../render-node'
import type { PropertyShape, RGBA } from '../property-types'
import type { Expr } from '../../parser/ast'

const RED: RGBA = [1, 0, 0, 1]

// AST helpers — minimal builders mirroring cse.test.ts. Use the open
// `Expr` cast so nested fnCall results pass strict tsc checks at the
// matchBlock arm value site (where strict Expr typing requires the
// arm to satisfy the full discriminated union shape).
const ident = (name: string): Expr => ({ kind: 'Identifier', name })
const field = (f: string): Expr => ({
  kind: 'FieldAccess', field: f, object: null,
})
const num = (value: number): Expr => ({
  kind: 'NumberLiteral', value, unit: null,
})
const fnCall = (calleeName: string, args: Expr[], matchArms: Array<{ pattern: string; value: Expr }> = []): Expr => ({
  kind: 'FnCall',
  callee: ident(calleeName),
  args,
  matchBlock: matchArms.length > 0
    ? { kind: 'MatchBlock', arms: matchArms.map(a => ({ pattern: a.pattern as never, value: a.value })) }
    : undefined,
})
const expr = (ast: Expr): DataExpr => ({ ast } as DataExpr)

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  const base: RenderNode = {
    name: 'a', sourceRef: 's', zOrder: 0,
    fill: { kind: 'none' },
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator', visible: true, pointerEvents: 'auto',
    filter: null, geometry: null, billboard: true,
    shape: { kind: 'named', name: 'circle' } as never,
  }
  return { ...base, ...overrides }
}

function makeScene(...nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('analyzeExprs — basic walk', () => {
  it('empty scene → 0 nodes visited', () => {
    const a = analyzeExprs(makeScene())
    expect(a.totalNodes).toBe(0)
  })

  it('constant fill → no DataExpr → 0 nodes visited', () => {
    const a = analyzeExprs(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    })))
    expect(a.totalNodes).toBe(0)
  })

  it('field access → hasFieldAccess true, depth 1', () => {
    const ast = field('class')
    const a = analyzeExprs(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    })))
    const meta = a.metaByExpr.get(ast)!
    expect(meta).toBeDefined()
    expect(meta.depth).toBe(1)
    expect(meta.hasFieldAccess).toBe(true)
    expect(meta.hasMatch).toBe(false)
    expect(meta.hasFnCall).toBe(false)
  })
})

describe('analyzeExprs — depth + flag propagation', () => {
  it('FnCall over FieldAccess → depth 2, hasFieldAccess propagates', () => {
    const fa = field('class')
    const root = fnCall('get', [fa])
    const a = analyzeExprs(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(root) } as ColorValue,
    })))
    const rootMeta = a.metaByExpr.get(root)!
    expect(rootMeta.depth).toBeGreaterThanOrEqual(2)
    expect(rootMeta.hasFieldAccess).toBe(true)
    expect(rootMeta.hasFnCall).toBe(true)
    expect(rootMeta.hasMatch).toBe(false)
  })

  it('match() over FieldAccess → hasMatch true, matchArmCount set on root', () => {
    const colorLit = (v: string): Expr => ({ kind: 'ColorLiteral', value: v })
    const ast = fnCall('match', [field('class')], [
      { pattern: 'school', value: colorLit('#aaa') },
      { pattern: 'park',   value: colorLit('#bbb') },
      { pattern: '_',      value: colorLit('#ccc') },
    ])
    const a = analyzeExprs(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    })))
    const meta = a.metaByExpr.get(ast)!
    expect(meta.hasMatch).toBe(true)
    expect(meta.matchArmCount).toBe(3)
    // All three arms are ColorLiteral → allArmsConst true.
    expect(meta.allArmsConst).toBe(true)
  })

  it('match() with one non-literal arm → allArmsConst false', () => {
    const colorLit = (v: string): Expr => ({ kind: 'ColorLiteral', value: v })
    const ast = fnCall('match', [field('class')], [
      { pattern: 'school', value: colorLit('#aaa') },
      // FnCall arm is not a literal — disqualifies allArmsConst.
      { pattern: 'park',   value: fnCall('rgba', [num(0.5), num(0.5), num(0.5), num(1)]) },
      { pattern: '_',      value: colorLit('#ccc') },
    ])
    const a = analyzeExprs(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    })))
    const meta = a.metaByExpr.get(ast)!
    expect(meta.matchArmCount).toBe(3)
    expect(meta.allArmsConst).toBe(false)
    // hasFnCall propagates from the non-literal arm.
    expect(meta.hasFnCall).toBe(true)
  })

  it('idempotent default true for all current builtins', () => {
    const ast = fnCall('clamp', [field('size'), num(4), num(24)])
    const a = analyzeExprs(makeScene(makeNode({
      opacity: { kind: 'data-driven', expr: expr(ast) } as PropertyShape<number>,
    })))
    expect(a.metaByExpr.get(ast)!.idempotent).toBe(true)
  })
})

describe('analyzeExprs — pass integration', () => {
  it('exprAnalyzePass attaches exprAnalysis side-table to Scene', () => {
    const ast = field('class')
    const scene = makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    }))
    const out = exprAnalyzePass.run(scene)
    expect(out.exprAnalysis).toBeDefined()
    expect(out.exprAnalysis!.totalNodes).toBe(1)
    expect(out.exprAnalysis!.metaByExpr.get(ast)).toBeDefined()
  })

  it('input scene NOT mutated', () => {
    const scene = makeScene()
    const out = exprAnalyzePass.run(scene)
    expect(out).not.toBe(scene)
    expect((scene as { exprAnalysis?: unknown }).exprAnalysis).toBeUndefined()
  })

  it('declares dependency on cse-annotate', () => {
    expect(exprAnalyzePass.name).toBe('expr-analyze')
    expect(exprAnalyzePass.dependencies).toEqual(['cse-annotate'])
  })

  it('empty scene → identity-shaped output (metaByExpr empty, totalNodes 0)', () => {
    const out = exprAnalyzePass.run(makeScene())
    expect(out.exprAnalysis!.totalNodes).toBe(0)
  })
})
