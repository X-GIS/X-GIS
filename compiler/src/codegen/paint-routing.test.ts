// ═══════════════════════════════════════════════════════════════════
// paint-routing.ts — route discrimination tests
// ═══════════════════════════════════════════════════════════════════
//
// Asserts the precedence rules:
//   1. none / constant         → inline-constant
//   2. deps includes FEATURE   → compute-feature   (beats ZOOM)
//   3. deps == ZOOM AND palette hit → palette-zoom
//   4. otherwise (TIME, ZOOM+TIME, no palette) → cpu-uniform

import { describe, expect, it } from 'vitest'
import { routeColorValue, routeIsCompute, routeIsPalette, routePropertyShape } from './paint-routing'
import { collectPalette } from './palette'
import type { ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop } from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

const RED: RGBA = [1, 0, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]
const zs = <T,>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })

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

describe('routeColorValue', () => {
  it("kind 'none' → inline-constant", () => {
    const r = routeColorValue({ kind: 'none' })
    expect(r.kind).toBe('inline-constant')
  })

  it("kind 'constant' → inline-constant", () => {
    const r = routeColorValue({ kind: 'constant', rgba: RED })
    expect(r.kind).toBe('inline-constant')
  })

  it('zoom-interpolated with NO palette → cpu-uniform', () => {
    const v: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    expect(routeColorValue(v).kind).toBe('cpu-uniform')
  })

  it('zoom-interpolated WITH palette hit → palette-zoom + gradientIndex', () => {
    const v: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const palette = collectPalette({
      sources: [], symbols: [],
      renderNodes: [makeNode({ fill: v })],
    } as Scene)
    const r = routeColorValue(v, palette)
    expect(r.kind).toBe('palette-zoom')
    if (r.kind === 'palette-zoom') {
      expect(r.gradientIndex).toBe(0)
    }
  })

  it('zoom-interpolated WITH palette MISS (palette built from different scene) → cpu-uniform', () => {
    const sceneV: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const otherV: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, BLUE), zs(10, RED)] }
    const palette = collectPalette({
      sources: [], symbols: [],
      renderNodes: [makeNode({ fill: sceneV })],
    } as Scene)
    expect(routeColorValue(otherV, palette).kind).toBe('cpu-uniform')
  })

  it('time-interpolated → cpu-uniform (TIME deps, no palette path)', () => {
    const v: ColorValue = {
      kind: 'time-interpolated',
      base: RED,
      stops: [{ timeMs: 0, value: RED }, { timeMs: 1000, value: BLUE }],
      loop: false, easing: 'linear', delayMs: 0,
    }
    expect(routeColorValue(v).kind).toBe('cpu-uniform')
  })

  it('data-driven match() → compute-feature', () => {
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [{ kind: 'FieldAccess', object: null as never, field: 'class' }],
        matchBlock: { arms: [] } as never,
      } as never,
    }
    const r = routeColorValue({ kind: 'data-driven', expr })
    expect(r.kind).toBe('compute-feature')
  })

  it('data-driven WITH palette provided still routes to compute-feature (FEATURE beats ZOOM)', () => {
    // Precedence rule: FEATURE in deps trumps palette eligibility.
    // The palette atlas is for zoom-only gradients; per-feature
    // colour needs the compute kernel even when a stop-based palette
    // happens to exist for unrelated layers in the same Scene.
    const expr: DataExpr = {
      ast: { kind: 'FieldAccess', object: null as never, field: 'class' } as never,
    }
    const zoomColor: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const palette = collectPalette({
      sources: [], symbols: [],
      renderNodes: [makeNode({ fill: zoomColor })],
    } as Scene)
    expect(routeColorValue({ kind: 'data-driven', expr }, palette).kind)
      .toBe('compute-feature')
  })

  it('conditional ColorValue (FEATURE-dep by definition) → compute-feature', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'school', value: { kind: 'constant', rgba: RED } },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    expect(routeColorValue(v).kind).toBe('compute-feature')
  })
})

describe('routePropertyShape', () => {
  it('constant → inline-constant', () => {
    const r = routePropertyShape<number>({ kind: 'constant', value: 0.5 })
    expect(r.kind).toBe('inline-constant')
  })

  it('zoom-interpolated scalar → cpu-uniform (no scalar palette yet)', () => {
    const r = routePropertyShape<number>({
      kind: 'zoom-interpolated',
      stops: [zs(0, 0), zs(20, 1)],
    })
    expect(r.kind).toBe('cpu-uniform')
  })

  it('time-interpolated scalar → cpu-uniform', () => {
    const r = routePropertyShape<number>({
      kind: 'time-interpolated',
      stops: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 1 }],
      loop: false, easing: 'linear', delayMs: 0,
    })
    expect(r.kind).toBe('cpu-uniform')
  })

  it('data-driven scalar → compute-feature', () => {
    const r = routePropertyShape<number>({
      kind: 'data-driven',
      expr: { ast: { kind: 'FieldAccess', object: null as never, field: 'rank' } as never },
    })
    expect(r.kind).toBe('compute-feature')
  })

  it('zoom-time scalar → cpu-uniform (no GPU path for composite ZOOM+TIME yet)', () => {
    const r = routePropertyShape<number>({
      kind: 'zoom-time',
      zoomStops: [zs(0, 0), zs(20, 1)],
      timeStops: [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 1 }],
      loop: false, easing: 'linear', delayMs: 0,
    })
    expect(r.kind).toBe('cpu-uniform')
  })
})

describe('predicates', () => {
  it('routeIsCompute', () => {
    expect(routeIsCompute({ kind: 'compute-feature', deps: 4 })).toBe(true)
    expect(routeIsCompute({ kind: 'inline-constant', deps: 0 })).toBe(false)
    expect(routeIsCompute({ kind: 'palette-zoom', gradientIndex: 0, deps: 1 })).toBe(false)
    expect(routeIsCompute({ kind: 'cpu-uniform', deps: 2 })).toBe(false)
  })

  it('routeIsPalette', () => {
    expect(routeIsPalette({ kind: 'palette-zoom', gradientIndex: 0, deps: 1 })).toBe(true)
    expect(routeIsPalette({ kind: 'compute-feature', deps: 4 })).toBe(false)
    expect(routeIsPalette({ kind: 'cpu-uniform', deps: 2 })).toBe(false)
    expect(routeIsPalette({ kind: 'inline-constant', deps: 0 })).toBe(false)
  })
})

describe('end-to-end Scene routing', () => {
  it('scene with mixed paint axes routes each correctly', () => {
    const fillV: ColorValue = { kind: 'constant', rgba: RED }
    const strokeV: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const opacityV: PropertyShape<number> = {
      kind: 'data-driven',
      expr: { ast: { kind: 'FieldAccess', object: null as never, field: 'pop' } as never },
    }
    const node = makeNode({
      fill: fillV,
      stroke: {
        color: strokeV,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
      opacity: opacityV,
    })
    const palette = collectPalette({ sources: [], symbols: [], renderNodes: [node] } as Scene)

    expect(routeColorValue(fillV, palette).kind).toBe('inline-constant')
    expect(routeColorValue(strokeV, palette).kind).toBe('palette-zoom')
    expect(routePropertyShape(opacityV).kind).toBe('compute-feature')
  })
})
