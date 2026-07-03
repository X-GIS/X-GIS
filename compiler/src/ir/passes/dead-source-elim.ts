// ═══ dead-source-elim ═══
//
// Drops SourceDefs that no surviving RenderNode references. Mirror of
// `dead-layer-elim` at the source layer (LLVM-style early DCE pass
// chain). Runs AFTER `dead-layer-elim` because killing a layer is what
// CAN orphan a source — a source referenced ONLY by a dropped layer
// becomes dead with no other change.
//
// What this catches that the convert-layer drop (iter-198) doesn't:
//
//   - Layer with `visibility: 'none'` referencing source S → convert
//     emits BOTH (the warning surface stays) → `dead-layer-elim`
//     drops the layer → this pass drops S. iter-198's convert-layer
//     drop never saw S as dead because the layer was still present
//     in `style.layers[]` at that point.
//
//   - `minzoom >= maxzoom` layer (empty zoom range) referencing
//     source T → same chain. T orphaned only after dead-layer-elim.
//
//   - Future folds that statically prove a layer transparent (Phase
//     D / D.1 transparent-fill drop) — every such case spawns a
//     potentially orphan source. This pass closes the loop.
//
// What it does NOT eliminate:
//
//   - Sources still referenced by at least one RenderNode — kept,
//     even if their tile-fetch is rare or low-priority. The bucket
//     scheduler handles per-zoom gating; that's a runtime concern.
//
//   - Sources mentioned only by `SymbolDef` — `SymbolDef` carries
//     `name + paths[]` only, no source reference (see
//     `compiler/src/ir/render-node.ts:37-41`). If that contract
//     widens later, this pass needs to union with symbol refs.

import type { IRPass } from '../pass-manager'
import type { Scene } from '../render-node'

/** PassManager-compatible entry. Filters the sources array. */
export const deadSourceElimPass: IRPass = {
  name: 'dead-source-elim',
  // After dead-layer-elim so the surviving renderNodes set is final
  // before we count source references. Running before that would
  // count layers that are about to die.
  dependencies: ['dead-layer-elim'],
  run(scene: Scene): Scene {
    const referenced = new Set<string>()
    for (const node of scene.renderNodes) referenced.add(node.sourceRef)
    // Identity preserve: every source live → return same Scene reference
    // so downstream identity checks (test invariants, memoisation)
    // observe the no-op cleanly. Mirror of dead-layer-elim:102.
    if (scene.sources.every((s) => referenced.has(s.name))) return scene
    const live = scene.sources.filter((s) => referenced.has(s.name))
    return { ...scene, sources: live }
  },
}
