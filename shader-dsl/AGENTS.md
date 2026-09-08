<!-- Generated: 2026-06-23 | Updated: 2026-09-07 -->

# TypeShade (`@xgis/shader-dsl`)

## Purpose

A zero-dependency TypeScript shader DSL that eliminates hand-maintained GPU/CPU drift. A shader is authored
ONCE as a typed node graph (the IR); three backends then emit it over ONE shared tree-walk — a **WGSL**
writer (the production strings for `device.createShaderModule`), a **GLSL ES 3.00** writer (real for
render pipelines — vertex+fragment entry-IO + std140 UBO, WebGL2 compile+render-verified; a read-only
SSBO lowers to a data texture by default, compute emulation is opt-in, writes/unsupported shapes/MSAA
fail closed), and a **CPU f64 oracle** that walks the same IR on the host in double precision. The
authoring surface is deliberately ceremony-free (TSL-grade): plain `const x = expr`, method ops +
`.assign()`, `fn()` with inferred return type, familiar `If`/`Switch` — see **`AUTHORING.md`** for the
full guide.

## Key Files

| File                       | Description                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`             | `@xgis/shader-dsl`, ESM, zero runtime deps; `main`/`exports` point at `src/index.ts` (source-only package — consumers type-resolve the TS directly). Owns the three scripts below: `build`, `test`, `gate:compile`.                                                                                                                                      |
| `tsconfig.json`            | Standalone TS project; it extends the PACKAGE-LOCAL `tsconfig.base.json` — nothing tracked here may name a path outside this tree, or the vendored copy cannot compile. `tsc --build` (i.e. `bun run build`) is the canonical typecheck.                                                                                                                 |
| `vitest.config.ts`         | The suite config for this tree: `src/**` + `examples/**` specs, `testTimeout` 30 s — the df64 property suites sample random inputs for 8–16 s per test and fail on vitest's 5 s default.                                                                                                                                                                 |
| `scripts/compile-gate.ts`  | `bun run gate:compile` — emits every registered example and hands each emit to the compiler that would receive it in production: the WGSL to Tint (Chromium's headless WebGPU), both GLSL ES 3.00 stages to a real WebGL2 context. Each compiler is fed a deliberately broken shader FIRST, so a blind instrument fails the gate instead of greening it. |
| `.github/workflows/ci.yml` | CI: typecheck + unit suite, and the compile gate, on every push and pull request.                                                                                                                                                                                                                                                                        |
| `AUTHORING.md`             | **The developer authoring guide** — `fn(name, params, body)` (ret inferred), `const x = expr` + auto-var, `.assign()`, contextual literal lift, `If`/`Switch`/combinators, the SoT helpers (`ioStruct`/`storageBuffer`/`structDecl`), typed const + fn handles. Start here before writing a shader.                                                      |
| `src/index.ts`             | The public barrel — the ONLY import surface for consumers outside this package. Re-exports the finished shader graphs + the emit entry points; `core/` is private and never imported directly.                                                                                                                                                           |

## Subdirectories

| Directory | Purpose                                                                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`    | All source. `core/` holds the IR, the neutral emitter + backend contract, the pass pipeline and the SoT layer; the entry points beside it (`index.ts`, `dev.ts`, `compute.ts`, `emit-prod.ts`) are the public surface. Concrete shader graphs are NOT here — a consumer authors its own through this package. (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- **Read `AUTHORING.md` first** — the API is intentionally ceremony-free and several older patterns are gone
  (`Var`/`Let` names, `.field()`/`.of()`/`.get()`, `entryFn`/`computeFn`, `callFn('name')`, `constRef('PI')`,
  explicit `fn()` ret tokens, free `assign()`). Use the current form or you reintroduce removed ceremony.
- Emit changes split into TWO classes: **byte-identical** (pure authoring refactor — the emit goldens ARE the
  gate, no compiler needed) and **semantic** (the emitted text changes — needs the CPU-oracle parity gate AND
  a real compile through `bun run gate:compile`, so the new bytes are proven to still BE a program).
- `core/` is private; never widen the public barrel to export it.

### Testing Requirements

- `bun run build` — `tsc --build` (dist + `.d.ts`) then `tsc -p tsconfig.tests.json`, the noEmit pass over
  tests, examples and scripts. This is the canonical typecheck.
- `bun run test` — vitest over `src/**` and `examples/**` (146 test files).
- `bun run gate:compile` — every registered example emitted and compiled: WGSL on Tint, both GLSL ES 3.00
  stages on a real WebGL2 context. Needs the browser once: `./node_modules/.bin/playwright install --only-shell chromium`.

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

- **None at runtime** (zero-dep by design). Dev-only: `typescript`, `vitest`, `@types/node`, `@webgpu/types`,
  and `playwright` (the compile gate's browser).
- ZERO outbound dependency on any host, and it stays that way: what a host must supply — e.g. the projection
  spec list (projType order, globe flag, cull thresholds) — is INJECTED through `configureProjections()`,
  never imported.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
