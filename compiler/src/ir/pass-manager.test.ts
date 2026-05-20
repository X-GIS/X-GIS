// Unit tests for the IR PassManager — topological-sort behaviour,
// dependency error messages, run-order invariants.

import { describe, it, expect } from 'vitest'
import { PassManager, type IRPass, type PassGroup } from './pass-manager'
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
      .toThrow(/duplicate step name/)
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
      .toThrow(/step "b" depends on "a", which is not registered/)
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

describe('PassManager — fixpoint groups (Phase B)', () => {
  it('identity-stable group converges in 1 iteration', () => {
    // Group of two passes that both identity-return when scene is
    // already stable. Should exit after iter-1 (no useless iter-2).
    const log: string[] = []
    const idA: IRPass = {
      name: 'no-op-a', dependencies: [],
      run(scene) { log.push('a'); return scene },
    }
    const idB: IRPass = {
      name: 'no-op-b', dependencies: [],
      run(scene) { log.push('b'); return scene },
    }
    const group: PassGroup = {
      name: 'noop-group', dependencies: [],
      passes: [idA, idB], maxIterations: 4,
    }
    const mgr = new PassManager()
    mgr.registerGroup(group)
    const result = mgr.run(emptyScene)
    // Single iteration: both passes ran once, then identity-stable.
    expect(log).toEqual(['a', 'b'])
    expect(result.ranPasses).toEqual([
      'noop-group/iter-1/no-op-a',
      'noop-group/iter-1/no-op-b',
    ])
  })

  it('mutating pass triggers a second iteration; group stops when stable', () => {
    // Pass A returns a NEW scene exactly once (simulates a transform
    // that creates new dead surface). Pass B identity-returns.
    // Expectation: iter-1 sees A return new scene, iter-2 sees A
    // identity-return → loop exits.
    let aCallCount = 0
    const sceneB: Scene = { sources: [], renderNodes: [], symbols: [] }
    const passA: IRPass = {
      name: 'churn-once', dependencies: [],
      run(scene) {
        aCallCount++
        // First call returns a NEW reference; subsequent calls
        // identity-return (the "fixpoint reached" contract).
        return aCallCount === 1 ? sceneB : scene
      },
    }
    const passB: IRPass = {
      name: 'noop', dependencies: [],
      run(scene) { return scene },
    }
    const group: PassGroup = {
      name: 'churn-group', dependencies: [],
      passes: [passA, passB], maxIterations: 4,
    }
    const mgr = new PassManager()
    mgr.registerGroup(group)
    const result = mgr.run(emptyScene)
    expect(aCallCount).toBe(2)  // iter-1 + iter-2
    expect(result.scene).toBe(sceneB)
    expect(result.ranPasses).toEqual([
      'churn-group/iter-1/churn-once',
      'churn-group/iter-1/noop',
      'churn-group/iter-2/churn-once',
      'churn-group/iter-2/noop',
    ])
  })

  it('throws when group fails to converge within maxIterations', () => {
    // Synthetic pass that ALWAYS returns a new scene reference.
    // Should hit the cap.
    const oscillating: IRPass = {
      name: 'osc', dependencies: [],
      run() { return { sources: [], renderNodes: [], symbols: [] } },
    }
    const group: PassGroup = {
      name: 'bad-group', dependencies: [],
      passes: [oscillating], maxIterations: 3,
    }
    const mgr = new PassManager()
    mgr.registerGroup(group)
    expect(() => mgr.run(emptyScene))
      .toThrow(/group "bad-group" did not reach a fixpoint within maxIterations=3/)
  })

  it('rejects empty group at registration time', () => {
    const mgr = new PassManager()
    expect(() => mgr.registerGroup({
      name: 'empty', dependencies: [], passes: [], maxIterations: 4,
    })).toThrow(/has no passes/)
  })

  it('rejects maxIterations < 1', () => {
    const mgr = new PassManager()
    expect(() => mgr.registerGroup({
      name: 'zero-iter', dependencies: [],
      passes: [{ name: 'p', dependencies: [], run: s => s }],
      maxIterations: 0,
    })).toThrow(/maxIterations must be >= 1/)
  })

  it('groups topo-sort with passes in the same dependency namespace', () => {
    const log: string[] = []
    const preGroup: IRPass = {
      name: 'pre', dependencies: [],
      run(scene) { log.push('pre'); return scene },
    }
    const inner: IRPass = {
      name: 'inner', dependencies: [],
      run(scene) { log.push('inner'); return scene },
    }
    const postGroup: IRPass = {
      name: 'post', dependencies: ['my-group'],
      run(scene) { log.push('post'); return scene },
    }
    const group: PassGroup = {
      name: 'my-group',
      dependencies: ['pre'],     // group depends on a pass
      passes: [inner],
      maxIterations: 2,
    }
    const mgr = new PassManager()
    mgr.register(postGroup)        // registers before its dep on purpose
    mgr.registerGroup(group)
    mgr.register(preGroup)
    mgr.run(emptyScene)
    expect(log).toEqual(['pre', 'inner', 'post'])
  })
})
