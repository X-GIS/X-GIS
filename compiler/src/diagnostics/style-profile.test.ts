// ═══════════════════════════════════════════════════════════════════
// style-profile.ts — Scene compile-time profile diagnostic tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { getStyleProfile, formatStyleProfile } from './style-profile'
import type {
  ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop,
} from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'
import { Dep } from '../ir/deps'

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

describe('getStyleProfile — basic shape', () => {
  it('empty scene → renderNodes=0, all counters zero', () => {
    const p = getStyleProfile(makeScene())
    expect(p.renderNodes).toBe(0)
    expect(p.cse.totalNodes).toBe(0)
    expect(p.cse.unique).toBe(0)
    expect(p.computePlan.entries).toBe(0)
    expect(p.computePlan.uniqueKernels).toBe(0)
    expect(p.palette.colors).toBe(0)
    expect(p.matchArmBands.every(b => b.count === 0)).toBe(true)
  })

  it('renderNodes count matches scene', () => {
    const p = getStyleProfile(makeScene(makeNode(), makeNode(), makeNode()))
    expect(p.renderNodes).toBe(3)
  })
})

describe('getStyleProfile — dep histogram', () => {
  it('all-constant scene → only `none` band populated', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    const noneRow = p.depHistogram.find(r => r.bits === Dep.NONE)
    expect(noneRow).toBeDefined()
    expect(noneRow!.count).toBeGreaterThan(0)
    // No other labels should appear (filtered to count > 0 or NONE).
    const zoomRow = p.depHistogram.find(r => r.bits === Dep.ZOOM)
    expect(zoomRow).toBeUndefined()
  })

  it('zoom-interpolated fill → `zoom` band populated', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
    })))
    const zoomRow = p.depHistogram.find(r => r.bits === Dep.ZOOM)
    expect(zoomRow?.count).toBe(1)
  })

  it('data-driven fill → `feature` band populated', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: matchAst('class', [{ pattern: 'a', hex: '#ff0000' }]),
      },
    })))
    const featRow = p.depHistogram.find(r => r.bits === Dep.FEATURE)
    expect(featRow?.count).toBe(1)
  })
})

describe('getStyleProfile — CSE summary', () => {
  it('reports redundancy percent for duplicates', () => {
    const fillExpr = matchAst('class', [{ pattern: 'a', hex: '#ff0000' }])
    const strokeExpr = matchAst('class', [{ pattern: 'b', hex: '#00ff00' }])
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: fillExpr } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: strokeExpr } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(p.cse.totalNodes).toBeGreaterThan(0)
    expect(p.cse.duplicates).toBeGreaterThan(0)
    expect(p.cse.redundancyPercent).toBeGreaterThan(0)
    expect(p.cse.redundancyPercent).toBeLessThanOrEqual(100)
  })

  it('topDuplicates capped at 8', () => {
    // Build a scene with many distinct duplicate patterns.
    const nodes: RenderNode[] = []
    for (let i = 0; i < 12; i++) {
      const fillExpr = matchAst(`field_${i}`, [{ pattern: 'x', hex: '#ff0000' }])
      const strokeExpr = matchAst(`field_${i}`, [{ pattern: 'x', hex: '#00ff00' }])
      nodes.push(makeNode({
        fill: { kind: 'data-driven', expr: fillExpr } as ColorValue,
        stroke: {
          color: { kind: 'data-driven', expr: strokeExpr } as ColorValue,
          width: { kind: 'constant', value: 1 } as PropertyShape<number>,
        } as StrokeValue,
      }))
    }
    const p = getStyleProfile(makeScene(...nodes))
    expect(p.cse.topDuplicates.length).toBeLessThanOrEqual(8)
  })

  it('empty scene → zero redundancy, no duplicates', () => {
    const p = getStyleProfile(makeScene())
    expect(p.cse.redundancyPercent).toBe(0)
    expect(p.cse.duplicates).toBe(0)
    expect(p.cse.topDuplicates).toEqual([])
  })
})

describe('getStyleProfile — compute plan dedup', () => {
  it('two paint axes with identical match() share one kernel', () => {
    const sameMatch = (): ColorValue => ({
      kind: 'data-driven',
      expr: matchAst('class', [
        { pattern: 'school', hex: '#aaaaaa' },
        { pattern: '_',      hex: '#000000' },
      ]),
    })
    const p = getStyleProfile(makeScene(makeNode({
      fill: sameMatch(),
      stroke: {
        color: sameMatch(),
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    expect(p.computePlan.entries).toBe(2)
    expect(p.computePlan.uniqueKernels).toBe(1)
  })

  it('two distinct match() ASTs → 2 unique kernels', () => {
    const p = getStyleProfile(makeScene(
      makeNode({ fill: { kind: 'data-driven', expr: matchAst('a', [{ pattern: 'x', hex: '#ff0000' }]) } }),
      makeNode({ fill: { kind: 'data-driven', expr: matchAst('b', [{ pattern: 'x', hex: '#00ff00' }]) } }),
    ))
    expect(p.computePlan.entries).toBe(2)
    expect(p.computePlan.uniqueKernels).toBe(2)
  })
})

describe('getStyleProfile — palette', () => {
  it('zoom-interpolated fill → registers a color gradient', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] },
    })))
    expect(p.palette.colorGradients).toBeGreaterThanOrEqual(1)
  })

  it('constant fill → registers a flat color', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    expect(p.palette.colors).toBeGreaterThanOrEqual(1)
  })
})

describe('getStyleProfile — match arm bands', () => {
  it('small match (3 arms) → 1..3 band', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: {
        kind: 'data-driven',
        expr: matchAst('class', [
          { pattern: 'a', hex: '#ff0000' },
          { pattern: 'b', hex: '#00ff00' },
          { pattern: 'c', hex: '#0000ff' },
        ]),
      },
    })))
    const band = p.matchArmBands.find(b => b.min === 1)
    expect(band?.count).toBe(1)
  })

  it('large match (20 arms) → 16..31 band', () => {
    const arms = Array.from({ length: 20 }, (_, i) => ({
      pattern: `k${i}`, hex: '#ffffff',
    }))
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: matchAst('class', arms) },
    })))
    const band = p.matchArmBands.find(b => b.min === 16)
    expect(band?.count).toBe(1)
  })

  it('huge match (50 arms) → 32+ band', () => {
    const arms = Array.from({ length: 50 }, (_, i) => ({
      pattern: `k${i}`, hex: '#ffffff',
    }))
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: matchAst('class', arms) },
    })))
    const band = p.matchArmBands.find(b => b.min === 32 && b.max === null)
    expect(band?.count).toBe(1)
  })
})

describe('formatStyleProfile — string output', () => {
  it('produces a non-empty multi-line summary', () => {
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'constant', rgba: RED },
    })))
    const text = formatStyleProfile(p)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('Style profile')
    expect(text).toContain('Dep histogram')
    expect(text).toContain('CSE:')
    expect(text).toContain('Compute plan:')
    expect(text).toContain('Palette:')
    expect(text).toContain('Match arm bands')
  })

  it('includes top-duplicate lines when duplicates exist', () => {
    const fillExpr = matchAst('class', [{ pattern: 'a', hex: '#ff0000' }])
    const strokeExpr = matchAst('class', [{ pattern: 'b', hex: '#00ff00' }])
    const p = getStyleProfile(makeScene(makeNode({
      fill: { kind: 'data-driven', expr: fillExpr } as ColorValue,
      stroke: {
        color: { kind: 'data-driven', expr: strokeExpr } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })))
    const text = formatStyleProfile(p)
    expect(text).toContain('Top duplicates')
  })
})
