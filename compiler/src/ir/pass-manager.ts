// ═══ IR pass pipeline ═══
//
// Drives the post-`lower` transformations of the IR Scene tree. Each
// pass is a pure `Scene → Scene` function with an explicit name and
// `dependencies` list; the manager topologically sorts and runs them
// in dependency order.
//
// Why a pipeline (vs. inline function calls):
//
//   - **Single integration point.** New IR transforms register here
//     instead of editing wherever the previous pass returned. Phase 2
//     of the X-GIS-as-compiler plan adds fold-trivial-stops,
//     fold-trivial-case, dead-layer-elim — without the pipeline each
//     adds a sprawl of `result = newPass(result)` glue.
//
//   - **Dependency ordering.** Some passes must run after others
//     (`merge-layers` needs `lower` to have produced PaintShapes; a
//     future `fold-trivial-stops` should run AFTER any pass that
//     synthesizes stops, never before). The manager makes the order
//     explicit + verifiable.
//
//   - **Per-pass tests.** Each pass takes / returns a Scene, so its
//     test is "input fixture → expected output fixture" — directly
//     diffable, no full-pipeline mock needed.
//
//   - **Optional trace.** Hooked passes can record before / after
//     snapshots so a future debugger can show how each pass moved
//     the IR. Not implemented in Phase 2a (this commit); the
//     `IRPass.run` signature reserves the second optional argument
//     for it.
//
// What this file is NOT in Phase 2a:
//
//   - Migration of existing transforms (`lower`, `mergeLayers`,
//     `expandPerFeatureColorMatch`) into the new shape — those land
//     as separate commits so each move stays bisectable.
//   - The fold / DCE passes themselves — Phase 2c+.

import type { Scene } from './render-node'

/** A single IR transformation. Pure: returns a new Scene; the input
 *  Scene must not be mutated.
 *
 *  `dependencies` is a list of OTHER pass `name`s that must run
 *  before this one. The PassManager topologically sorts the
 *  registered set. Circular deps throw at registration time. */
export interface IRPass {
  /** Unique identifier. Used as the dependency key. */
  readonly name: string
  /** Names of passes that MUST run before this one. */
  readonly dependencies: readonly string[]
  /** Returns a new Scene with the transformation applied. The input
   *  must not be mutated — share node references for unchanged
   *  subtrees, allocate new arrays / objects only for the parts that
   *  change. */
  run(scene: Scene): Scene
}

/** Outcome of a pipeline run. `ranPasses` reflects the order the
 *  manager actually executed, useful for diagnostics and tests. */
export interface PassRunResult {
  scene: Scene
  ranPasses: readonly string[]
}

/** Topologically-ordered IR transform pipeline. Register passes via
 *  {@link register}, then run them on a Scene via {@link run}.
 *
 *  Stateless once configured: a single manager handles many runs in
 *  parallel (no per-run state stored on the instance). */
export class PassManager {
  private readonly passes = new Map<string, IRPass>()

  /** Add a pass to the pipeline. Throws if a pass with the same
   *  name is already registered, or if registering this pass would
   *  introduce a missing-dependency / cycle that {@link run} would
   *  later refuse to topologically sort. */
  register(pass: IRPass): void {
    if (this.passes.has(pass.name)) {
      throw new Error(`[PassManager] duplicate pass name: "${pass.name}"`)
    }
    this.passes.set(pass.name, pass)
  }

  /** Get the registered passes in the order they would execute. */
  order(): readonly IRPass[] {
    return topoSort(this.passes)
  }

  /** Run every registered pass on `scene` in topological order. Each
   *  pass receives the OUTPUT of the previous pass. */
  run(scene: Scene): PassRunResult {
    const order = topoSort(this.passes)
    let cur = scene
    const ranPasses: string[] = []
    for (const pass of order) {
      cur = pass.run(cur)
      ranPasses.push(pass.name)
    }
    return { scene: cur, ranPasses }
  }
}

/** Kahn-style topological sort. Surfaces a clear error message when
 *  a dependency points to an unregistered pass (typical authoring
 *  mistake — typo in `dependencies`) and when a cycle exists. */
function topoSort(passes: Map<string, IRPass>): IRPass[] {
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()  // dep → [passes that need it]

  for (const pass of passes.values()) {
    inDegree.set(pass.name, pass.dependencies.length)
    for (const dep of pass.dependencies) {
      if (!passes.has(dep)) {
        throw new Error(
          `[PassManager] pass "${pass.name}" depends on "${dep}", ` +
          `which is not registered. Did you forget to register("${dep}")?`,
        )
      }
      let list = dependents.get(dep)
      if (!list) { list = []; dependents.set(dep, list) }
      list.push(pass.name)
    }
  }

  // Seed the queue with every pass whose deps are already satisfied
  // (zero in-degree). Stable order: iterate insertion order rather
  // than relying on JS Map's order semantics (already insertion).
  const queue: string[] = []
  for (const [name, deg] of inDegree) if (deg === 0) queue.push(name)

  const out: IRPass[] = []
  while (queue.length > 0) {
    const name = queue.shift()!
    out.push(passes.get(name)!)
    const consumers = dependents.get(name) ?? []
    for (const c of consumers) {
      const newDeg = (inDegree.get(c) ?? 0) - 1
      inDegree.set(c, newDeg)
      if (newDeg === 0) queue.push(c)
    }
  }

  if (out.length !== passes.size) {
    const unresolved = [...passes.keys()].filter(n => !out.some(p => p.name === n))
    throw new Error(
      `[PassManager] dependency cycle involving: ${unresolved.join(', ')}. ` +
      `Each pass's dependencies must form a DAG.`,
    )
  }
  return out
}
