<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-23 | Updated: 2026-06-29 -->

# shader-dsl (`@xgis/shader-dsl`)

## Purpose
A zero-dependency TypeScript shader DSL that eliminates hand-maintained GPU/CPU drift. A shader is authored
ONCE as a typed node graph (the IR); three backends then emit it over ONE shared tree-walk — a **WGSL**
writer (the production strings for `device.createShaderModule`), a **GLSL ES 3.00** writer (real for
render pipelines — vertex+fragment entry-IO + std140 UBO, WebGL2 compile+render-verified; compute/SSBO
fail closed), and a **CPU f64 oracle** that walks
the same IR on the host for projection math (the generated replacement for the deleted
`projection-wgsl-mirror.ts`). The package is consumed by `runtime/` (and `compiler/`) for projection /
line / polygon / point / raster / text / icon / compute shaders. The authoring surface is deliberately
ceremony-free (TSL-grade): plain `const x = expr`, method ops + `.assign()`, `fn()` with inferred return
type, familiar `If`/`Switch` — see **`AUTHORING.md`** for the full guide.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | `@xgis/shader-dsl`, ESM, zero runtime deps; `main`/`exports` point at `src/index.ts` (source-only package — consumers type-resolve the TS directly). |
| `tsconfig.json` | Standalone TS project (extends the repo base); `tsc --build shader-dsl/tsconfig.json` is the canonical typecheck for this package. |
| `AUTHORING.md` | **The developer authoring guide** — `fn(name, params, body)` (ret inferred), `const x = expr` + auto-var, `.assign()`, contextual literal lift, `If`/`Switch`/combinators, the SoT helpers (`ioStruct`/`storageBuffer`/`structDecl`), typed const + fn handles. Start here before writing a shader. |
| `src/index.ts` | The public barrel — the ONLY import surface for consumers outside this package. Re-exports the finished shader graphs + the emit entry points; `core/` is private and never imported directly. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All source: `core/` (IR, the neutral emitter + backend contract, the pass pipeline, the SoT layer — private) and `shaders/` (concrete shader graphs). (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Read `AUTHORING.md` first** — the API is intentionally ceremony-free and several older patterns are gone
  (`Var`/`Let` names, `.field()`/`.of()`/`.get()`, `entryFn`/`computeFn`, `callFn('name')`, `constRef('PI')`,
  explicit `fn()` ret tokens, free `assign()`). Use the current form or you reintroduce removed ceremony.
- Emit changes split into TWO classes: **byte-identical** (pure authoring refactor — the WGSL snapshot suite
  IS the gate, no GPU needed) and **semantic** (the emitted WGSL text changes — needs the oracle parity gate
  AND a real-GPU render within the run-to-run self-diff floor; see the `.omc/skills/shader-dsl-*` skills).
- `core/` is private; never widen the public barrel to export it.

### Testing Requirements
- `node node_modules/typescript/bin/tsc --build shader-dsl/tsconfig.json` (canonical typecheck — NOT `npx tsc`).
- `npx vitest run --root .` (the shader-dsl specs run as part of the repo suite; expect ~6654–6657 pass,
  `merc-perf-p95` is a known local-only flake).
- WGSL byte-snapshots: `bun scripts/capture-polygon-snapshots.ts` rebakes the polygon variant goldens — only
  when a GENUINE emit change is intended.

### Common Patterns
- One IR, three backends, one tree-walk — any new emit feature must be added to the shared walk, not a single
  backend, or the CPU oracle / GLSL writer drift.
- The auto-var pass relies on Expr OBJECT IDENTITY; it runs on ALL THREE backends — never skip it on a new one.
- **Module constants** are scalar dual-precision by default (`ConstDecl.wgslValue` truncated vs `cpuValue`
  full-precision, e.g. `PI`). A non-scalar const (vec / array / struct) sets `ConstDecl.valueExpr` instead —
  a constant-foldable literal Expr that supersedes `wgslValue`/`cpuValue` on every backend (WGSL + GLSL emit
  it through the neutral `emitExpr`; the oracle evaluates it via the same tree-walk, consts populated in
  declaration order). Author one with the `constExpr(name, type, valueNode)` helper.

## Dependencies

### Internal
- Consumed by `runtime/src/engine/shaders/` and `compiler/` (projection/line/polygon/point/raster/text/compute).
- The projection spec list (projType order, globe flag, cull thresholds) is INJECTED by the host via
  `configureProjections()` — this package keeps ZERO outbound dependency (future standalone repo).

### External
- None at runtime (zero-dep by design). Dev-only: TypeScript, vitest, `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
