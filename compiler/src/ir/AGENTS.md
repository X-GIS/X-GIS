<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# ir

## Purpose
The intermediate representation — the heart of the compiler. Sits between the AST (syntax) and the runtime (GPU commands). `lower()` converts the parsed AST into a `Scene` of `SourceDef`s + `RenderNode`s (supporting both legacy `let/show` and modern `source/layer` syntax). `optimize()` classifies every paint expression (constant / zoom-dependent / per-feature-gpu/cpu), folds constants, and drives the `PassManager` pipeline. `emitCommands()` bridges the optimized `Scene` to the runtime's `SceneCommands`. The unified `PropertyShape<T>` type models every paint property (color, opacity, stroke-width, size) so emit and codegen handle them uniformly. The `Scene` type carries two optional side-tables: `cseAnnotation` (CSE dedup ids) and `exprAnalysis` (per-`Expr` structural + purity metadata) — both use `WeakMap` and must be excluded from JSON serialisation.

## Key Files
| File | Description |
|------|-------------|
| `lower.ts` | AST → IR lowering. Builds the `Scene` tree; legacy + new syntax, utility-class resolution, text-template re-parsing. The per-binding `lowerLayer` ladder is now a thin driver over a BindingHandler registry (`lower-bindings*.ts`) — same cascade (named→inline→utilities) + X-GIS0005 catch-all. Re-exports `LowerOptions` / `ZoomStopsWithBase` from `lower-types.ts`. |
| `lower-bindings.ts` (+ `lower-bindings-fill.ts` / `-line.ts` / `-paint.ts` / `lower-bindings-registry.ts`) | Per-concern BindingHandler descriptor registry split out of `lowerLayer`'s binding ladder. Each handler applies one binding to the shared mutable LayerAccumulator; `dispatch()` honours a handler returning `false` (matched-but-not-consumed) to reproduce the original fall-through. A new paint/layout binding handler goes HERE, not in the `lower.ts` driver. |
| `lower-types.ts` | Shared types for the lowering pipeline: `LowerOptions` (bypass flags for match-collapse) and `ZoomStopsWithBase<T>`. Extracted from `lower.ts` to keep logic and types separate. |
| `lower-helpers.ts` | Pure binding helpers used by `lower.ts`: `bindingToTextValue`, `bindingAsConstantNumber`, `extractMatchDefaultColor`, `extractInterpolateZoomStops`, `extractInterpolateZoomColorStops`. No side effects; operate solely on `AST.Expr`. |
| `lower-label.ts` | Stateless `label-*` / `label-icon-*` lowering sub-pass extracted from `lowerLayer`. Resolves every label/icon utility (constant, zoom-interp, data-driven, VAO) into a `LabelDef | undefined`. Runs a second utility-loop pass disjoint from the paint loop; preserves item visit order. |
| `lower-animation.ts` | Stateless KEYFRAME → time-stop expansion sub-pass extracted from `lowerLayer`. Expands a referenced `keyframes` block into the six per-property `TimeStop` arrays (`KeyframeTimeStops`) at the layer's animation duration. |
| `render-node.ts` | Core IR types: `Scene`, `SourceDef`, `RenderNode`, `ColorValue`, `StrokeValue`, `OpacityValue`, `SizeValue`, `DataExpr`, `ZoomStop`, `LabelDef`, `TextValue`, `Diagnostic`, `SymbolDef`, `ExtrudeValue`, `FormatSpec`. Re-exports constructors from `render-node-helpers.ts`. |
| `render-node-helpers.ts` | Pure value-type constructors / factories extracted from `render-node.ts`: `colorNone`, `colorConstant`, `opacityConstant`, `sizeNone`, `sizeConstant`, `shapeNone`, `buildLabelShapes`, `hexToRgba`, `rgbaToHex`. |
| `optimize.ts` | Top-level optimize pass: classifies expressions, folds constants, then drives the shared `PIPELINE` (`PassManager`) through merge-layers → fold-trivial-stops → fold-trivial-case → dce-fixpoint group → cse-annotate → expr-analyze. Sits between `lower()` and `emitCommands()`. |
| `emit-commands.ts` | IR `Scene` → runtime `SceneCommands` bridge; produces `LoadCommand`, `ShaderVariant`, `ComputePlanEntry`, `Palette` for the runtime to consume without its own IR changes. Calls into `codegen/` (shader-gen, palette, compute-plan). |
| `classify.ts` | Expression classifier — decides constant / zoom-dependent / per-feature-gpu / per-feature-cpu execution location for each `DataExpr`. |
| `const-fold.ts` | Folds literal-only expressions at compile time by reusing `eval/evaluator` with an empty props bag. |
| `property-types.ts` | `PropertyShape<T>` / `PaintShapes` / `LabelShapes` / `RGBA` — the unified paint-property model replacing per-property unions. `OpacityValue` and `StrokeWidthValue` are now type aliases onto `PropertyShape<number>`. |
| `to-property-shape.ts` | `RenderNode` value → `PropertyShape` conversion shims (`colorValueToShape`, `sizeValueToShape`). |
| `deps.ts` | Multi-axis dependency bitset (`Dep`, `DEPS_ZOOM`/`TIME`/`FEATURE`, `mergeDeps`, `getColorDeps`) — models what each paint value depends on. |
| `cse-hash.ts` | Canonical kind-aware hashing of AST `Expr` subtrees; foundation for CSE deduplication. |
| `pass-manager.ts` | Drives post-`lower` `Scene → Scene` passes. Supports single-shot `IRPass` and fixpoint `PassGroup` (LLVM-style DCE loop). Kahn topological sort on declared `dependencies`; throws on cycles or missing deps. |
| `utility-resolver.ts` | Resolves Tailwind-style utility class names into `ResolvedProperties` / `ShowCommand` fields. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `passes/` | Individual `Scene → Scene` optimization passes run by `pass-manager` (see `passes/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- The four-stage contract is fixed: `lower` → `optimize` (which drives `PassManager`) → `emitCommands`. New IR transforms belong in `passes/` as named `Scene → Scene` functions with explicit `dependencies`, not inline in `lower` or `optimize`.
- Paint values flow through `PropertyShape<T>` — prefer extending that over re-introducing per-property unions. `OpacityValue` and `StrokeWidthValue` are now aliases; new callsites should use `PropertyShape<number>` directly.
- `classify.ts` + `deps.ts` decide where an expression evaluates; getting the dependency bitset wrong silently changes whether a value folds, becomes a uniform, or hits WGSL codegen.
- `Scene.cseAnnotation` and `Scene.exprAnalysis` both use `WeakMap` — do NOT include them in JSON fixtures or snapshot serialisers. The fixture-ir-snapshot serialiser already excludes them; maintain that gate.
- NaN-guard pattern in `optimize.ts`: `constFold` can produce `NaN` for numeric folding; always check `Number.isFinite` before emitting `opacityConstant` / `sizeConstant` to prevent degenerate GPU geometry.
- `lower-helpers.ts` and `render-node-helpers.ts` are the designated homes for pure helpers extracted from their parent files — add new helpers there, not back into `lower.ts` or `render-node.ts`. A new per-binding handler goes in a `lower-bindings-*.ts` module + the registry, NOT the `lowerLayer` driver.
- The `PIPELINE` in `optimize.ts` is a module-level singleton built once. Pass registration order follows: merge-layers → fold-trivial-stops → fold-trivial-case → dce-fixpoint (dead-layer-elim + dead-source-elim, max 4 iterations) → cse-annotate → expr-analyze.

### Testing Requirements
- Top-level colocated tests: `deps.test.ts`, `cse-hash.test.ts`, `property-shape.test.ts`, `paint-shapes-emit.test.ts`, `pass-manager.test.ts`.
- Compiler-level integration tests: `src/__tests__/ir.test.ts`, `optimize.test.ts`, `ir-snapshot.test.ts`, `fixture-ir-snapshot.test.ts`.
- Per-pass tests live in `passes/*.test.ts` (see `passes/AGENTS.md`).
- Run with `bun run test` (vitest). Run `bun run build` before pushing — vitest does not typecheck.

### Common Patterns
- Files banner with `// ═══ Title ═══`. Constructors return frozen-shaped value objects (`colorConstant`, `sizeNone`). Passes return the input `Scene` reference unchanged (identity) when they have nothing to do — the `dce-fixpoint` group relies on this for convergence detection.

## Dependencies

### Internal
- Imports `parser/ast`, `eval/evaluator` (for const-folding), `format/` (text-template parsing), `tokens/colors`, `spec/oracle`; feeds `codegen/` (shader-gen, palette, compute-plan) and `convert/`.

### External
- None.

<!-- MANUAL: notes below this line are preserved on regeneration -->
