# Shader-DSL extraction → `@xgis/shader-dsl` (standalone, backend-agnostic)

**Goal (owner, 2026-06-21):** lift the shader DSL out of `runtime/` into its own
workspace package, positioned to later become a **standalone project** (own repo)
and a **multi-backend GPU library** (WGSL today; WebGL/GLSL later) — "a luma.gl-like
position." The DSL IR is the backend-neutral SoT; backends are plugins.

## Why it's feasible today

- The IR is already backend-neutral: `core/backends/wgsl.ts` (GPU string emit) +
  `core/backends/cpu.ts` (f64 tree-walk) prove two backends off one IR. A future
  GLSL/WebGL backend is one more `core/backends/glsl.ts` plugin — the IR is untouched.
- shader-dsl is nearly self-contained. **One** hard outbound runtime coupling.

## The one knot: `projections.ts` → `PROJECTIONS` table

`runtime/src/engine/shader-dsl/shaders/projections.ts` imports the projection
registry `runtime/src/engine/projection/projections-table.ts` and uses it at:

- `:239` `FLAT = PROJECTIONS.filter(!isGlobe)` → dispatch-ladder order (projType = index).
- `:50` `byName(n)` → `cullThreshold` for azimuthal/stereographic.

It needs only `{ name, projType, isGlobe, cullThreshold? }` per projection. A standalone
repo won't have `@xgis/shared` either, so **moving the table is a half-measure** —
the right fix is **inversion**: shader-dsl defines the `ProjectionSpec` contract and the
table is **injected**; shader-dsl ends with **zero outbound deps**, liftable anytime.

Duplicating the order inside shader-dsl (test-guarded) is rejected: it reintroduces the
exact drift the table-as-SoT was built to kill (AGENTS.md).

### `ProjectionSpec` (the injected contract)

```ts
export interface ProjectionSpec {
  name: string // maps to the internal proj_<name> IR fn (forwardCall switch)
  projType: number // == proj_params.x; dispatch-ladder index
  isGlobe: boolean // excluded from the 2D FLAT ladder
  cullThreshold?: number
}
export function configureProjections(specs: ProjectionSpec[]): void
```

The runtime's `PROJECTIONS` already structurally satisfies `ProjectionSpec`. Runtime
calls `configureProjections(PROJECTIONS)` once at engine init, before any shader emit.

`PROJECTION_WGSL_CONSTS/FNS`, `PROJECTION_MODULE`, and the generated `cpu-projections`
are consumed at **emit time** (inside `emitPolygonWgsl`/`emitLineWgsl`/… and the
CPU-proj functions), not at module load — so a lazy, post-configure build is safe.

## Layering (target)

`@xgis/shader-dsl` (zero outbound dep) ← `@xgis/runtime` (owns `PROJECTIONS`, injects it).
No cycle. `@xgis/shared`, `@xgis/compiler` unaffected. The `compiler` vertex-format
contract stays convention+test (no import coupling).

## Execution — two independently-green PRs

### PR-A — invert in place (the hard part, isolated; still inside `runtime/`)

1. Add `ProjectionSpec` + `configureProjections` seam to `projections.ts`; make
   `FLAT`/cull-consts/`PROJECTION_*`/`PROJECTION_MODULE`/`cpu-projections` lazily build
   from injected specs (default = imported `PROJECTIONS` for one transitional step).
2. Wire `configureProjections(PROJECTIONS)` at engine init (map.ts / engine bootstrap).
3. Flip the ~5 in-package consumers (polygon/line/point/raster/heatmap) + legacy
   `engine/shaders/projection.ts` re-export + playground e2e to the injected accessors.
4. Remove the direct `import { PROJECTIONS }`. shader-dsl now zero-outbound-dep.
   - **Gates (every step):** strict `tsc --build --force` · `bunx vitest run runtime/src/engine/shader-dsl/` (incl. polygon-variant-diff snapshots) · CPU-parity `_shader-math-parity.spec.ts` · full suite · no concurrent heavy jobs (one at a time).

### PR-B — mechanical relocation (no logic change)

1. Scaffold `shader-dsl/` package: `package.json` (`@xgis/shader-dsl`, `main: ./src/index.ts`,
   `type: module`), `tsconfig.json` (`extends ../tsconfig.base.json`, composite, refs).
2. `git mv runtime/src/engine/shader-dsl/** shader-dsl/src/**`.
3. Root wiring: add to `package.json` workspaces + root `tsconfig.json` references
   (before runtime). Vite alias `@xgis/shader-dsl` → `src` in playground + runtime vite
   config (else dev serves stale/none). `bun install`.
4. Rewire imports: runtime's 9 barrel importers + cpu-proj consumers `../shader-dsl`
   → `@xgis/shader-dsl`; shader-dsl-internal paths stay relative.
   - **Gates:** same stack, green.

## Later (not this work)

- PR-C: GLSL/WebGL backend plugin under `core/backends/`.
- PR-D: lift `shader-dsl/` to its own repo (git subtree/filter — clean once zero-dep).

## Risks / guards

- Init-order: `configureProjections` MUST run before first emit — assert-throw if a
  generated accessor is read unconfigured (loud, not silent-wrong).
- The projection/CPU-parity gates are this repo's highest-bug-density area (#392/#360/
  geoid) — PR-A keeps the IR math byte-identical; only the _source_ of specs changes.
  Polygon snapshot byte-equality + `_shader-math-parity` are the non-vacuous proof.
