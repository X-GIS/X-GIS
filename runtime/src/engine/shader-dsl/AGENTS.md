# shader-dsl — in-house TSL-inspired shader DSL

Zero-dependency TypeScript shader DSL. A shader is authored once as a typed
node graph (the IR); two backends lower it. This eliminates the hand-maintained
GPU↔CPU drift class: the GPU shader and the CPU math are GENERATED from one
source instead of kept in sync by hand.

See `.omc/plans/ralplan-wgsl-tsl-shader-dsl.md` (Phase 0) +
`.omc/specs/deep-interview-wgsl-tsl-shader-dsl.md`.

## Layout
Split into `core/` (the reusable IR + backends + struct schema) and `shaders/`
(the concrete shader graphs). Consumers OUTSIDE this folder import the emitted
strings + cpu dispatch from the top-level barrel (`from '../shader-dsl'`), never
the internal modules; `core/` is private.

### core/
- `ir/` — the IR, split by concern behind `ir/index.ts` (DAG: types ← nodes ←
  node ← builder):
  - `types.ts` — `ShaderType` + the `*T` type constants, `KeyOf`/`ElemKey`/`ScalarKey`.
  - `nodes.ts` — the `Expr`/`Stmt` unions + `ConstDecl`/`Struct*`/`Binding`/`Func`/`Module`/`EntryParam` (data shapes only). `ConstDecl` carries BOTH a `wgslValue` and a `cpuValue`.
  - `node.ts` — the generic `Node<K>` authoring wrapper (chaining) + free builtins + vec/array/`transformMat4` ctors.
  - `builder.ts` — the `Builder` (statement-list control flow) + `fn`/`computeFn`/`entryFn`/`module`.
- `backends/wgsl.ts` — `emitModule(IR)` → WGSL string for `createShaderModule`.
  Fully parenthesised; byte-identity with the old hand string is NOT a goal.
- `backends/cpu.ts` — `compileModule(IR)` → an f64 tree-walk interpreter. The
  generated replacement for the deleted `projection-wgsl-mirror.ts`.
- `schema.ts` — `struct(name, {field: type})`: a WGSL struct + typed field
  access (`helper.get(node, 'field')`).

### shaders/
- `projections.ts` — all projection fns authored in the DSL. The int-dispatch
  ladder is generated from `projection/projections-table.ts`; cull thresholds
  are read from the same table (drift-impossible).
- `cpu-projections.ts` — the generated cpu-f64 dispatch with the legacy mirror
  API names. The CPU consumers (raster tile_rtc, label anchors, tile selection)
  reach these through the barrel.
- `sdf.ts` — `sdf_shape` + helpers (PoC-B: the imperative for/switch/var path).
- `log-depth.ts` / `background.ts` / `icon.ts` — the log-depth, background-quad,
  and icon/SDF-text shader graphs.
- `compute-match.ts` — the per-feature `match()` compute kernel, parameterized
  by arm count (PoC-C).

### index.ts
The public barrel — re-exports the `shaders/` surface (emitted-WGSL strings +
cpu dispatch). Tests are co-located with their subject (`core/ir/*.test.ts`,
`core/backends/*.test.ts`, `shaders/*-dsl.test.ts`).

## Two-tolerance f32/f64 reality (load-bearing)
`PI`/`DEG2RAD` are emitted as the truncated shader literals (`3.14159265`,
`0.01745329`) on the WGSL side and as full-precision `Math.PI` / `Math.PI/180`
on the CPU side — encoded as `ConstDecl.wgslValue` vs `cpuValue`. So:
- cpu-f64 reproduces the canonical CPU math at ≤1mm (the mirror-deletion gate).
- cpu-f64 ↔ executed WGSL stays at ~100m (the f32/truncated-const gap), the
  parity the render-gate / `_shader-math-parity.spec.ts` accommodates.

Do NOT "unify" the constants — that would inject ~5–10m drift the render-gate
would flag, or detach the CPU from the canonical ≤1mm.

## GPU vs CPU `project_geom` differ ON PURPOSE
`project_geom` (GPU) applies a world-copy offset to place adjacent world copies
per-vertex; `project_geom_cpu` (the mirror's algorithm) OMITS it because the CPU
consumer telescopes (`project_geom(v) − project_geom(SW)`, offset cancels) and
label anchors need the absolute camera-relative position near ±180°. They are
authored as two functions — not a bug.

## Type-safety (AC4)
`Node<K>` carries a phantom type key (`'f32'`, `'vec2<f32>'`, …). A `vec2+vec3`
op, a wrong struct field name, or `.select` on a non-bool node are TS COMPILE
errors — see `type-safety.test.ts` (`@ts-expect-error` probes; an unused
directive fails typecheck). Validated by `bunx tsc -p runtime/tsconfig.json`.

CAVEAT: `bun run build` does not currently typecheck `runtime` (no build script;
the package has pre-existing standalone-tsc noise). Until that is cleaned up,
the AC4 compile-time guarantees are gated by `tsc -p runtime/tsconfig.json`
(filtered to shader-dsl), not `bun run build`. Byte-layout/offset derivation in
`struct()` (for the aliased 160-byte tile uniform) is a Phase-2 follow-up.

## Verify
- `bunx vitest run runtime/src/engine/shader-dsl/` — unit (cpu interp + emit).
- `bunx tsc -p runtime/tsconfig.json --noEmit` — the AC4 compile-time probes.
- `cd playground && XGIS_SOFTWARE_GPU=1 bunx playwright test _shader-math-parity.spec.ts`
  — executed-WGSL ↔ cpu parity (CI render-gate; needs a WebGPU adapter).
