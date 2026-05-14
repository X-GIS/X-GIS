// ═══════════════════════════════════════════════════════════════════
// cse.ts — analysis pass tests
// ═══════════════════════════════════════════════════════════════════
//
// Assert the walker visits every paint-property AST + filter / geometry
// expressions, dedups by canonical-string, and orders the report so
// the largest duplicates surface first. Each test builds a minimal
// Scene with explicit ASTs — no parser dependency.

import { describe, expect, it } from 'vitest'
import { analyzeCSE, hasCSEOpportunities } from './cse'
import type { ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue } from '../render-node'
import type { PropertyShape, RGBA } from '../property-types'

const RED: RGBA = [1, 0, 0, 1]

// AST helpers — minimal builders for the kinds the analyzer walks.
const ident = (name: string) => ({ kind: 'Identifier' as const, name })
const field = (f: string) => ({
  kind: 'FieldAccess' as const, field: f, object: null,
})
const num = (value: number) => ({
  kind: 'NumberLiteral' as const, value, unit: null,
})
// Args / arm-values accept any Expr shape (mixed FieldAccess /
// NumberLiteral / nested FnCall etc.). `unknown` keeps the helper
// from over-constraining its argument types in tests — the analyzer
// itself walks any AST shape via discriminated kind unions.
const fnCall = (calleeName: string, args: unknown[], matchArms: Array<{ pattern: string; value: unknown }> = []) => ({
  kind: 'FnCall' as const,
  callee: ident(calleeName),
  args,
  matchBlock: matchArms.length > 0
    ? { kind: 'MatchBlock' as const, arms: matchArms }
    : undefined,
})
const expr = (ast: object): DataExpr => ({ ast } as DataExpr)

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

describe('analyzeCSE — basic walk', () => {
  it('empty scene → empty report', () => {
    const report = analyzeCSE(makeScene())
    expect(report.entries).toEqual([])
    expect(report.duplicates).toEqual([])
    expect(report.totalNodes).toBe(0)
  })

  it('constant fill → no AST visited (no DataExpr)', () => {
    const report = analyzeCSE(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    })))
    expect(report.totalNodes).toBe(0)
    expect(report.entries).toEqual([])
  })

  it('single data-driven fill → visits the expr + all subtrees', () => {
    const ast = fnCall('match', [field('class')], [
      { pattern: 'school', value: { kind: 'ColorLiteral', value: '#f0e8f8' } },
      { pattern: '_',      value: { kind: 'ColorLiteral', value: '#888' } },
    ])
    const report = analyzeCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    })))
    // Subtrees: FnCall (root), Identifier(match), FieldAccess(class),
    // ColorLiteral×2 = 5
    expect(report.totalNodes).toBe(5)
    // No duplicates — every subtree appears once.
    expect(report.duplicates).toEqual([])
    expect(report.entries.length).toBe(5)
  })

  it('shared `get(.class)` across fill + stroke → 1 duplicate (count 2)', () => {
    // CSE motivating case: fill match(.class) AND stroke match(.class)
    // both reference the SAME field-access subtree. Analyzer should
    // surface it.
    const fillExpr = fnCall('match', [field('class')], [
      { pattern: 'a', value: { kind: 'ColorLiteral', value: '#aaa' } },
    ])
    const strokeExpr = fnCall('match', [field('class')], [
      { pattern: 'b', value: { kind: 'ColorLiteral', value: '#bbb' } },
    ])
    const report = analyzeCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(fillExpr) } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: expr(strokeExpr) } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    // FieldAccess(class) appears twice (fill arg + stroke arg).
    // Identifier(match) also appears twice (each FnCall's callee).
    const fieldClassEntry = report.duplicates.find(e => e.key.includes('F(class'))
    expect(fieldClassEntry).toBeDefined()
    expect(fieldClassEntry!.count).toBe(2)
    const matchIdentEntry = report.duplicates.find(e => e.key === 'I(match)')
    expect(matchIdentEntry).toBeDefined()
    expect(matchIdentEntry!.count).toBe(2)
  })

  it('duplicates list is sorted by count descending', () => {
    // Three layers all referencing get(.class) — most-shared at top.
    const layers: RenderNode[] = []
    for (let i = 0; i < 3; i++) {
      layers.push(makeNode({
        fill: {
          kind: 'data-driven',
          expr: expr(fnCall('match', [field('class')], [
            { pattern: `k${i}`, value: { kind: 'ColorLiteral', value: '#fff' } },
          ])),
        } as ColorValue,
      }))
    }
    // Also add ONE layer with a different field — appears once only.
    layers.push(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [field('rank')], [])),
      } as ColorValue,
    }))
    const report = analyzeCSE(makeScene(...layers))
    // First duplicate should be most-shared — `I(match)` appears 4×,
    // `F(class;~)` 3×, `F(rank;~)` only 1× (not a duplicate).
    expect(report.duplicates[0]!.count).toBeGreaterThanOrEqual(report.duplicates[1]!.count)
    expect(report.duplicates.every(d => d.count > 1)).toBe(true)
  })
})

describe('analyzeCSE — walks every visited paint axis', () => {
  it('filter expression contributes to the walk', () => {
    const report = analyzeCSE(makeScene(makeNode({
      filter: expr(fnCall('eq', [field('admin_level'), num(2)])),
    })))
    // FnCall + Identifier(eq) + FieldAccess(no inner object) +
    // NumberLiteral = 4
    expect(report.totalNodes).toBe(4)
  })

  it('geometry expression contributes', () => {
    const report = analyzeCSE(makeScene(makeNode({
      geometry: expr(fnCall('circle', [field('lon'), field('lat'), num(10)])),
    })))
    expect(report.totalNodes).toBeGreaterThan(0)
  })

  it('opacity PropertyShape data-driven visited', () => {
    const report = analyzeCSE(makeScene(makeNode({
      opacity: {
        kind: 'data-driven',
        expr: expr(fnCall('alphaFor', [field('pop')])),
      } as PropertyShape<number>,
    })))
    expect(report.totalNodes).toBeGreaterThan(0)
    expect(report.entries.find(e => e.key.includes('F(pop'))).toBeDefined()
  })

  it('strokeWidth PropertyShape data-driven visited', () => {
    const report = analyzeCSE(makeScene(makeNode({
      stroke: {
        color: { kind: 'none' },
        width: {
          kind: 'data-driven',
          expr: expr(fnCall('widthFor', [field('class')])),
        } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(report.entries.find(e => e.key.includes('F(class'))).toBeDefined()
  })

  it('size data-driven visited', () => {
    const report = analyzeCSE(makeScene(makeNode({
      size: {
        kind: 'data-driven',
        expr: expr(fnCall('size', [field('rank')])),
      } as SizeValue,
    })))
    expect(report.entries.find(e => e.key.includes('F(rank'))).toBeDefined()
  })

  it('conditional ColorValue branches walk through children', () => {
    const inner = fnCall('match', [field('zone')], [])
    const report = analyzeCSE(makeScene(makeNode({
      fill: {
        kind: 'conditional',
        branches: [
          { field: 'urban', value: { kind: 'data-driven', expr: expr(inner) } },
        ],
        fallback: { kind: 'constant', rgba: RED },
      } as ColorValue,
    })))
    // Inner match → has F(zone;~)
    expect(report.entries.find(e => e.key.includes('F(zone'))).toBeDefined()
  })
})

describe('hasCSEOpportunities', () => {
  it('returns false when no duplicates', () => {
    const report = makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [field('class')], [])),
      } as ColorValue,
    }))
    expect(hasCSEOpportunities(report)).toBe(false)
  })

  it('returns true when at least one duplicate subtree exists', () => {
    const fillExpr = fnCall('match', [field('class')], [])
    const strokeExpr = fnCall('match', [field('class')], [])
    const scene = makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(fillExpr) } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: expr(strokeExpr) } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    }))
    expect(hasCSEOpportunities(scene)).toBe(true)
  })
})
