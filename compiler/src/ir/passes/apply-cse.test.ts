// ═══════════════════════════════════════════════════════════════════
// apply-cse.ts — side-table annotation tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { applyCSE, applyCSEFromReport, sameCSE } from './apply-cse'
import { analyzeCSE } from './cse'
import type {
  ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue,
} from '../render-node'
import type { PropertyShape, RGBA } from '../property-types'
import type { Expr } from '../../parser/ast'

const RED: RGBA = [1, 0, 0, 1]

const ident = (name: string): Expr => ({ kind: 'Identifier' as const, name })
const field = (f: string): Expr => ({
  kind: 'FieldAccess' as const, field: f, object: null,
})
const colorLit = (value: string): Expr => ({ kind: 'ColorLiteral' as const, value })
const fnCall = (
  calleeName: string,
  args: Expr[],
  matchArms: Array<{ pattern: string; value: Expr }> = [],
): Expr => ({
  kind: 'FnCall' as const,
  callee: ident(calleeName),
  args,
  matchBlock: matchArms.length > 0
    ? { kind: 'MatchBlock' as const, arms: matchArms }
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

describe('applyCSE — basic shape', () => {
  it('empty scene → empty annotation', () => {
    const ann = applyCSE(makeScene())
    expect(ann.uniqueCount).toBe(0)
    expect(ann.totalNodes).toBe(0)
    expect(ann.canonicalById.size).toBe(0)
  })

  it('singleton subtree → still gets an id (every visited node has one)', () => {
    const ast = field('class')
    const ann = applyCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast) } as ColorValue,
    })))
    // The AST is just a single FieldAccess, no children. One unique
    // node, one id.
    expect(ann.uniqueCount).toBe(1)
    expect(ann.cseIdByExpr.get(ast)).toBe(0)
    expect(ann.canonicalById.get(0)).toMatch(/F\(class/)
  })

  it('duplicate F(class) on fill + stroke → both nodes share an id', () => {
    const fillField = field('class')
    const strokeField = field('class')
    const ast1 = fnCall('match', [fillField], [
      { pattern: 'a', value: colorLit('#aaa') },
    ])
    const ast2 = fnCall('match', [strokeField], [
      { pattern: 'b', value: colorLit('#bbb') },
    ])
    const ann = applyCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(ast1) } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: expr(ast2) } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    const id1 = ann.cseIdByExpr.get(fillField)
    const id2 = ann.cseIdByExpr.get(strokeField)
    expect(id1).toBeDefined()
    expect(id2).toBeDefined()
    expect(id1).toBe(id2)
  })

  it('distinct canonical strings → distinct ids', () => {
    const classField = field('class')
    const rankField = field('rank')
    const ann = applyCSE(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [classField], [])),
      } as ColorValue,
      stroke: {
        color: {
          kind: 'data-driven',
          expr: expr(fnCall('match', [rankField], [])),
        } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    const idClass = ann.cseIdByExpr.get(classField)
    const idRank = ann.cseIdByExpr.get(rankField)
    expect(idClass).toBeDefined()
    expect(idRank).toBeDefined()
    expect(idClass).not.toBe(idRank)
  })
})

describe('applyCSE — uniqueCount + canonicalById consistency', () => {
  it('uniqueCount equals canonicalById.size', () => {
    const ann = applyCSE(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [field('class')], [
          { pattern: 'a', value: colorLit('#aaa') },
          { pattern: 'b', value: colorLit('#bbb') },
        ])),
      } as ColorValue,
    })))
    expect(ann.uniqueCount).toBe(ann.canonicalById.size)
  })

  it('every assigned id has a canonical string', () => {
    const ann = applyCSE(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [field('class')], [])),
      } as ColorValue,
    })))
    for (let i = 0; i < ann.uniqueCount; i++) {
      expect(ann.canonicalById.has(i)).toBe(true)
      expect(typeof ann.canonicalById.get(i)).toBe('string')
    }
  })

  it('totalNodes matches the report', () => {
    const scene = makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [field('class')], [
          { pattern: 'a', value: colorLit('#aaa') },
        ])),
      } as ColorValue,
    }))
    const report = analyzeCSE(scene)
    const ann = applyCSEFromReport(report)
    expect(ann.totalNodes).toBe(report.totalNodes)
  })
})

describe('applyCSE — id ordering', () => {
  it('higher-count duplicates get lower ids (report is count-descending)', () => {
    // Three layers all sharing F(class), one layer with F(rank).
    const classFields: Expr[] = []
    const rankField = field('rank')
    const layers: RenderNode[] = []
    for (let i = 0; i < 3; i++) {
      const f = field('class')
      classFields.push(f)
      layers.push(makeNode({
        fill: {
          kind: 'data-driven',
          expr: expr(fnCall('match', [f], [])),
        } as ColorValue,
      }))
    }
    layers.push(makeNode({
      fill: {
        kind: 'data-driven',
        expr: expr(fnCall('match', [rankField], [])),
      } as ColorValue,
    }))
    const ann = applyCSE(makeScene(...layers))
    const classId = ann.cseIdByExpr.get(classFields[0]!)
    const rankId = ann.cseIdByExpr.get(rankField)
    expect(classId).toBeDefined()
    expect(rankId).toBeDefined()
    // F(class;~) appears 3× (heavier), F(rank;~) once — heavier gets
    // smaller id.
    expect(classId).toBeLessThan(rankId!)
  })
})

describe('sameCSE predicate', () => {
  it('returns true for two nodes with the same canonical key', () => {
    const f1 = field('class')
    const f2 = field('class')
    const ann = applyCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(fnCall('match', [f1], [])) } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: expr(fnCall('match', [f2], [])) } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(sameCSE(ann, f1, f2)).toBe(true)
  })

  it('returns false for two nodes with different canonical keys', () => {
    const f1 = field('class')
    const f2 = field('rank')
    const ann = applyCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(fnCall('match', [f1], [])) } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: expr(fnCall('match', [f2], [])) } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(sameCSE(ann, f1, f2)).toBe(false)
  })

  it('returns false when one node is not in the annotation', () => {
    const f1 = field('class')
    const orphan = field('class')  // built independently; same canonical, different reference
    const ann = applyCSE(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: expr(fnCall('match', [f1], [])) } as ColorValue,
    })))
    // Orphan was never walked → no entry → predicate is false even
    // though the canonical strings match.
    expect(sameCSE(ann, f1, orphan)).toBe(false)
  })
})

describe('applyCSE — purity', () => {
  it('does not mutate the input scene', () => {
    const fillField = field('class')
    const node = makeNode({
      fill: { kind: 'data-driven', expr: expr(fnCall('match', [fillField], [])) } as ColorValue,
    })
    const scene = makeScene(node)
    const before = JSON.stringify(scene)
    applyCSE(scene)
    expect(JSON.stringify(scene)).toBe(before)
  })
})
