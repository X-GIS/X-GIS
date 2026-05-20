// ═══ cse-annotate ═══
//
// Phase C.1 (iter 201, plan addendum). Wraps the dormant `applyCSE`
// infrastructure (`cse.ts:analyzeCSE` + `apply-cse.ts:applyCSE`) into
// a registered IRPass so the Scene flowing out of the pipeline
// carries a `cseAnnotation` side-table. Downstream consumers
// (compute-plan kernel dedup — Phase C.2; shader-gen `matchArmsKey`
// replacement) pick this up by reading `scene.cseAnnotation`.
//
// What gets annotated:
//
//   - Every `Expr` node walked by `analyzeCSE` (paint values, filter
//     expressions, geometry data-bindings) gets a `cseId`.
//   - Singletons receive ids too — consumers can rely on "if I have
//     a cseId, it's stable across the Scene"; absence means "this
//     Expr wasn't part of the CSE walk".
//
// Why this pass runs at the tail (after `dce-fixpoint`):
//
//   - CSE on dead expressions is pure waste. Dropping a layer
//     removes every `Expr` inside it from the walk surface; running
//     CSE BEFORE dead-elim would assign ids to expressions that
//     get thrown away, then make those ids gappy in the final
//     annotation.
//
// Why a single pass (not a group):
//
//   - `applyCSE` is not monotonic in the fixpoint sense — it
//     produces an annotation, not a new dead surface. Running it
//     twice produces the same annotation. No iteration benefit.
//
// Snapshot impact (CRITICAL):
//
//   - `Scene.cseAnnotation` contains a `WeakMap` (non-serialisable).
//     The fixture-ir-snapshot serializer (compiler/src/__tests__/
//     fixture-ir-snapshot.test.ts) MUST exclude this field, or every
//     fixture snapshot churns + tests fail. The serializer was
//     updated in the same commit; see that test for the gate.

import type { IRPass } from '../pass-manager'
import type { Scene } from '../render-node'
import { applyCSE } from './apply-cse'

/** PassManager-compatible entry. Reads `scene` (does not mutate),
 *  returns a new Scene with the `cseAnnotation` side-table attached.
 *  Identity-preserves when the analysis surface is empty (no Expr
 *  visited) so the optional fixpoint group (if this pass is later
 *  bundled into one) sees a clean no-op signal.
 *
 *  IMPORTANT: `applyCSE` always returns a non-null `CSEAnnotation`,
 *  even when `analyzeCSE` finds zero entries (uniqueCount === 0).
 *  We still attach it — consumers test `cseIdByExpr.get(expr)`
 *  returning `undefined` for the no-CSE case, which is cheaper than
 *  branching on annotation presence. */
export const cseAnnotatePass: IRPass = {
  name: 'cse-annotate',
  // Run AFTER dce-fixpoint so dead expressions aren't walked. Also
  // after `merge-layers` (transitively, since dce depends on it)
  // because merge produces compound match() expressions that
  // SHOULD be subject to CSE.
  dependencies: ['dce-fixpoint'],
  run(scene: Scene): Scene {
    const cseAnnotation = applyCSE(scene)
    // Always attach — empty annotation is a valid "no CSE found"
    // signal; consumers branch on per-Expr `cseIdByExpr.get(...)`.
    return { ...scene, cseAnnotation }
  },
}
