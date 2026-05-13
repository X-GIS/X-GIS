// Unit tests for fold-trivial-stops pass. Pin every paint slot's
// fold behaviour + the no-op identity contract.

import { describe, it, expect } from 'vitest'
import { foldTrivialStopsPass } from './fold-trivial-stops'
import type { Scene, RenderNode } from '../render-node'

// Build a minimal RenderNode stub. Tests override the specific paint
// slot they exercise; everything else gets a constant default so the
// fold's "did anything change?" check has a clean baseline.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
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
    shape: 'circle' as never,
    ...overrides,
  }
}

function sceneOf(nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('fold-trivial-stops — opacity', () => {
  it('folds zoom-interpolated opacity with all-equal stops to constant', () => {
    const node = makeNode({
      opacity: {
        kind: 'zoom-interpolated',
        base: 1,
        stops: [
          { zoom: 0, value: 0.5 },
          { zoom: 5, value: 0.5 },
          { zoom: 10, value: 0.5 },
        ],
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.opacity).toEqual({ kind: 'constant', value: 0.5 })
  })

  it('leaves opacity unchanged when stops differ', () => {
    const opacity = {
      kind: 'zoom-interpolated' as const,
      base: 1,
      stops: [{ zoom: 0, value: 0 }, { zoom: 10, value: 1 }],
    }
    const node = makeNode({ opacity })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.opacity).toBe(opacity)
  })
})

describe('fold-trivial-stops — fill colour', () => {
  it('folds zoom-interpolated fill with all-equal RGBA to constant', () => {
    const node = makeNode({
      fill: {
        kind: 'zoom-interpolated',
        base: 1,
        stops: [
          { zoom: 0, value: [0.2, 0.4, 0.6, 1] },
          { zoom: 10, value: [0.2, 0.4, 0.6, 1] },
        ],
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.fill).toEqual({ kind: 'constant', rgba: [0.2, 0.4, 0.6, 1] })
  })

  it('leaves fill unchanged when one channel differs', () => {
    const fill = {
      kind: 'zoom-interpolated' as const,
      base: 1,
      stops: [
        { zoom: 0, value: [1, 0, 0, 1] as [number, number, number, number] },
        { zoom: 10, value: [0.999, 0, 0, 1] as [number, number, number, number] },  // <1e-9 diff
      ],
    }
    const node = makeNode({ fill })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.fill).toBe(fill)
  })
})

describe('fold-trivial-stops — stroke', () => {
  it('folds stroke width zoom-stops with all-equal stops', () => {
    const node = makeNode({
      stroke: {
        color: { kind: 'constant', rgba: [0, 0, 0, 1] },
        width: { kind: 'zoom-stops', stops: [{ zoom: 0, value: 2 }, { zoom: 10, value: 2 }] },
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.stroke.width).toEqual({ kind: 'constant', px: 2 })
  })

  it('folds stroke colour and width independently', () => {
    const node = makeNode({
      stroke: {
        color: {
          kind: 'zoom-interpolated', base: 1,
          stops: [{ zoom: 0, value: [1, 1, 1, 1] }, { zoom: 5, value: [1, 1, 1, 1] }],
        },
        width: { kind: 'zoom-stops', stops: [{ zoom: 0, value: 3 }, { zoom: 5, value: 3 }] },
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.stroke.color).toEqual({ kind: 'constant', rgba: [1, 1, 1, 1] })
    expect(out.renderNodes[0]!.stroke.width).toEqual({ kind: 'constant', px: 3 })
  })
})

describe('fold-trivial-stops — size', () => {
  it('folds zoom-interpolated size with all-equal stops', () => {
    const node = makeNode({
      size: {
        kind: 'zoom-interpolated', base: 1,
        stops: [{ zoom: 0, value: 12 }, { zoom: 10, value: 12 }],
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([node]))
    expect(out.renderNodes[0]!.size).toEqual({ kind: 'constant', value: 12 })
  })
})

describe('fold-trivial-stops — identity preservation', () => {
  it('returns the same scene reference when nothing folded', () => {
    // All-constant input — pass should be a complete no-op including
    // not allocating a new array.
    const scene = sceneOf([makeNode()])
    const out = foldTrivialStopsPass.run(scene)
    expect(out).toBe(scene)
    expect(out.renderNodes).toBe(scene.renderNodes)
  })

  it('returns the same node reference for nodes that did not fold', () => {
    // Mixed scene: one node folds, the other is already constant.
    const constNode = makeNode()
    const animNode = makeNode({
      opacity: {
        kind: 'zoom-interpolated', base: 1,
        stops: [{ zoom: 0, value: 0.7 }, { zoom: 10, value: 0.7 }],
      },
    })
    const out = foldTrivialStopsPass.run(sceneOf([constNode, animNode]))
    expect(out.renderNodes[0]).toBe(constNode)  // untouched
    expect(out.renderNodes[1]).not.toBe(animNode)  // folded
  })
})

describe('fold-trivial-stops — pass metadata', () => {
  it('declares the right name and depends on merge-layers', () => {
    expect(foldTrivialStopsPass.name).toBe('fold-trivial-stops')
    expect(foldTrivialStopsPass.dependencies).toEqual(['merge-layers'])
  })
})
