<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# ir/passes

## Purpose
The individual IR optimization passes orchestrated by `ir/pass-manager.ts`. Each pass is a pure `Scene → Scene` function (or an analysis that produces a side-table annotation) with a name and an explicit `dependencies` list, run in topologically sorted order. Together they implement LLVM-style optimization on the compiled `Scene`: common-subexpression analysis/annotation, dead-layer and dead-source elimination, trivial-case/trivial-stops constant folding, dependency-bitset annotation, per-expression metadata, and layer merging.

## Key Files
| File | Description |
|------|-------------|
| `cse.ts` | `analyzeCSE` / `hasCSEOpportunities` — finds duplicate AST subtrees across a `Scene`, producing a `CSEReport`. |
| `apply-cse.ts` | `applyCSE` / `applyCSEFromReport` — side-table annotation marking duplicate subtrees (`CSEAnnotation`); does not rewrite the tree. |
| `cse-annotate.ts` | Pass wrapper that wires the dormant `analyzeCSE` + `applyCSE` infra into the pass pipeline (Phase C.1). |
| `annotate-deps.ts` | Scene-wide pass stamping each paint property's dependency bitset (`annotateDeps`, `fillIsZoomOnly`, `hasFeatureDep`). |
| `expr-analyze.ts` | Per-`Expr` structural + purity metadata pass. |
| `dead-layer-elim.ts` | Drops `RenderNode`s that can never produce a visible pixel (LLVM-style DCE at the layer level). |
| `dead-source-elim.ts` | Drops `SourceDef`s no surviving RenderNode references (DCE at the source level). |
| `fold-trivial-case.ts` | Folds a `match()` whose arms all yield the same literal into that constant. |
| `fold-trivial-stops.ts` | Folds a zoom-interpolated value whose every stop holds the same payload into a constant. |
| `merge-layers.ts` | Merges contiguous RenderNodes sharing a source layer that differ only in `filter`/`fill`/`stroke color` into compound nodes (OSM-style layer reduction). |

## For AI Agents

### Working In This Directory
- Every pass must be a deterministic `Scene → Scene` (or annotation) function with a declared `name` + `dependencies`; the pass manager topo-sorts on those. Don't introduce ordering assumptions outside the dependency list.
- Analysis vs. transform are kept separate: `cse.ts`/`apply-cse.ts` annotate via side tables; rewrites that change the tree (folds, elimination, merge) are distinct passes. Preserve that split.

### Testing Requirements
- Each pass has a colocated `*.test.ts` (e.g. `dead-layer-elim.test.ts`, `fold-trivial-stops.test.ts`, `cse.test.ts`) plus `*-stats.test.ts` variants. `src/__tests__/merge-layers.test.ts` and `dead-source-drop.test.ts` cover integration.

### Common Patterns
- Banner comment naming the pass + its plan phase; `case-stats`/`fold-stats`/`dead-layer-stats` companion tests assert counters rather than full snapshots.

## Dependencies

### Internal
- Import `ir/render-node`, `ir/deps`, `ir/cse-hash`, `ir/classify`; registered by `ir/pass-manager.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
