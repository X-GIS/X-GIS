// Unit tests for dead-layer-elim pass. Pin each elimination rule
// and the "preserve live layers" identity invariant.

import { describe, it, expect } from 'vitest'
import { deadLayerElimPass } from './dead-layer-elim'
import type { Scene, RenderNode } from '../render-node'

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
  return { sources: [], renderNodes: nodes }
}

describe('dead-layer-elim — explicit hidden', () => {
  it('drops layers with visible: false', () => {
    const hidden = makeNode({ visible: false })
    const visible = makeNode()
    const out = deadLayerElimPass.run(sceneOf([visible, hidden]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(visible)
  })
})

describe('dead-layer-elim — empty zoom range', () => {
  it('drops layers with minzoom === maxzoom', () => {
    const empty = makeNode({ minzoom: 5, maxzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([empty]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('drops layers with minzoom > maxzoom', () => {
    const empty = makeNode({ minzoom: 10, maxzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([empty]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('keeps layers with valid minzoom < maxzoom band', () => {
    const valid = makeNode({ minzoom: 5, maxzoom: 10 })
    const out = deadLayerElimPass.run(sceneOf([valid]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(valid)
  })

  it('keeps layers with only minzoom set (open upper)', () => {
    const minOnly = makeNode({ minzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([minOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — nothing to draw', () => {
  it('drops layers with no fill, no stroke, no label', () => {
    const noop = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', px: 1 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([noop]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('drops layers with stroke color but width=0', () => {
    const zeroWidth = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'constant', rgba: [1, 1, 1, 1] },
        width: { kind: 'constant', px: 0 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([zeroWidth]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('keeps layers with fill only (no stroke)', () => {
    const fillOnly = makeNode({
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', px: 0 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([fillOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('keeps layers with stroke only (no fill)', () => {
    const strokeOnly = makeNode({
      fill: { kind: 'none' },
    })
    const out = deadLayerElimPass.run(sceneOf([strokeOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('keeps layers with a label (no fill / stroke)', () => {
    const labelOnly = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', px: 0 },
      },
      label: { text: { kind: 'expr', expr: { ast: {} as never } } } as never,
    })
    const out = deadLayerElimPass.run(sceneOf([labelOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — conservative about animation', () => {
  it('KEEPS layers with constant opacity=0 (might animate visible later)', () => {
    // Plan: only DROP layers that can NEVER render. opacity=0 is
    // a known animation base — the keyframes pass may bring it
    // visible. The scheduler's per-frame threshold filters at
    // render time when the animation is also static-0.
    const invisible = makeNode({
      opacity: { kind: 'constant', value: 0 },
    })
    const out = deadLayerElimPass.run(sceneOf([invisible]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — identity preservation', () => {
  it('returns the same scene reference when nothing was dropped', () => {
    const scene = sceneOf([makeNode(), makeNode({ name: 'L2' })])
    const out = deadLayerElimPass.run(scene)
    expect(out).toBe(scene)
  })

  it('drops only the dead layer, keeps live ones by reference', () => {
    const live = makeNode()
    const dead = makeNode({ visible: false })
    const live2 = makeNode({ name: 'L2' })
    const out = deadLayerElimPass.run(sceneOf([live, dead, live2]))
    expect(out.renderNodes).toHaveLength(2)
    expect(out.renderNodes[0]).toBe(live)
    expect(out.renderNodes[1]).toBe(live2)
  })
})

describe('dead-layer-elim — pass metadata', () => {
  it('declares the right name and depends on merge-layers + folds', () => {
    expect(deadLayerElimPass.name).toBe('dead-layer-elim')
    expect(deadLayerElimPass.dependencies).toEqual([
      'merge-layers', 'fold-trivial-stops', 'fold-trivial-case',
    ])
  })
})
