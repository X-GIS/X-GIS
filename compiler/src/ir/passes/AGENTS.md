<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# ir/passes

## Purpose
The individual IR optimization passes orchestrated by `ir/pass-manager.ts`. Each pass is a pure `Scene → Scene` function (or an analysis that produces a side-table annotation) with a declared `name` and explicit `dependencies` list; the pass manager topo-sorts on those fields. Together they implement LLVM-style optimization on the compiled `Scene`: common-subexpression analysis and annotation, dead-layer and dead-source elimination, trivial-case/trivial-stops constant folding, dependency-bitset annotation, per-expression metadata, and layer merging (OSM-style N→1 compound-node reduction).

## Key Files
| File | Description |
|------|-------------|
| `cse.ts` | `analyzeCSE` / `hasCSEOpportunities` — walks a `Scene` to find duplicate AST subtrees, producing a `CSEReport`. |
| `apply-cse.ts` | `applyCSE` / `applyCSEFromReport` — side-table annotation marking duplicate subtrees (`CSEAnnotation`); does not rewrite the tree. |
| `cse-annotate.ts` | Pass wrapper wiring `analyzeCSE` + `applyCSE` into the pipeline (Phase C.1 hook). |
| `annotate-deps.ts` | Scene-wide pass stamping each paint property's dependency bitset (`annotateDeps`, `fillIsZoomOnly`, `hasFeatureDep`). |
| `expr-analyze.ts` | Per-`Expr` structural + purity metadata pass. |
| `dead-layer-elim.ts` | Drops `RenderNode`s that can never produce a visible pixel (DCE at the layer level). |
| `dead-source-elim.ts` | Drops `SourceDef`s no surviving `RenderNode` references (DCE at the source level). |
| `fold-trivial-case.ts` | Folds a `match()` whose arms all yield the same literal into that constant. |
| `fold-trivial-stops.ts` | Folds a zoom-interpolated value whose every stop holds the same payload into a constant. |
| `merge-layers.ts` | Stateful pass core (`mergeLayers`): groups contiguous `RenderNode`s sharing a source layer into compound nodes with synthesised per-feature `match()` ASTs for colour and width. Imports helpers and types from the two companion modules below. |
| `merge-layers-helpers.ts` | Pure, side-effect-free helper functions extracted from `merge-layers.ts`: `analyzeFilter`, `analyzeNotFilter`, `canExtendGroup`, `isMergeableNode`, `strokesShapeEqual`, `buildMatchAst`, `buildWidthMatchAst`, `buildOrFilter`, `rgbaToHex`, etc. No module state. |
| `merge-layers-types.ts` | Shared `FilterAnalysis` interface used by both `merge-layers.ts` and `merge-layers-helpers.ts` to avoid a circular dependency. Not part of the compiler's public surface. |

## For AI Agents

### Working In This Directory
- Every pass must be a deterministic `Scene → Scene` (or annotation) function with a declared `name` + `dependencies`; the pass manager topo-sorts on those. Do not introduce ordering assumptions outside the dependency list.
- Analysis vs. transform are kept separate: `cse.ts`/`apply-cse.ts` annotate via side tables; rewrites that change the tree (folds, elimination, merge) are distinct passes. Preserve that split.
- `merge-layers.ts` is now three files: stateful core, pure helpers, shared types. Keep them that way — do not merge them back or introduce new circular imports. Pure helpers in `merge-layers-helpers.ts` must stay free of module state.
- `isMergeableNode` guards in `merge-layers-helpers.ts` prevent merging symbol/label layers, variable-width strokes, per-feature `colorExpr`, extrusions, and animated nodes — all guards exist to prevent data loss in the compound node. Do not relax them without a matching render-path that preserves the discarded data.
- `strokesShapeEqual` in helpers checks every layer-uniform stroke attribute (blur, dashArray, patterns including spacing/size/offset/anchor). The comment block explains why each attribute must match.

### Testing Requirements
- Each pass has a colocated `*.test.ts` (e.g. `dead-layer-elim.test.ts`, `fold-trivial-stops.test.ts`, `cse.test.ts`, `merge-layers.ts` is exercised via `src/__tests__/merge-layers.test.ts`).
- Counter-focused companion tests: `case-stats.test.ts`, `fold-stats.test.ts`, `dead-layer-stats.test.ts` assert counters rather than full snapshots.
- `dead-source-elim.test.ts` and `cse-annotate.test.ts` are colocated. `annotate-deps.test.ts` and `expr-analyze.test.ts` are colocated.

### Common Patterns
- Banner comment naming the pass and its plan phase at the top of each file.
- Companion `*-stats.test.ts` tests assert reduction counters (e.g. layers merged, folds applied) rather than snapshot the full output tree.
- Helper AST-building functions (`buildMatchAst`, `buildWidthMatchAst`, `buildOrFilter`) use `object: null` on `FieldAccess` nodes — this is the correct AST shape for implicit feature-property access; do not change it to a named identifier.

## Dependencies

### Internal
- Import `ir/render-node`, `ir/deps`, `ir/cse-hash`, `ir/classify`, `ir/property-types`, `parser/ast`; registered by `ir/pass-manager.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
