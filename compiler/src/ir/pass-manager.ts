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

/** A fixpoint group of passes. The manager iterates the contained
 *  passes (in their own internal order — explicit `passes` array
 *  order, NOT topo-sorted at the inner level) until the Scene
 *  reference is identity-stable across an entire inner iteration,
 *  or `maxIterations` is reached.
 *
 *  Use case: LLVM-style DCE pipeline. After a transform produces
 *  newly-dead surface (e.g. `fold-trivial-case` collapses a
 *  data-driven layer to constant, which a later pass might still
 *  prove transparent), the DCE passes need ANOTHER sweep. Running
 *  them once is insufficient.
 *
 *  Identity-stable signal: every pass in the group MUST return the
 *  input Scene reference (`out === in`) when it has nothing to drop.
 *  This is the contract the manager uses to detect "no more work".
 *  `dead-layer-elim` and `dead-source-elim` already follow this. */
export interface PassGroup {
  /** Unique identifier — same namespace as IRPass.name; cannot collide. */
  readonly name: string
  /** Names of passes / groups that must run before this group starts. */
  readonly dependencies: readonly string[]
  /** Passes the group iterates in array order. NOT topo-sorted inside
   *  the group — author orders them explicitly. */
  readonly passes: readonly IRPass[]
  /** Safety cap. Default 4 — LLVM convention. Exceeded → throw with a
   *  diagnostic naming the non-converging pass(es). Catches accidental
   *  non-monotonic passes (a pass that creates new dead surface in
   *  one step + cleans it the next, oscillating forever). */
  readonly maxIterations: number
}

/** Outcome of a pipeline run. `ranPasses` reflects the order the
 *  manager actually executed (including group-internal iterations,
 *  prefixed `<group>/iter-N/<pass>`), useful for diagnostics and tests. */
export interface PassRunResult {
  scene: Scene
  ranPasses: readonly string[]
}

/** A pipeline step — either a single pass or a fixpoint group. */
type PipelineStep =
  | { kind: 'pass', pass: IRPass }
  | { kind: 'group', group: PassGroup }

/** Topologically-ordered IR transform pipeline. Register passes via
 *  {@link register}, groups via {@link registerGroup}, then run them
 *  on a Scene via {@link run}.
 *
 *  Stateless once configured: a single manager handles many runs in
 *  parallel (no per-run state stored on the instance). */
export class PassManager {
  /** Combined map of pass and group names → step. Single namespace so a
   *  pass and a group cannot share a name (would silently break
   *  dependency wiring). */
  private readonly steps = new Map<string, PipelineStep>()

  /** Add a pass to the pipeline. Throws if a step with the same
   *  name is already registered, or if registering this pass would
   *  introduce a missing-dependency / cycle that {@link run} would
   *  later refuse to topologically sort. */
  register(pass: IRPass): void {
    if (this.steps.has(pass.name)) {
      throw new Error(`[PassManager] duplicate step name: "${pass.name}"`)
    }
    this.steps.set(pass.name, { kind: 'pass', pass })
  }

  /** Add a fixpoint group. The group's `passes[]` array iterates in
   *  declared order until the Scene reference is identity-stable or
   *  `maxIterations` is reached. Group `name` participates in the
   *  same topological-dependency namespace as IRPass names.
   *
   *  The group's INNER passes are NOT registered separately — they
   *  exist only inside the group's iteration loop. This means a pass
   *  appears in EITHER `register()` (single-shot) OR a group's
   *  `passes[]` (iterated), never both. The manager enforces neither
   *  side of that constraint structurally; the authoring convention
   *  is "a pass registered standalone runs once; a pass in a group
   *  runs to fixpoint". */
  registerGroup(group: PassGroup): void {
    if (this.steps.has(group.name)) {
      throw new Error(`[PassManager] duplicate step name: "${group.name}"`)
    }
    if (group.passes.length === 0) {
      throw new Error(`[PassManager] group "${group.name}" has no passes — at least one required.`)
    }
    if (group.maxIterations < 1) {
      throw new Error(`[PassManager] group "${group.name}" maxIterations must be >= 1 (got ${group.maxIterations})`)
    }
    this.steps.set(group.name, { kind: 'group', group })
  }

  /** Get the registered passes in the order they would execute. */
  order(): readonly IRPass[] {
    return topoSortSteps(this.steps)
      .filter(s => s.kind === 'pass')
      .map(s => (s as { kind: 'pass', pass: IRPass }).pass)
  }

  /** Run every registered pass / group on `scene` in topological
   *  order. Each pass / group receives the OUTPUT of the previous
   *  step. Groups iterate to identity-stable fixpoint or cap. */
  run(scene: Scene): PassRunResult {
    const order = topoSortSteps(this.steps)
    let cur = scene
    const ranPasses: string[] = []
    for (const step of order) {
      if (step.kind === 'pass') {
        cur = step.pass.run(cur)
        ranPasses.push(step.pass.name)
      } else {
        const result = runFixpoint(step.group, cur)
        cur = result.scene
        ranPasses.push(...result.ranPasses)
      }
    }
    return { scene: cur, ranPasses }
  }
}

/** Iterate `group.passes` against `scene` until the Scene reference
 *  is identity-stable across a complete inner iteration, or
 *  `group.maxIterations` is reached. Returns the final scene and the
 *  prefixed inner pass trace `<group>/iter-N/<pass>` for each
 *  invocation — diagnostic-friendly without polluting the
 *  standalone-pass trace format. */
function runFixpoint(group: PassGroup, scene: Scene): PassRunResult {
  let cur = scene
  const ranPasses: string[] = []
  for (let iter = 1; iter <= group.maxIterations; iter++) {
    const before = cur
    for (const pass of group.passes) {
      cur = pass.run(cur)
      ranPasses.push(`${group.name}/iter-${iter}/${pass.name}`)
    }
    if (cur === before) {
      // Identity-stable: every inner pass returned the same Scene
      // reference. No more work. Exit early — the budget below this
      // iteration is unused (telemetry-friendly: trace stops on the
      // last meaningful iteration).
      return { scene: cur, ranPasses }
    }
  }
  // Hit the cap without converging. Surface the diagnostic loudly —
  // a non-monotonic pass is the typical cause (oscillates between
  // two states). The trace includes every inner invocation so the
  // author can spot which pass keeps changing the scene.
  throw new Error(
    `[PassManager] group "${group.name}" did not reach a fixpoint within ` +
    `maxIterations=${group.maxIterations}. Check the passes in the group ` +
    `for a non-monotonic pass that creates work on later iterations.`,
  )
}

/** Kahn-style topological sort. Surfaces a clear error message when
 *  a dependency points to an unregistered step (typical authoring
 *  mistake — typo in `dependencies`) and when a cycle exists. */
function topoSortSteps(steps: Map<string, PipelineStep>): PipelineStep[] {
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()  // dep → [steps that need it]

  for (const step of steps.values()) {
    const name = step.kind === 'pass' ? step.pass.name : step.group.name
    const deps = step.kind === 'pass' ? step.pass.dependencies : step.group.dependencies
    inDegree.set(name, deps.length)
    for (const dep of deps) {
      if (!steps.has(dep)) {
        throw new Error(
          `[PassManager] step "${name}" depends on "${dep}", ` +
          `which is not registered. Did you forget to register("${dep}")?`,
        )
      }
      let list = dependents.get(dep)
      if (!list) { list = []; dependents.set(dep, list) }
      list.push(name)
    }
  }

  // Seed the queue with every step whose deps are already satisfied
  // (zero in-degree). Stable order: iterate insertion order rather
  // than relying on JS Map's order semantics (already insertion).
  const queue: string[] = []
  for (const [name, deg] of inDegree) if (deg === 0) queue.push(name)

  const out: PipelineStep[] = []
  while (queue.length > 0) {
    const name = queue.shift()!
    out.push(steps.get(name)!)
    const consumers = dependents.get(name) ?? []
    for (const c of consumers) {
      const newDeg = (inDegree.get(c) ?? 0) - 1
      inDegree.set(c, newDeg)
      if (newDeg === 0) queue.push(c)
    }
  }

  if (out.length !== steps.size) {
    const unresolved = [...steps.keys()].filter(
      n => !out.some(s => (s.kind === 'pass' ? s.pass.name : s.group.name) === n),
    )
    throw new Error(
      `[PassManager] dependency cycle involving: ${unresolved.join(', ')}. ` +
      `Each step's dependencies must form a DAG.`,
    )
  }
  return out
}
