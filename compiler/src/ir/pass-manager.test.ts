// Unit tests for the IR PassManager — topological-sort behaviour,
// dependency error messages, run-order invariants.

import { describe, it, expect } from 'vitest'
import { PassManager, type IRPass } from './pass-manager'
import type { Scene } from './render-node'

// Empty Scene stub — passes don't actually look inside it for these
// tests; we only care about the pipeline mechanics + ordering.
const emptyScene: Scene = {
  sources: [],
  renderNodes: [],
  symbols: [],
}

// Build a recording pass whose run() appends its name to a shared log.
function recordingPass(name: string, dependencies: string[], log: string[]): IRPass {
  return {
    name,
    dependencies,
    run(scene: Scene): Scene {
      log.push(name)
      return scene
    },
  }
}

describe('PassManager — registration', () => {
  it('throws on duplicate pass name', () => {
    const mgr = new PassManager()
    mgr.register({ name: 'a', dependencies: [], run: s => s })
    expect(() => mgr.register({ name: 'a', dependencies: [], run: s => s }))
      .toThrow(/duplicate pass name/)
  })

  it('register order does NOT determine run order — dependencies do', () => {
    const log: string[] = []
    const mgr = new PassManager()
    // Intentionally register `b` (depends on `a`) BEFORE `a`.
    mgr.register(recordingPass('b', ['a'], log))
    mgr.register(recordingPass('a', [], log))
    mgr.run(emptyScene)
    expect(log).toEqual(['a', 'b'])
  })
})

describe('PassManager — topological run order', () => {
  it('runs passes in dependency order', () => {
    const log: string[] = []
    const mgr = new PassManager()
    mgr.register(recordingPass('lower', [], log))
    mgr.register(recordingPass('merge-layers', ['lower'], log))
    mgr.register(recordingPass('fold-stops', ['merge-layers'], log))
    mgr.register(recordingPass('dead-elim', ['fold-stops'], log))
    const result = mgr.run(emptyScene)
    expect(log).toEqual(['lower', 'merge-layers', 'fold-stops', 'dead-elim'])
    expect(result.ranPasses).toEqual(log)
  })

  it('runs independent branches in registration order', () => {
    // Two passes with the same dep — they're free to run in either
    // order. The manager picks REGISTRATION ORDER for stability so
    // identical pass sets produce identical pipelines across runs.
    const log: string[] = []
    const mgr = new PassManager()
    mgr.register(recordingPass('lower', [], log))
    mgr.register(recordingPass('fold-stops', ['lower'], log))
    mgr.register(recordingPass('dead-elim', ['lower'], log))
    mgr.run(emptyScene)
    expect(log).toEqual(['lower', 'fold-stops', 'dead-elim'])
  })

  it('threads the scene through every pass — each receives previous output', () => {
    const seenScenes: Scene[] = []
    const sceneA: Scene = { sources: [], renderNodes: [], symbols: [] }
    const sceneB: Scene = { sources: [], renderNodes: [{ kind: 'fill' } as never], symbols: [] }
    const sceneC: Scene = { sources: [], renderNodes: [{ kind: 'line' } as never], symbols: [] }
    const mgr = new PassManager()
    mgr.register({ name: 'a', dependencies: [], run(s) { seenScenes.push(s); return sceneB } })
    mgr.register({ name: 'b', dependencies: ['a'], run(s) { seenScenes.push(s); return sceneC } })
    const result = mgr.run(sceneA)
    expect(seenScenes[0]).toBe(sceneA)  // first pass saw original
    expect(seenScenes[1]).toBe(sceneB)  // second pass saw a's output
    expect(result.scene).toBe(sceneC)   // final result is last pass's output
  })

  it('order() returns the same DAG sort as run() without executing passes', () => {
    const log: string[] = []
    const mgr = new PassManager()
    mgr.register(recordingPass('c', ['b'], log))
    mgr.register(recordingPass('b', ['a'], log))
    mgr.register(recordingPass('a', [], log))
    expect(mgr.order().map(p => p.name)).toEqual(['a', 'b', 'c'])
    expect(log).toEqual([])  // order() didn't run anything
  })
})

describe('PassManager — error messages', () => {
  it('rejects a missing dependency by name', () => {
    const mgr = new PassManager()
    mgr.register({ name: 'b', dependencies: ['a'], run: s => s })
    expect(() => mgr.run(emptyScene))
      .toThrow(/pass "b" depends on "a", which is not registered/)
  })

  it('rejects a dependency cycle', () => {
    const mgr = new PassManager()
    mgr.register({ name: 'a', dependencies: ['b'], run: s => s })
    mgr.register({ name: 'b', dependencies: ['a'], run: s => s })
    expect(() => mgr.run(emptyScene))
      .toThrow(/dependency cycle involving:/)
  })

  it('rejects a self-dependency', () => {
    const mgr = new PassManager()
    mgr.register({ name: 'a', dependencies: ['a'], run: s => s })
    expect(() => mgr.run(emptyScene))
      .toThrow(/dependency cycle/)
  })
})
