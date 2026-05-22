<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# ir

## Purpose
The intermediate representation — the heart of the compiler. Sits between the AST (syntax) and the runtime (GPU commands). `lower()` converts the parsed AST into a `Scene` of `SourceDef`s + `RenderNode`s (supporting both legacy `let/show` and modern `source/layer` syntax). `optimize()` then classifies every paint expression (constant / zoom-dependent / per-feature-gpu/cpu), folds constants, and runs the IR pass pipeline. `emitCommands()` bridges the optimized `Scene` to the runtime's `SceneCommands`. The unified `PropertyShape<T>` type models every paint property (color, opacity, stroke-width, size) so emit and codegen handle them uniformly.

## Key Files
| File | Description |
|------|-------------|
| `lower.ts` | AST → IR lowering. Builds the `Scene` tree; handles legacy + new syntax, utility-class resolution, text-template re-parsing. |
| `optimize.ts` | Top-level optimize pass: classifies expressions + folds constants; sits between `lower()` and `emitCommands()`. |
| `emit-commands.ts` | IR `Scene` → runtime `SceneCommands` bridge; lets the runtime consume IR without its own changes. |
| `render-node.ts` | Core IR types: `Scene`, `SourceDef`, `RenderNode`, `ColorValue`, `StrokeValue`, `OpacityValue`, `SizeValue`, `DataExpr`, `ZoomStop`, `LabelDef`, `TextValue` + constructors (`colorConstant`, `hexToRgba`, …). |
| `classify.ts` | Expression classifier — decides constant / zoom-dependent / per-feature-gpu / per-feature-cpu execution location. |
| `const-fold.ts` | Folds literal-only expressions at compile time by reusing `eval/evaluate()` with an empty props bag. |
| `property-types.ts` | `PropertyShape<T>` / `PaintShapes` / `RGBA` — the unified paint-property model replacing the per-property unions. |
| `to-property-shape.ts` | RenderNode value → `PropertyShape` conversion shims. |
| `deps.ts` | Multi-axis dependency bitset (`Dep`, `DEPS_ZOOM`/`TIME`/`FEATURE`, `mergeDeps`, `getColorDeps`, …) — models what each paint value depends on. |
| `cse-hash.ts` | Canonical kind-aware hashing of AST `Expr` subtrees; foundation for CSE. |
| `pass-manager.ts` | Drives post-`lower` `Scene → Scene` passes; topo-sorts by declared `dependencies`. |
| `utility-resolver.ts` | Resolves Tailwind-style utility class names into `ResolvedProperties` / ShowCommand fields. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `passes/` | Individual `Scene → Scene` optimization passes run by `pass-manager` (see `passes/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- The four-stage contract is fixed: `lower` → pass-manager/`optimize` → `emitCommands`. New IR transforms belong in `passes/` as named `Scene → Scene` functions with explicit `dependencies`, not inline in `lower`/`optimize`.
- Paint values flow through `PropertyShape<T>` — prefer extending that over re-introducing per-property unions.
- `classify.ts` + `deps.ts` decide where an expression evaluates; getting the dependency bitset wrong silently changes whether a value folds, becomes a uniform, or hits WGSL codegen.

### Testing Requirements
- `src/__tests__/ir.test.ts`, `optimize.test.ts`, `ir-snapshot.test.ts`, `fixture-ir-snapshot.test.ts` plus colocated `ir/deps.test.ts`, `ir/cse-hash.test.ts`, `ir/property-shape.test.ts`, `ir/paint-shapes-emit.test.ts`, `ir/pass-manager.test.ts`.

### Common Patterns
- Files banner with `// ═══ Title ═══` and frequently reference plan phases (Phase 0/3/4, "wild-finding-starlight"). Constructors return frozen-shaped value objects (`colorConstant`, `sizeNone`).

## Dependencies

### Internal
- Imports `parser/ast`, `eval/evaluator` (for folding), `format/`, `tokens/colors`, `spec/oracle`; feeds `codegen/` and `convert/`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
