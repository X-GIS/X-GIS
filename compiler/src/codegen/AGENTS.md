<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# codegen

## Purpose
The compiler's back-end: turns optimized IR `RenderNode` trees into per-layer WGSL shader variants
and standalone WebGPU compute-kernel modules, both as pure strings/data with no GPU calls. The
sub-pipeline flows: `palette.ts` collects a deduplicated zoom-stop gradient pool from a compiled
`Scene`; `paint-routing.ts` classifies each paint axis as `inline-constant`, `palette-zoom`,
`compute-feature`, or `cpu-uniform` using dep-bit analysis; `shader-gen.ts` uses those signals to
specialise WGSL fragment expressions (constant-inlining, palette atlas sampling via
`textureSampleLevel`, data-driven match/gradient chains, or legacy uniform fallback);
`compute-gen.ts` / `compute-lowering.ts` / `compute-plan.ts` build and schedule GPU compute
kernels for feature-driven axes (match, ternary, interpolate); `compute-variant-build.ts` +
`compute-variant-merge.ts` compose the final `ShaderVariant` handed to the runtime. A `_util/`
subdirectory holds DSL node-builder helpers (`node-builders.ts`) and a canonical-JSON utility
(`canonical-json.ts`) used internally by cache-key hashing.

## Key Files

| File | Description |
|---|---|
| `index.ts` | Barrel re-export. Public API surface: exports `ShaderVariant` type, core DSL vocabulary (`NodeLike`, `wgslRaw`), field extraction (`collectFields`, `collectFieldsStrict`), palette/compute infra, and runtime-facing builders (`buildPerShowMergedVariant`). |
| `shader-gen.ts` | Core variant generator. `generateShaderVariant(node, fnEnv?, palette?, scalarPaletteMode?)` processes fill/stroke/opacity `ColorValue`/`OpacityValue` across constant, time-interpolated, data-driven (`categorical`, `match`, `gradient`, `scale`), and zoom-interpolated (palette-atlas) arms. Builds the `ShaderVariant` cache key and returns typed `NodeLike<'vec4<f32>'>` fill/stroke expressions alongside legacy WGSL strings during the US-005 Node migration. |
| `shader-gen-types.ts` | Type declarations for `ShaderVariant`, `ColorResult`, and `OpacityResult`. `ShaderVariant` carries `fillExpr`/`strokeExpr` as `NodeLike<'vec4<f32>'>\|null`, palette gradient index lists (`paletteColorGradients`, `paletteScalarGradients`), `fillUsesPalette`/`strokeUsesPalette`/`opacityUsesPalette` flags, `categoryOrder` for match-arm ID alignment, `fillIsDefault`/`strokeIsDefault` typed sentinels, and `computeBindings` for P4 output buffers. |
| `node-types.ts` | Permanent compiler-side DSL vocabulary: the `Expr` union (lit, constref, param, varref, unop, binop, compare, logical, call, member, construct, select, index, matchExpr, rawString ops), the `ShaderType` union, and the `NodeLike<K>` seam interface with phantom WGSL-key brand. Must stay structurally in lock-step with `runtime/src/engine/shader-dsl/core/ir/nodes.ts`. `rawString` is a back-compat wrapper that carries a pre-built WGSL string; new emit sites use `_util/node-builders.ts` instead. |
| `node-to-wgsl.ts` | Compiler-side copy of the runtime WGSL emit oracle. `nodeToWgslString(node)` lowers a `NodeLike` to a WGSL string; used in tests to assert Node-emit equality. The round-trip test `node-to-wgsl.test.ts` pins this against the runtime backend to catch drift. |
| `wgsl-expr.ts` | AST → WGSL expression compiler. `exprToWGSL(expr, fieldMap, fnEnv?)` maps field accesses to `feat_data[input.feat_id * stride + offset]`, translates arithmetic/comparison/logical operators (booleans via WGSL `select`), handles WGSL builtins and user-defined function inlining, and supports pipe expressions. `collectFields` extracts the field name set for storage-buffer layout. |
| `palette.ts` | Zoom-stop gradient pool. `collectPalette(scene)` walks all `RenderNode`s and deduplicates constant/zoom-interpolated color and scalar paint values into `ColorGradient[]` / `ScalarGradient[]` arrays. Dedup uses a canonical key string per gradient; NaN/Infinity channels are sanitised to 0 before insertion. Returns -1 on `find*` miss so callers fall back to the legacy cpu-uniform path. |
| `palette-emit.ts` | WGSL binding-declaration and `textureSampleLevel` expression builders for the palette atlas. Emits the texture/sampler binding block (`emitPaletteBindings`) and per-call-site sample expressions. Also emits `NodeLike` parallels for the US-005 Node migration path alongside the legacy string forms. |
| `paint-routing.ts` | Execution-path classifier. `routeColorValue(value, palette?)` returns a `PaintRoute` discriminated union. Decision precedence: `none`/`constant` → `inline-constant`; FEATURE dep present → `compute-feature`; ZOOM-only + palette hit → `palette-zoom`; otherwise → `cpu-uniform`. `routePropertyShape` handles numeric axes. |
| `compute-gen.ts` | WGSL compute-kernel string emitter. `emitMatchComputeKernel` (with LUT auto-switch at `MATCH_LUT_THRESHOLD=16` arms), `emitTernaryComputeKernel`, and `emitInterpolateComputeKernel` each produce a self-contained `@compute @workgroup_size(64)` kernel (`ComputeKernel`). All share binding layout: `feat_data` @0, `out_color` @1, `u_count` @2. Output is `pack4x8unorm` RGBA into a `u32` storage buffer. |
| `compute-lowering.ts` | IR/AST → kernel spec adapter. `lowerMatchColorToMatch(expr)` converts a `data-driven` ColorValue with a `match()` AST and a single `FieldAccess` argument into a `MatchEmitSpec`. `lowerConditionalColorToTernary(value)` converts a `conditional` ColorValue into a `TernaryEmitSpec`. Returns null for shapes too complex for single-field-stride lowering. |
| `compute-plan.ts` | Scene-level compute schedule. `planComputeKernels(scene)` walks all render-node × paint-axis pairs (fill, stroke-color), routes, lowers, and produces `ComputePlanEntry[]`. Deduplicates kernels first by CSE annotation WeakMap (fast, set by `ir/passes/cse.ts`), then by WGSL+entryPoint fingerprint string as fallback. |
| `compute-variant.ts` | Compute variant addendum builder. `buildComputeVariantAddendum(entries, bindGroup, baseBinding)` converts a per-show `ComputePlanEntry[]` slice into a `ComputeVariantAddendum` carrying WGSL storage-binding declarations and `NodeLike` `unpack4x8unorm` read expressions per axis. |
| `compute-variant-merge.ts` | Merges a `ComputeVariantAddendum` into a `ShaderVariant`. Overrides `fillExpr`/`strokeExpr` with compute-output read expressions, drops the now-redundant match-chain preambles, and concatenates preamble strings. |
| `compute-variant-build.ts` | Single runtime-facing entry point. `buildPerShowMergedVariant(showVariant, scenePlan, nodeIndex, bindGroup, baseBinding)` chains filter → addendum → merge with early-return when no compute axes apply to this show. |
| `compute-output-binding.ts` | Fragment-side binding helpers. `emitComputeOutputBindingDecl` and `emitComputeOutputReadExpr` emit the `var<storage, read> compute_out_<axis>` declaration and the `unpack4x8unorm(...)` read expression. `makeComputeOutputBindGroupEntry` returns the matching `GPUBindGroupLayoutEntry` shape for the runtime. |
| `categorical-encoder.ts` | String-property → integer category ID encoder. `buildCategoricalEncoding` builds a sorted-alphabetical `Map<string, number>` from a `PropertyTable` field and pairs it with a 20-colour auto-palette (Tailwind 500-shade tokens via `resolveColor`). Backs the `CAT_PALETTE[u32(field) % 20u]` fallback path in `shader-gen.ts`. |
| `shader-gen-helpers.ts` | Internal helpers used by `shader-gen.ts`: `buildFieldMap` (field-name→offset map), `matchArmsKey` (hash for match-chain disambiguation in the variant cache key, uses `canonicalJsonStringify`), `resolveColorFromAST` (AST node → normalised RGBA), and `fmt` (WGSL float literal formatter). |

The `_util/` subdirectory (not separately documented) holds `node-builders.ts` (typed factory functions for every `NodeLike`/`Expr` op — the preferred authoring surface over raw `wgslRaw`) and `canonical-json.ts` (key-order-stable JSON serialiser for variant cache keys).

The `__snapshots__/` directory holds vitest snapshot files for `compute-gen-wgsl-snapshot.test.ts`; the pinned WGSL kernel text must be deliberately regenerated with `vitest --update-snapshots` when threshold or emit logic changes.

## For AI Agents

### Working In This Directory
- `node-types.ts` `Expr` union must stay structurally identical to `runtime/src/engine/shader-dsl/core/ir/nodes.ts`. Any new op added to the runtime must be mirrored here; the compiler cannot import the runtime type directly (rootDir constraint + circular workspace dep). The boundary is pinned by `node-to-wgsl.test.ts`.
- `categoryOrder` alignment is safety-critical: the integer IDs the shader's if-else chain bakes for `match()` arms must match what the runtime feature-data packer writes. Both sides sort patterns alphabetically. Breaking this silently mis-maps landuse/road-class colours at render time with no type error.
- The `palette-zoom` route requires the palette atlas to be uploaded on the runtime side before bind-group creation. Wiring a new zoom-interpolated paint kind requires changes in both `palette.ts` (`ingestColor`/`ingestNumberShape`) and `shader-gen.ts` (`processColorValue`/`processOpacity`).
- Compute kernels use a fixed binding layout (`feat_data` @0, `out_color` @1, `u_count` @2). Do not renumber these without updating the runtime `ComputeDispatcher` bind-group construction.
- `wgslRaw<K>(s)` is a migration scaffold (`rawString` op). New emit sites should construct `NodeLike` values via `_util/node-builders.ts` helpers instead of adding more `wgslRaw` calls.
- `MATCH_LUT_THRESHOLD` (16) controls the if-else → const-array LUT switch in `emitMatchComputeKernel`. The snapshot test pins exact kernel WGSL; changing the threshold requires deliberate snapshot regeneration.

### Testing Requirements
- Each source file has a colocated `.test.ts`. WGSL kernel text is pinned in `__snapshots__/compute-gen-wgsl-snapshot.test.ts.snap` — diff before regenerating with `vitest --update-snapshots`.
- `node-to-wgsl.test.ts` is the cross-package round-trip oracle and must stay green to certify compiler ↔ runtime Node-emit parity.
- `shader-gen-palette.test.ts` covers the palette-zoom routing and `textureSampleLevel` emit path specifically.
- All tests in this directory are pure unit tests (no `GPUDevice`). Visual correctness of compute-routed layers requires headed Playwright runs against the playground app.
- Run `bun run build` (not just `vitest`) before pushing — TypeScript errors in codegen surface at tsc time, not vitest time.

### Common Patterns
- All emitter functions are pure: IR/spec structs in, strings or `NodeLike` values out. No GPU objects, no side effects, no module-level mutable state (except the lazy `autoPalette` cache in `categorical-encoder.ts`).
- Kernel deduplication uses a two-tier cache: CSE WeakMap annotation (fast path, set by `ir/passes/cse.ts`) then WGSL+entryPoint fingerprint string (fallback, catches emit-equal but AST-distinct expressions).
- `NodeLike<K>` carries a phantom `__k?: K` brand for WGSL-type checking at call sites; `K` is the WGSL type string (`'f32'`, `'vec4<f32>'`, etc.).
- The compute-kernel stack is layered: `compute-lowering` (IR→spec) → `compute-gen` (spec→WGSL) → `compute-plan` (scene→entries) → `compute-variant`/`-merge`/`-output-binding` (entries→variant addendum) → `compute-variant-build` (runtime entry point). Edit at the lowest layer that owns the concern.

## Dependencies

### Internal
- `compiler/src/ir/render-node` — `RenderNode`, `ColorValue`, `OpacityValue`, `DataExpr`, `Scene`, `ZoomStop`, `rgbaToHex`, `hexToRgba`
- `compiler/src/ir/property-types` — `PropertyShape`, `RGBA`
- `compiler/src/ir/deps` — `Dep`, `DepBits`, `getColorDeps`, `getPropertyShapeDeps`, `hasDep`
- `compiler/src/parser/ast` — `Expr`, `FnStatement`, and all AST node types
- `compiler/src/tokens/colors` — `resolveColor` (CSS named colour → hex)
- `compiler/src/tiler/vector-tiler` — `PropertyTable` (used by `categorical-encoder.ts`)

### External
No npm dependencies. WGSL is hand-emitted text; all logic is pure TypeScript.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
