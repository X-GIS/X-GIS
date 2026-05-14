// ═══════════════════════════════════════════════════════════════════
// annotate-deps.ts — Scene-wide dependency annotation tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { annotateDeps, fillIsZoomOnly, hasFeatureDep } from './annotate-deps'
import type {
  ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop,
} from '../render-node'
import type { PropertyShape, RGBA } from '../property-types'
import { Dep } from '../deps'

const RED: RGBA = [1, 0, 0, 1]
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
  } as DataExpr
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

function makeScene(...nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('annotateDeps — basic shape', () => {
  it('empty scene → empty annotation', () => {
    const ann = annotateDeps(makeScene())
    expect(ann.byNode).toEqual([])
    expect(ann.histogram).toEqual({})
  })

  it('byNode length matches scene.renderNodes.length', () => {
    const ann = annotateDeps(makeScene(makeNode(), makeNode(), makeNode()))
    expect(ann.byNode.length).toBe(3)
  })

  it('all-constant scene → every entry has bits === Dep.NONE', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    expect(ann.byNode[0]!.fill?.bits).toBe(Dep.NONE)
    expect(ann.byNode[0]!.opacity?.bits).toBe(Dep.NONE)
    expect(ann.byNode[0]!.strokeWidth?.bits).toBe(Dep.NONE)
  })
})

describe('annotateDeps — color axes', () => {
  it('zoom-interpolated fill → bits === Dep.ZOOM', () => {
    const fill: ColorValue = {
      kind: 'zoom-interpolated',
      stops: [zs(0, RED), zs(20, BLUE)],
    }
    const ann = annotateDeps(makeScene(makeNode({ fill })))
    expect(ann.byNode[0]!.fill?.bits).toBe(Dep.ZOOM)
  })

  it('data-driven match() fill → bits has FEATURE bit', () => {
    const fill: ColorValue = {
      kind: 'data-driven',
      expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
    }
    const ann = annotateDeps(makeScene(makeNode({ fill })))
    expect((ann.byNode[0]!.fill?.bits ?? 0) & Dep.FEATURE).toBe(Dep.FEATURE)
  })

  it('kind: none fill → no `fill` entry in the node annotation', () => {
    const ann = annotateDeps(makeScene(makeNode({ fill: { kind: 'none' } })))
    expect(ann.byNode[0]!.fill).toBeUndefined()
  })

  it('stroke color separately tracked from fill', () => {
    const fill: ColorValue = { kind: 'constant', rgba: RED }
    const strokeColor: ColorValue = {
      kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)],
    }
    const ann = annotateDeps(makeScene(makeNode({
      fill,
      stroke: {
        color: strokeColor,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(ann.byNode[0]!.fill?.bits).toBe(Dep.NONE)
    expect(ann.byNode[0]!.strokeColor?.bits).toBe(Dep.ZOOM)
  })
})

describe('annotateDeps — numeric axes always present', () => {
  it('constant opacity contributes to histogram', () => {
    const ann = annotateDeps(makeScene(makeNode()))
    // Default node has opacity + strokeWidth both constant.
    expect(ann.byNode[0]!.opacity?.bits).toBe(Dep.NONE)
    expect(ann.byNode[0]!.strokeWidth?.bits).toBe(Dep.NONE)
  })

  it('zoom-interpolated strokeWidth → bits === Dep.ZOOM', () => {
    const ann = annotateDeps(makeScene(makeNode({
      stroke: {
        color: { kind: 'none' },
        width: {
          kind: 'zoom-interpolated',
          stops: [zs(10, 1), zs(20, 5)],
        } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(ann.byNode[0]!.strokeWidth?.bits).toBe(Dep.ZOOM)
  })
})

describe('annotateDeps — DataExpr axes', () => {
  it('filter expression recorded with FEATURE bits', () => {
    const ann = annotateDeps(makeScene(makeNode({
      filter: { ast: fieldAccess('class') as never },
    })))
    expect(ann.byNode[0]!.filter).toBeDefined()
    expect((ann.byNode[0]!.filter?.bits ?? 0) & Dep.FEATURE).toBe(Dep.FEATURE)
  })

  it('null filter → no `filter` entry', () => {
    const ann = annotateDeps(makeScene(makeNode({ filter: null })))
    expect(ann.byNode[0]!.filter).toBeUndefined()
  })
})

describe('annotateDeps — histogram', () => {
  it('counts NONE entries from constants', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    // fill(NONE) + opacity(NONE) + strokeWidth(NONE) = 3
    expect(ann.histogram[String(Dep.NONE)]).toBe(3)
  })

  it('counts ZOOM entries from zoom-interpolated fill + strokeWidth', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'zoom-interpolated', stops: [zs(0, 1), zs(20, 5)] } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(ann.histogram[String(Dep.ZOOM)]).toBe(2)
  })

  it('multi-node histogram aggregates across the scene', () => {
    const fillConst: ColorValue = { kind: 'constant', rgba: RED }
    const fillZoom: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const ann = annotateDeps(makeScene(
      makeNode({ fill: fillConst }),
      makeNode({ fill: fillConst }),
      makeNode({ fill: fillZoom }),
    ))
    // Each node has fill(?) + opacity(NONE) + strokeWidth(NONE) entries.
    // Two const fills + 3 nodes × {opacity, strokeWidth} all NONE = 8 NONE.
    expect(ann.histogram[String(Dep.NONE)]).toBe(8)
    // One zoom fill = 1 ZOOM.
    expect(ann.histogram[String(Dep.ZOOM)]).toBe(1)
  })
})

describe('annotateDeps — convenience predicates', () => {
  it('fillIsZoomOnly: constant fill → true', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    expect(fillIsZoomOnly(ann.byNode[0]!)).toBe(true)
  })

  it('fillIsZoomOnly: zoom-interpolated → true', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
    })))
    expect(fillIsZoomOnly(ann.byNode[0]!)).toBe(true)
  })

  it('fillIsZoomOnly: data-driven match() → false', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
      },
    })))
    expect(fillIsZoomOnly(ann.byNode[0]!)).toBe(false)
  })

  it('fillIsZoomOnly: absent fill → true (vacuous)', () => {
    const ann = annotateDeps(makeScene(makeNode()))
    expect(fillIsZoomOnly(ann.byNode[0]!)).toBe(true)
  })

  it('hasFeatureDep: all-constant node → false', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    expect(hasFeatureDep(ann.byNode[0]!)).toBe(false)
  })

  it('hasFeatureDep: data-driven fill → true', () => {
    const ann = annotateDeps(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
      },
    })))
    expect(hasFeatureDep(ann.byNode[0]!)).toBe(true)
  })

  it('hasFeatureDep: filter only → true', () => {
    const ann = annotateDeps(makeScene(makeNode({
      filter: { ast: fieldAccess('admin_level') as never },
    })))
    expect(hasFeatureDep(ann.byNode[0]!)).toBe(true)
  })
})

describe('annotateDeps — purity', () => {
  it('does not mutate the input scene', () => {
    const scene = makeScene(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
    }))
    const before = JSON.stringify(scene)
    annotateDeps(scene)
    expect(JSON.stringify(scene)).toBe(before)
  })
})
