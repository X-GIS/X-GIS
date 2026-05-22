<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# codegen

## Purpose
The back-end of the compiler: turns the optimized IR `Scene` into WGSL shader source and GPU-evaluation plans (still pure strings + plain data — no GPU calls). It emits per-layer `ShaderVariant`s specialized along three axes (projection × value-constants × feature-data), translates per-feature-gpu expressions to WGSL, builds the compile-time `Palette` (literal pool + zoom-stop gradients), and produces the Plan-Phase-4 compute-kernel infrastructure that moves per-feature paint evaluation off the fragment shader into compute passes (match / ternary / interpolate kernels, output bindings, per-show merged variants).

## Key Files
| File | Description |
|------|-------------|
| `shader-gen.ts` | `ShaderVariant` generator — emits per-layer WGSL specialized on projection × value constants × feature data. |
| `wgsl-expr.ts` | AST → WGSL expression compiler for GPU-safe per-feature expressions (arithmetic, builtins, field access). |
| `palette.ts` | `collectPalette` — walks the Scene, gathers paint values whose deps ⊆ {ZOOM} into a literal pool + `ColorGradient`/`ScalarGradient` zoom-stop tables. |
| `palette-emit.ts` | Pure WGSL string builders translating a compile-time `Palette` into shader declarations. |
| `categorical-encoder.ts` | Maps string property values → integer category IDs for GPU storage buffers (all string work at compile/load time). |
| `paint-routing.ts` | Decides, per paint value, where it evaluates (fold / palette / fragment / compute). |
| `compute-gen.ts` | Compute-kernel WGSL emitters: `emitMatchComputeKernel`, `emitTernaryComputeKernel`, `emitInterpolateComputeKernel` + `COMPUTE_WORKGROUP_SIZE`. |
| `compute-plan.ts` | `planComputeKernels` — Scene → `ComputePlanEntry[]` (the per-show compute plan). |
| `compute-lowering.ts` | IR/AST → ComputeKernel spec adapter feeding `compute-gen`. |
| `compute-output-binding.ts` | Fragment-side read path for compute-produced packed RGBA8 storage values. |
| `compute-variant.ts` | Builds the compute-route `ShaderVariant` addendum from a `ComputePlanEntry`. |
| `compute-variant-merge.ts` | Merges a `ComputeVariantAddendum` into a base `ShaderVariant`. |
| `compute-variant-build.ts` | `buildPerShowMergedVariant` — single runtime-facing API wrapping the plan→addendum→merge composition. |

## For AI Agents

### Working In This Directory
- This dir emits **strings + data**, never touches `navigator.gpu`. Keep it GPU-free.
- The compute-kernel files form a layered Phase-4/4-5 stack: `compute-lowering` → `compute-gen` → `compute-plan` → `compute-variant`(+`-merge`,`-output-binding`) → `compute-variant-build`. Edit at the lowest layer that owns the concern and let the higher layers compose.
- WGSL is generated for three specialization axes; a value's routing comes from `paint-routing.ts` + `ir/deps`. Changing where a value evaluates means updating routing, not hand-editing emitted WGSL.

### Testing Requirements
- Rich colocated coverage: `shader-gen-palette.test.ts`, `palette.test.ts`, `palette-emit.test.ts`, `paint-routing.test.ts`, and the full `compute-*.test.ts` set incl. `compute-gen-wgsl-snapshot.test.ts`. Update WGSL snapshots intentionally — diff them before regenerating.

### Common Patterns
- Banner comments tag the plan phase (P3/P4/P4-5). Emitters are pure functions returning WGSL strings; specs (`MatchEmitSpec`, `InterpolateEmitSpec`, …) carry the data, kernels render it.

## Dependencies

### Internal
- Imports `ir/render-node`, `ir/property-types`, `ir/deps`, `ir/classify`, `parser/ast`.

### External
- None (WGSL is hand-emitted text).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
