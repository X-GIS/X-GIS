// ═══════════════════════════════════════════════════════════════════
// palette.ts — Scene-level literal pool collector tests
// ═══════════════════════════════════════════════════════════════════
//
// Locks in deduplication semantics, gradient indexing, and the
// "skip ineligible kinds" rules. Each test constructs a minimal
// Scene with exactly the RenderNode shapes it cares about — no
// dependency on the lower pass or the parser.

import { describe, expect, it } from 'vitest'
import { collectPalette, emptyPalette, type ColorGradient } from './palette'
import type { ColorValue, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop } from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

const RED: RGBA = [1, 0, 0, 1]
const GREEN: RGBA = [0, 1, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]

const zs = <T,>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })

function makeNode(
  name: string,
  overrides: Partial<RenderNode> = {},
): RenderNode {
  const base: RenderNode = {
    name,
    sourceRef: 's',
    zOrder: 0,
    fill: { kind: 'none' },
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: { kind: 'named', name: 'circle' } as never,
  }
  return { ...base, ...overrides }
}

function makeScene(...nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('palette — collectPalette', () => {
  it('empty scene → empty palette', () => {
    const p = collectPalette(makeScene())
    expect(p.colors).toHaveLength(0)
    expect(p.scalars).toHaveLength(0)
    expect(p.colorGradients).toHaveLength(0)
    expect(p.scalarGradients).toHaveLength(0)
  })

  it('emptyPalette() is genuinely empty', () => {
    const p = emptyPalette()
    expect(p.colors).toHaveLength(0)
    expect(p.findColor(RED)).toBe(-1)
  })

  it('constant fill → 1 color', () => {
    const scene = makeScene(makeNode('a', {
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    }))
    const p = collectPalette(scene)
    expect(p.colors).toEqual([RED])
    expect(p.findColor(RED)).toBe(0)
  })

  it('deduplicates identical colors across multiple nodes', () => {
    const scene = makeScene(
      makeNode('a', { fill: { kind: 'constant', rgba: RED } as ColorValue }),
      makeNode('b', { fill: { kind: 'constant', rgba: RED } as ColorValue }),
      makeNode('c', { fill: { kind: 'constant', rgba: BLUE } as ColorValue }),
    )
    const p = collectPalette(scene)
    expect(p.colors).toHaveLength(2)
    expect(p.findColor(RED)).toBe(0)
    expect(p.findColor(BLUE)).toBe(1)
  })

  it('zoom-interpolated color → 1 gradient + stop values added to color pool', () => {
    const scene = makeScene(makeNode('a', {
      fill: {
        kind: 'zoom-interpolated',
        stops: [zs(2, RED), zs(10, BLUE)],
      } as ColorValue,
    }))
    const p = collectPalette(scene)
    expect(p.colorGradients).toHaveLength(1)
    expect(p.colorGradients[0]!.stops).toHaveLength(2)
    // Stop values automatically pulled into the color pool — lets a
    // future folding pass replace a single-stop gradient with the
    // constant via the same palette index.
    expect(p.colors).toContainEqual(RED)
    expect(p.colors).toContainEqual(BLUE)
  })

  it('two identical zoom gradients dedup to one index', () => {
    const grad = {
      kind: 'zoom-interpolated' as const,
      stops: [zs(2, RED), zs(10, BLUE)],
    }
    const scene = makeScene(
      makeNode('a', { fill: grad as ColorValue }),
      makeNode('b', { fill: grad as ColorValue }),
    )
    const p = collectPalette(scene)
    expect(p.colorGradients).toHaveLength(1)
  })

  it('different base (curve) → distinct gradients', () => {
    const scene = makeScene(
      makeNode('a', {
        fill: {
          kind: 'zoom-interpolated',
          stops: [zs(2, RED), zs(10, BLUE)],
          base: 1,
        } as ColorValue,
      }),
      makeNode('b', {
        fill: {
          kind: 'zoom-interpolated',
          stops: [zs(2, RED), zs(10, BLUE)],
          base: 1.5,
        } as ColorValue,
      }),
    )
    const p = collectPalette(scene)
    expect(p.colorGradients).toHaveLength(2)
  })

  it('time-interpolated color contributes base → 1 color, no gradient', () => {
    const scene = makeScene(makeNode('a', {
      fill: {
        kind: 'time-interpolated',
        base: GREEN,
        stops: [{ timeMs: 0, value: GREEN }, { timeMs: 1000, value: RED }],
        loop: false,
        easing: 'linear',
        delayMs: 0,
      } as ColorValue,
    }))
    const p = collectPalette(scene)
    expect(p.colors).toContainEqual(GREEN)
    expect(p.colorGradients).toHaveLength(0)
  })

  it('data-driven color → skipped entirely', () => {
    const scene = makeScene(makeNode('a', {
      fill: {
        kind: 'data-driven',
        expr: { ast: { kind: 'FieldAccess', name: 'class' } as never },
      } as ColorValue,
    }))
    const p = collectPalette(scene)
    expect(p.colors).toHaveLength(0)
    expect(p.colorGradients).toHaveLength(0)
  })

  it('opacity + strokeWidth scalars accumulate', () => {
    const scene = makeScene(makeNode('a', {
      opacity: { kind: 'constant', value: 0.8 } as PropertyShape<number>,
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 2.5 } as PropertyShape<number>,
      } as StrokeValue,
    }))
    const p = collectPalette(scene)
    expect(p.scalars).toContain(0.8)
    expect(p.scalars).toContain(2.5)
    expect(p.findScalar(0.8)).toBeGreaterThanOrEqual(0)
  })

  it('size zoom-interpolated → scalar gradient', () => {
    const scene = makeScene(makeNode('a', {
      size: {
        kind: 'zoom-interpolated',
        stops: [zs(0, 4), zs(20, 16)],
      } as SizeValue,
    }))
    const p = collectPalette(scene)
    expect(p.scalarGradients).toHaveLength(1)
    expect(p.scalars).toContain(4)
    expect(p.scalars).toContain(16)
  })

  it('findColor returns -1 for unknown', () => {
    const scene = makeScene(makeNode('a', {
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    }))
    const p = collectPalette(scene)
    expect(p.findColor(BLUE)).toBe(-1)
  })

  it('findColorGradient round-trips', () => {
    const stops = [zs(0, RED), zs(20, BLUE)]
    const scene = makeScene(makeNode('a', {
      fill: { kind: 'zoom-interpolated', stops } as ColorValue,
    }))
    const p = collectPalette(scene)
    const g: ColorGradient = { stops, base: 1 }
    expect(p.findColorGradient(g)).toBe(0)
  })

  it('walks fill, stroke.color, opacity, size, strokeWidth all in one pass', () => {
    const scene = makeScene(makeNode('a', {
      fill: { kind: 'constant', rgba: RED } as ColorValue,
      stroke: {
        color: { kind: 'constant', rgba: BLUE } as ColorValue,
        width: { kind: 'constant', value: 1.5 } as PropertyShape<number>,
      } as StrokeValue,
      opacity: { kind: 'constant', value: 0.5 } as PropertyShape<number>,
      size: { kind: 'constant', value: 12 } as SizeValue,
    }))
    const p = collectPalette(scene)
    expect(p.colors).toContainEqual(RED)
    expect(p.colors).toContainEqual(BLUE)
    expect(p.scalars).toContain(1.5)
    expect(p.scalars).toContain(0.5)
    expect(p.scalars).toContain(12)
  })
})
