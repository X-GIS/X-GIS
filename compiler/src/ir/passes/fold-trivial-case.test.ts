// Unit tests for fold-trivial-case. Pin each literal-arm path and
// the identity-preservation invariant.

import { describe, it, expect } from 'vitest'
import { foldTrivialCasePass } from './fold-trivial-case'
import type { Scene, RenderNode, ColorValue, OpacityValue, SizeValue, StrokeWidthValue } from '../render-node'
import type * as AST from '../../parser/ast'

function matchAst(armValues: AST.Expr[]): AST.Expr {
  return {
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'match' },
    args: [],
    matchBlock: {
      kind: 'MatchBlock',
      arms: armValues.map((v, i) => ({ pattern: i === armValues.length - 1 ? '_' : `p${i}`, value: v })),
    },
  } as AST.Expr
}

const COLOR_GREEN: AST.ColorLiteral = { kind: 'ColorLiteral', value: '#00ff00' }
const COLOR_RED: AST.ColorLiteral = { kind: 'ColorLiteral', value: '#ff0000' }
const NUM_5: AST.NumberLiteral = { kind: 'NumberLiteral', value: 5, unit: null }
const NUM_5_PX: AST.NumberLiteral = { kind: 'NumberLiteral', value: 5, unit: 'px' }
const NUM_10: AST.NumberLiteral = { kind: 'NumberLiteral', value: 10, unit: null }

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    name: 'L',
    sourceRef: 'src',
    zOrder: 0,
    fill: { kind: 'constant', rgba: [1, 0, 0, 1] },
    stroke: {
      color: { kind: 'constant', rgba: [0, 0, 0, 1] },
      width: { kind: 'constant', px: 1 },
    },
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'constant', value: 8 },
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: { kind: 'none' } as never,
    ...overrides,
  } as RenderNode
}

function sceneOf(nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes }
}

describe('fold-trivial-case — color match', () => {
  it('folds all-equal ColorLiteral arms to constant', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([COLOR_GREEN, COLOR_GREEN, COLOR_GREEN]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ fill })]))
    expect(out.renderNodes[0]!.fill.kind).toBe('constant')
    expect((out.renderNodes[0]!.fill as { rgba: number[] }).rgba).toEqual([0, 1, 0, 1])
  })

  it('does NOT fold when arm colours differ', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([COLOR_GREEN, COLOR_RED]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ fill })]))
    expect(out.renderNodes[0]!.fill).toBe(fill)
  })
})

describe('fold-trivial-case — opacity match', () => {
  it('folds all-equal NumberLiteral arms to constant', () => {
    const opacity: OpacityValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([NUM_5, NUM_5, NUM_5]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ opacity })]))
    expect(out.renderNodes[0]!.opacity.kind).toBe('constant')
    // 5 > 1, so normalised to 0.05
    expect((out.renderNodes[0]!.opacity as { value: number }).value).toBeCloseTo(0.05, 6)
  })

  it('does NOT fold when arm units differ', () => {
    const opacity: OpacityValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([NUM_5, NUM_5_PX]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ opacity })]))
    expect(out.renderNodes[0]!.opacity).toBe(opacity)
  })
})

describe('fold-trivial-case — size match', () => {
  it('folds all-equal NumberLiteral arms preserving unit', () => {
    const size: SizeValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([NUM_5_PX, NUM_5_PX]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ size })]))
    expect(out.renderNodes[0]!.size.kind).toBe('constant')
    expect((out.renderNodes[0]!.size as { value: number; unit: string }).value).toBe(5)
    expect((out.renderNodes[0]!.size as { value: number; unit: string }).unit).toBe('px')
  })

  it('does NOT fold when arm values differ', () => {
    const size: SizeValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([NUM_5, NUM_10]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ size })]))
    expect(out.renderNodes[0]!.size).toBe(size)
  })
})

describe('fold-trivial-case — stroke width match', () => {
  it('folds all-equal NumberLiteral arms on per-feature width', () => {
    const width: StrokeWidthValue = {
      kind: 'per-feature',
      expr: { ast: matchAst([NUM_5, NUM_5]) },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ stroke: { color: { kind: 'constant', rgba: [0, 0, 0, 1] }, width } })]))
    expect(out.renderNodes[0]!.stroke.width.kind).toBe('constant')
    expect((out.renderNodes[0]!.stroke.width as { px: number }).px).toBe(5)
  })
})

describe('fold-trivial-case — identity preservation', () => {
  it('returns input scene when no folds fire', () => {
    const scene = sceneOf([makeNode(), makeNode({ name: 'L2' })])
    const out = foldTrivialCasePass.run(scene)
    expect(out).toBe(scene)
  })

  it('preserves non-folded paint slots by reference on a partial fold', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: { ast: matchAst([COLOR_GREEN, COLOR_GREEN]) },
    }
    const node = makeNode({ fill })
    const originalStroke = node.stroke
    const out = foldTrivialCasePass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.stroke).toBe(originalStroke)
    expect(out.renderNodes[0]!.fill.kind).toBe('constant')
  })
})

describe('fold-trivial-case — pass metadata', () => {
  it('declares the right name and depends on merge-layers', () => {
    expect(foldTrivialCasePass.name).toBe('fold-trivial-case')
    expect(foldTrivialCasePass.dependencies).toEqual(['merge-layers'])
  })
})

describe('fold-trivial-case — non-match expressions', () => {
  it('does NOT fold a plain data-driven without matchBlock', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: { ast: COLOR_GREEN },
    }
    const out = foldTrivialCasePass.run(sceneOf([makeNode({ fill })]))
    expect(out.renderNodes[0]!.fill).toBe(fill)
  })
})
