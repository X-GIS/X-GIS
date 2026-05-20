// Pin Phase C.1 — cse-annotate IR pass.
//
// Activates the dormant CSE infrastructure (cse-hash.ts, cse.ts,
// apply-cse.ts) by registering it as a registered IRPass. Phase C.2
// will wire the first consumer (compute-plan kernel dedup).

import { describe, it, expect } from 'vitest'
import type { Scene, RenderNode, SourceDef } from '../render-node'
import { colorConstant, opacityConstant, sizeConstant } from '../render-node'
import { cseAnnotatePass } from './cse-annotate'

function mkSource(name: string): SourceDef {
  return { name, type: 'vector', url: `https://example.com/${name}` }
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

describe('Phase C.1 — cse-annotate', () => {
  it('attaches cseAnnotation to the Scene', () => {
    const scene = mkScene([mkSource('s')], [mkNode('l', 's')])
    const out = cseAnnotatePass.run(scene)
    expect(out.cseAnnotation).toBeDefined()
    expect(out.cseAnnotation?.uniqueCount).toBeGreaterThanOrEqual(0)
    expect(out.cseAnnotation?.cseIdByExpr).toBeInstanceOf(WeakMap)
    expect(out.cseAnnotation?.canonicalById).toBeInstanceOf(Map)
  })

  it('does not mutate the input Scene', () => {
    const scene = mkScene([mkSource('s')], [mkNode('l', 's')])
    const snap = JSON.stringify({ ...scene, cseAnnotation: undefined })
    cseAnnotatePass.run(scene)
    expect(JSON.stringify({ ...scene, cseAnnotation: undefined })).toBe(snap)
    // Original scene reference does NOT gain a cseAnnotation field
    // (the pass returns a NEW Scene object).
    expect(scene.cseAnnotation).toBeUndefined()
  })

  it('empty scene yields empty annotation (no Expr to walk)', () => {
    const scene = mkScene([], [])
    const out = cseAnnotatePass.run(scene)
    expect(out.cseAnnotation?.uniqueCount).toBe(0)
    expect(out.cseAnnotation?.totalNodes).toBe(0)
  })

  it('declared after dce-fixpoint group', () => {
    expect(cseAnnotatePass.dependencies).toContain('dce-fixpoint')
    expect(cseAnnotatePass.name).toBe('cse-annotate')
  })

  it('cseAnnotation contains a WeakMap (unserialisable; consumers gate JSON paths)', () => {
    // The fixture-ir-snapshot serializer (compiler/src/__tests__/
    // fixture-ir-snapshot.test.ts) only hashes the converter's text
    // output, not the Scene shape — so a WeakMap field doesn't churn
    // it. ir-snapshot.test.ts uses lower() directly (skipping
    // optimize()), so it also doesn't see this field. If a future
    // snapshot consumer DOES touch Scene, it MUST exclude this field
    // — pin the WeakMap shape so the constraint is explicit.
    const scene = mkScene([mkSource('s')], [mkNode('l', 's')])
    const out = cseAnnotatePass.run(scene)
    expect(out.cseAnnotation?.cseIdByExpr).toBeInstanceOf(WeakMap)
    // WeakMap is intentionally not enumerable for JSON.stringify:
    expect(JSON.stringify(out.cseAnnotation?.cseIdByExpr)).toBe('{}')
  })
})
