// Pin Phase A — dead-source-elim IR pass.
//
// Lifts iter-198's convert-layer "unused source drop" up to the IR
// pass chain so sources orphaned by dead-layer-elim (or any future
// transparent-fill / pattern-drop pass) are caught too.

import { describe, it, expect } from 'vitest'
import type { Scene, RenderNode, SourceDef } from '../render-node'
import { colorConstant, opacityConstant, sizeConstant } from '../render-node'
import { deadSourceElimPass } from './dead-source-elim'

function mkSource(name: string, type: SourceDef['type'] = 'vector'): SourceDef {
  return { name, type, url: `https://example.com/${name}` }
}

function mkNode(name: string, sourceRef: string, overrides: Partial<RenderNode> = {}): RenderNode {
  return {
    name,
    sourceRef,
    zOrder: 0,
    fill: colorConstant(0, 0, 0, 1),
    stroke: { color: { kind: 'none' }, width: { kind: 'constant', value: 0 } },
    opacity: opacityConstant(1),
    size: sizeConstant(1),
    extrude: { kind: 'none' },
    extrudeBase: { kind: 'none' },
    geometry: null,
    ...overrides,
  } as RenderNode
}

function mkScene(sources: SourceDef[], nodes: RenderNode[]): Scene {
  return { sources, renderNodes: nodes, symbols: [] }
}

describe('Phase A — dead-source-elim', () => {
  it('drops sources with zero RenderNode references', () => {
    const scene = mkScene(
      [mkSource('used'), mkSource('unused')],
      [mkNode('layer1', 'used')],
    )
    const out = deadSourceElimPass.run(scene)
    expect(out.sources.map(s => s.name)).toEqual(['used'])
    expect(out.renderNodes).toHaveLength(1)
  })

  it('identity-preserves when every source is referenced', () => {
    const scene = mkScene(
      [mkSource('a'), mkSource('b')],
      [mkNode('layer-a', 'a'), mkNode('layer-b', 'b')],
    )
    const out = deadSourceElimPass.run(scene)
    // Identity-stable: same reference back. Mirror dead-layer-elim
    // convention so the PassManager loop (Phase B fixpoint) sees the
    // "no-op" signal and stops iterating.
    expect(out).toBe(scene)
  })

  it('keeps a source still referenced by ANY surviving RenderNode (post-merge case)', () => {
    // Simulates the merge-layers compound case: 3 input layers got
    // merged into 1 compound RenderNode that still references the
    // same source. Source MUST be kept.
    const scene = mkScene(
      [mkSource('osm')],
      [mkNode('compound-roads', 'osm')],  // single survivor refs osm
    )
    const out = deadSourceElimPass.run(scene)
    expect(out).toBe(scene)
    expect(out.sources.map(s => s.name)).toEqual(['osm'])
  })

  it('drops orphan source even when it is a raster type', () => {
    // dead-layer-elim has a special-case "raster sources keep their
    // RenderNode alive". By the time dead-source-elim runs, if NO
    // RenderNode references the raster source (e.g. the raster layer
    // was visibility: false), it is genuinely orphan and gets dropped.
    const scene = mkScene(
      [mkSource('used', 'vector'), mkSource('orphan-raster', 'raster')],
      [mkNode('vec-layer', 'used')],
    )
    const out = deadSourceElimPass.run(scene)
    expect(out.sources.map(s => s.name)).toEqual(['used'])
  })

  it('declared after dead-layer-elim in the dependency chain', () => {
    expect(deadSourceElimPass.dependencies).toContain('dead-layer-elim')
    expect(deadSourceElimPass.name).toBe('dead-source-elim')
  })
})
