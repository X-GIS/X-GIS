// ═══════════════════════════════════════════════════════════════════
// compute-plan.ts — Scene → ComputeKernel plan tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { planComputeKernels } from './compute-plan'
import type {
  ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop,
} from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

const RED: RGBA = [1, 0, 0, 1]
const GREEN: RGBA = [0, 1, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]
const zs = <T,>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })

function fieldAccess(name: string) {
  return { kind: 'FieldAccess' as const, object: null, field: name }
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
          value: { kind: 'ColorLiteral' as const, value: a.hex },
        })),
      },
    },
  }
}

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  return {
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
    ...overrides,
  }
}

function makeScene(nodes: RenderNode[]): Scene {
  return { sources: [], symbols: [], renderNodes: nodes } as Scene
}

describe('planComputeKernels', () => {
  it('empty scene → empty plan', () => {
    expect(planComputeKernels(makeScene([]))).toEqual([])
  })

  it('all-constant scene → empty plan (no FEATURE deps)', () => {
    const scene = makeScene([
      makeNode({ fill: { kind: 'constant', rgba: RED } }),
    ])
    expect(planComputeKernels(scene)).toEqual([])
  })

  it('zoom-interpolated fill → empty plan (palette/cpu, not compute)', () => {
    const fill: ColorValue = {
      kind: 'zoom-interpolated',
      stops: [zs(0, RED), zs(20, BLUE)],
    }
    expect(planComputeKernels(makeScene([makeNode({ fill })]))).toEqual([])
  })

  it('conditional fill → one entry on fill axis (ternary kernel)', () => {
    const fill: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'school', value: { kind: 'constant', rgba: RED } }],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const plan = planComputeKernels(makeScene([makeNode({ fill })]))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.renderNodeIndex).toBe(0)
    expect(plan[0]!.paintAxis).toBe('fill')
    expect(plan[0]!.kernel.entryPoint).toBe('eval_case')
    expect(plan[0]!.fieldOrder).toEqual(['school'])
  })

  it('data-driven match() fill → one entry on fill axis (match kernel)', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('class', [
        { pattern: 'school', hex: '#f0e8f8' },
        { pattern: '_',      hex: '#888888' },
      ]),
    }
    const plan = planComputeKernels(makeScene([makeNode({ fill })]))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.paintAxis).toBe('fill')
    expect(plan[0]!.kernel.entryPoint).toBe('eval_match')
    expect(plan[0]!.fieldOrder).toEqual(['class'])
  })

  it('stroke color compute path → entry on stroke-color axis', () => {
    const strokeColor: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('rank', [{ pattern: 'a', hex: '#ff0000' }]),
    }
    const plan = planComputeKernels(makeScene([
      makeNode({
        stroke: {
          color: strokeColor,
          width: { kind: 'constant', value: 1 } as PropertyShape<number>,
        } as StrokeValue,
      }),
    ]))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.paintAxis).toBe('stroke-color')
  })

  it('fill + stroke both compute → two entries with correct indices and axes', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
    }
    const strokeColor: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'border', value: { kind: 'constant', rgba: GREEN } }],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const node = makeNode({
      fill,
      stroke: {
        color: strokeColor,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })
    const plan = planComputeKernels(makeScene([node]))
    expect(plan).toHaveLength(2)
    expect(plan[0]!.paintAxis).toBe('fill')
    expect(plan[1]!.paintAxis).toBe('stroke-color')
    expect(plan[0]!.renderNodeIndex).toBe(0)
    expect(plan[1]!.renderNodeIndex).toBe(0)
  })

  it('multiple nodes get independent entries with correct renderNodeIndex', () => {
    const fillA: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
    }
    const fillB: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'x', value: { kind: 'constant', rgba: RED } }],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const plan = planComputeKernels(makeScene([
      makeNode({ fill: fillA }),
      makeNode({ fill: fillB }),
    ]))
    expect(plan).toHaveLength(2)
    expect(plan[0]!.renderNodeIndex).toBe(0)
    expect(plan[0]!.kernel.entryPoint).toBe('eval_match')
    expect(plan[1]!.renderNodeIndex).toBe(1)
    expect(plan[1]!.kernel.entryPoint).toBe('eval_case')
  })

  it('data-driven fill with non-loweable AST → dropped from plan (router said yes, lowering said no)', () => {
    // FieldAccess alone — no match() block. Router classifies as
    // compute-feature (it sees FEATURE in deps), but the lowering
    // can't produce a kernel spec because the shape isn't a
    // recognised match() / case() pattern. Expected behaviour:
    // silently dropped, runtime falls back to inline-fragment emit.
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: { ast: fieldAccess('class') as never },
    }
    expect(planComputeKernels(makeScene([makeNode({ fill })]))).toEqual([])
  })

  it('conditional with non-constant fallback → dropped from plan', () => {
    const fill: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'x', value: { kind: 'constant', rgba: RED } }],
      fallback: { kind: 'none' },
    }
    expect(planComputeKernels(makeScene([makeNode({ fill })]))).toEqual([])
  })

  it('mixed scene: 3 nodes (constant, compute, palette) → 1 entry from node 1 only', () => {
    const constNode = makeNode({ fill: { kind: 'constant', rgba: RED } })
    const computeNode = makeNode({
      fill: {
        kind: 'data-driven',
        expr: matchAst('cls', [{ pattern: 'a', hex: '#ff0000' }]),
      },
    })
    const paletteNode = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
    })
    const plan = planComputeKernels(makeScene([constNode, computeNode, paletteNode]))
    expect(plan).toHaveLength(1)
    expect(plan[0]!.renderNodeIndex).toBe(1)
  })

  it('fieldOrder lifted from kernel.fieldOrder', () => {
    const fill: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'a', value: { kind: 'constant', rgba: RED } },
        { field: 'b', value: { kind: 'constant', rgba: GREEN } },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const plan = planComputeKernels(makeScene([makeNode({ fill })]))
    expect(plan[0]!.fieldOrder).toEqual(plan[0]!.kernel.fieldOrder)
    expect(plan[0]!.fieldOrder).toEqual(['a', 'b'])
  })

  it('match entry exposes categoryOrder with sorted patterns per field', () => {
    // Use 7-char hex literals — resolveColorOfAST mirrors shader-
    // gen and rejects 3-char short form.
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('class', [
        { pattern: 'school',   hex: '#aaaaaa' },
        { pattern: 'cemetery', hex: '#bbbbbb' },
        { pattern: 'hospital', hex: '#cccccc' },
        { pattern: '_',        hex: '#000000' },
      ]),
    }
    const plan = planComputeKernels(makeScene([makeNode({ fill })]))
    expect(plan[0]!.categoryOrder['class']).toEqual(['cemetery', 'hospital', 'school'])
  })

  it('conditional entry has empty categoryOrder (numeric predicates only)', () => {
    const fill: ColorValue = {
      kind: 'conditional',
      branches: [{ field: 'x', value: { kind: 'constant', rgba: RED } }],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const plan = planComputeKernels(makeScene([makeNode({ fill })]))
    expect(plan[0]!.categoryOrder).toEqual({})
  })
})
