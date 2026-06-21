<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# shader-dsl

## Purpose
A zero-dependency TypeScript shader DSL that eliminates hand-maintained GPU/CPU drift. Shaders are authored once as typed node graphs (the IR); a WGSL backend emits strings for `device.createShaderModule`, and a CPU f64 tree-walk backend runs the same IR on the host for projection math (replacing the deleted `projection-wgsl-mirror.ts`). Split into `core/` (IR, backends, struct schema — private) and `shaders/` (concrete shader graphs). Consumers outside this directory import only from `index.ts`; `core/` is never imported directly.

## Key Files

| File | Description |
|---|---|
| `index.ts` | Public barrel — re-exports `shaders/projections`, `cpu-projections`, `sdf`, `log-depth`, `icon`, `text`, `raster`, `point`, `line`, `compute-match`. The only import point for renderers and parity tests outside this dir. Note: `polygon`, `frame-uniform`, `ecef`, `overdraw-*`, `oit-compose` are NOT in the barrel; they are used internally or by renderers via direct import. |
| `core/ir/types.ts` | `ShaderType` discriminated union + all `*T` typed constants (`f32T`, `vec4fT`, `mat4x4fT`, …) + `KeyOf`/`ElemKey`/`ScalarKey` phantom-type machinery underpinning the AC4 compile-time safety gate. Leaf of the IR import DAG. |
| `core/ir/nodes.ts` | Pure data shapes: `Expr` and `Stmt` unions (binop, call, matchExpr, placeholder, raw, …) + module-level declarations (`ConstDecl`, `StructDecl`, `BindingDecl`, `FuncDecl`, `ModuleDecl`). `ConstDecl` carries separate `wgslValue` (truncated literal) and `cpuValue` (full-precision). |
| `core/ir/node.ts` | `Node<K>` authoring wrapper with chaining arithmetic, free builtins, vec/array constructors, and `transformMat4`. The generic typed node class consumers actually write with. |
| `core/ir/builder.ts` | `Builder` (statement-list control flow: `let`, `var`, `assign`, `if`/`elif`/`else`, `forRange`, `switch`, `ret`, `placeholder`) + `fn`/`computeFn`/`entryFn`/`module` assemblers. |
| `core/ir/index.ts` | Internal re-export barrel for `types`, `nodes`, `node`, `builder`. |
| `core/backends/wgsl.ts` | `emitModule(IR) → string`. Runs `lowerModule` (matchExpr pre-emit pass) before emitting. Also exports `emitExpr`, `emitFunc`, `emitStruct`, `emitBinding`, `emitConst`. |
| `core/backends/wgsl-lower.ts` | Pre-emit transform: lowers every `matchExpr` Expr inside a function body into a hoisted `var _mr_N` slot + `Stmt.switch` pair, then rewrites the expression position to a varref. Keeps `emitExpr` matchExpr-unaware. |
| `core/backends/cpu.ts` | `compileModule(IR) → CpuModule`: f64 tree-walk interpreter. Vectors are `number[]`. Uses `cpuValue` constants (full-precision `Math.PI`). GPU-only stubs (`textureSample`, `fwidth`) throw if evaluated. |
| `core/schema.ts` | `struct(name, fields)` — declares a WGSL struct and returns a `StructHelper` with typed `get(node, field)` so a wrong field name is a TS compile error (AC4 mechanism). |
| `shaders/projections.ts` | All 8 projection functions authored as a single `PROJECTION_MODULE` IR. Dispatch ladder generated from `projection/projections-table.ts`; cull thresholds read from the same table. Exports `PROJECTION_WGSL_CONSTS` and `PROJECTION_WGSL_FNS`. |
| `shaders/cpu-projections.ts` | CPU-f64 dispatch generated from the same IR by the CPU backend. Exposes legacy mirror API names (`projectMercator`, `projectGlobe`, etc.) consumed by tile selection, raster `tile_rtc`, and label anchors. |
| `shaders/polygon.ts` | Polygon shader (fill/stroke/extrude pipeline). `emitPolygonWgsl(variant, pickEnabled)` composes the 256-byte `Uniforms` struct, 3 vertex entries (`vs_main`/`vs_main_ecef`/`vs_main_ecef_extruded`), and 6 fragment entries. `placeholder` Stmts at `fill-return`/`stroke-return` sites are swapped per variant by the composer. Not in the barrel — imported directly by `vector-tile-renderer.ts`. |
| `shaders/line.ts` | Line shader graph. Emits `LINE_SHADER_WGSL`. Parallel pattern to `polygon.ts`. |
| `shaders/point.ts` | Point shader graph, including per-feature flag dispatch via bitwise u32 ops. |
| `shaders/icon.ts` | Icon/SDF-text shader graph. |
| `shaders/text.ts` | Text shader graph (SDF-based label rendering). |
| `shaders/sdf.ts` | `sdf_shape` + helpers — uses the imperative `for`/`switch`/`var` path (PoC-B). |
| `shaders/raster.ts` | Raster tile shader graph. |
| `shaders/log-depth.ts` | Log-depth encoding helpers emitted as `LOG_DEPTH_WGSL_FNS`; prepended to every geometry shader that writes `gl_FragDepth`. |
| `shaders/compute-match.ts` | Per-feature `match()` compute kernel, parameterised by arm count (PoC-C). |
| `shaders/frame-uniform.ts` | Frame-uniform struct and binding declarations shared across shader graphs. Not in the barrel. |
| `shaders/ecef.ts` | ECEF (Earth-Centered Earth-Fixed) helper functions for globe rendering. Not in the barrel. |
| `shaders/overdraw-compose.ts` | Overdraw-composition pass shader. Not in the barrel. |
| `shaders/overdraw-fs.ts` | Overdraw fragment shader. Not in the barrel. |
| `shaders/oit-compose.ts` | Order-independent transparency composition pass. Not in the barrel. |
| `shaders/_polygon-fixtures.ts` | Test-support only — shared `ShaderVariant` fixture definitions and `emitForFixture()` helper used by both `polygon-variant-diff.test.ts` and `scripts/capture-polygon-snapshots.ts` to drive the polygon composer. Not exported from the barrel. |

The `shaders/__polygon-variant-snapshots__/` subdirectory holds 8 committed `.wgsl` baseline files for `polygon-variant-diff.test.ts`; do not hand-edit them — regenerate via `scripts/capture-polygon-snapshots.ts`.

## For AI Agents

### Working In This Directory
- **Never "unify" `PI`/`DEG2RAD` constants.** `ConstDecl` has two separate fields: `wgslValue` (truncated shader literal) and `cpuValue` (full-precision `Math.PI`). Merging them injects ~5–10 m drift (flagged by the render gate) or breaks the ≤1 mm CPU parity gate.
- **`project_geom` vs `project_geom_cpu` differ on purpose.** The GPU version applies a world-copy offset per-vertex; the CPU version omits it because consumers telescope the offset out. Do not "fix" this divergence.
- **`matchExpr` Exprs must never reach `emitExpr` directly.** `emitModule` runs `lowerModule` first (`wgsl-lower.ts`) to hoist them into `var` + `switch` pairs. If `matchExpr` leaks to `emitExpr`, it throws loudly.
- **`placeholder` Stmts must be swapped by the polygon composer before GPU emit.** An un-swapped placeholder emits a WGSL comment (no-op, silent) on the GPU side but throws on the CPU backend — the asymmetry is intentional and load-bearing.
- **`raw` Stmts are GPU-only.** The CPU backend throws if it encounters one. Do not add `raw` Stmts on code paths that also run through `cpu-projections.ts` or compute evaluation.
- **AC4 type safety is enforced by `tsc`, not by `bun run build`.** Gate phantom-type changes with `bunx tsc -p runtime/tsconfig.json --noEmit`.
- **Polygon `Uniforms` struct is 256 bytes (`UNIFORM_SIZE`/`UNIFORM_SLOT` in `vector-tile-renderer.ts`), field order is load-bearing.** Reordering fields silently mis-binds GPU reads in `vector-tile-renderer.ts` and every per-tile `writeBuffer` caller.
- **Consumers import only from `../shader-dsl` (the barrel)** for the exported shaders. `polygon`, `frame-uniform`, `ecef`, `overdraw-*`, and `oit-compose` are consumed via direct internal imports — do not add them to the barrel without coordinating with all renderers.

### Testing Requirements
- **Unit tests** (co-located): `core/ir/ir.test.ts`, `core/ir/type-safety.test.ts`, `core/ir/match-expr.test.ts`, `core/ir/placeholder-stmt.test.ts`, `core/ir/render-stage-dsl.test.ts`, `core/backends/wgsl.test.ts`, `shaders/*-dsl.test.ts` (per-shader WGSL emit), `shaders/polygon-variant-diff.test.ts` (byte-equal against `__polygon-variant-snapshots__/`), `shaders/polygon-worldcopy-fill.test.ts`.
  Run: `bunx vitest run runtime/src/engine/shader-dsl/`
- **Type-safety gate**: `bunx tsc -p runtime/tsconfig.json --noEmit` — validates all `@ts-expect-error` probes in `type-safety.test.ts`; a stale directive fails typecheck.
- **Executed-WGSL parity gate** (CI render gate): `cd playground && XGIS_SOFTWARE_GPU=1 bunx playwright test _shader-math-parity.spec.ts` — verifies CPU f64 ↔ executed WGSL within the ~100 m f32/truncated-const tolerance. Requires a WebGPU adapter.
- The `__polygon-variant-snapshots__/` baseline `.wgsl` files are regenerated by `scripts/capture-polygon-snapshots.ts` — never hand-edit them.

### Common Patterns
- **Single-source two-backend authoring**: every shader function is written once with `fn(name, params, retType, (b, p) => { … })`. WGSL backend emits GPU string; CPU backend tree-walks the same IR.
- **`Node<K>` chaining**: arithmetic ops, comparisons, swizzles, and builtins chain on `Node` instances (`a.add(b)`, `a.lt(b)`, `node.field('x', f32T)`). The phantom key `K` carries the WGSL type; type mismatches are TS errors.
- **`ConstDecl` dual-value**: every constant needing CPU/GPU fidelity uses `{ wgslValue: <truncated>, cpuValue: <Math.*> }`.
- **Projection dispatch from table**: `PROJECTIONS` array in `projection/projections-table.ts` is the single source of truth; `projections.ts` generates both WGSL switch ladder and CPU dispatch from it. Do not add a projection without a table entry.
- **Placeholder + composer pattern**: `polygon.ts` lays down `b.placeholder('fill-return')` at variant injection sites; `emitPolygonWgsl` clones the module and replaces each tagged placeholder with the variant's return Stmts before calling `emitModule`.

## Dependencies

### Internal
- `runtime/src/engine/projection/projections-table.ts` — projection registry; drives the dispatch ladder in `shaders/projections.ts`
- `runtime/src/engine/shaders/` — hand-written WGSL strings that the DSL is progressively replacing (still prepended in some shader composers during the migration)

### External
- No npm dependencies. The DSL is zero-dependency TypeScript; all WGSL math functions are mapped to `Math.*` in the CPU backend's `BUILTINS` table.

<!-- MANUAL: notes below this line are preserved on regeneration -->
