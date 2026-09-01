# Shader DSL — improvement direction (2026-09-01)

**Status:** direction (owner asked for the improvement direction, advanced work welcome) ·
**Scope:** `shader-dsl/` and the seams its consumers depend on (`map/src/shaders/`,
`compiler/src/codegen/`, `rhi-*`) · **Horizon:** 5+ years (CLAUDE.md preamble) ·
**Discipline:** every claim below cites the file, issue, or measurement it rests on; a
number with no citation is not in this document.

This is the durable record (CLAUDE.md §9.5). It states where the DSL stands, what the
mature engines it is benchmarked against do differently, which directions are worth five
years of compounding, which are explicitly NOT, and how each direction is verified. It is
not a work order: each direction becomes its own issue before it starts, per §9.5.

---

## 0. Where it stands — measured on this tree, not remembered

| Quantity                    | Value                                                                                                                               | Source                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Core (non-test) size        | ~27.1k LOC / 230 files under `shader-dsl/src`; largest `backends/glsl.ts` 2233, `ir/node.ts` 2147, `ir/builder.ts` 1573             | `wc -l` on this tree                              |
| Unit suite                  | 137 files / 1544 tests, all green, 52 s                                                                                             | `npx vitest run --root . shader-dsl` on this tree |
| In-repo consumers           | `map/src/shaders/dsl`: 56 files / 13.7k LOC; `compiler/src/codegen`: 11 files; `rhi-webgpu/src/reflection-to-webgpu.ts`             | `grep -rl '@xgis/shader-dsl'`                     |
| `reflect()` callers         | 49 inbound (uniform-slot modules, bind-group registry, drapers, variant-family, semantic-diff)                                      | codebase-memory `trace_path reflect inbound`      |
| Escape hatches in consumers | 0 `rawStmt` / `b.raw` in `map/` + `compiler/` non-test code; 3 forced casts in `map/src/shaders/dsl`                                | `grep` on this tree                               |
| Committed baked shader text | 6 generated files, 742,525 bytes (`baked-{glsl,wgsl}-{boot,hillshade,lazy}.generated.ts`)                                           | `ls -la map/src/shaders/baked/`                   |
| External consumer           | dc4i.js: 41 portable entries across 26 modules, 4 `variantFamily` families, 0 raw GLSL files, `hostBlock`/`externVar` in production | #1806 (2026-08-18)                                |

**Capability standing, as the package itself states it** (`shader-dsl/README.md` taxonomy):
Author STRONG · Type-check STRONG · Optimize STRONG · Validate/lint STRONG · CPU-oracle
DISTINCTIVE · Reflect NEW · WGSL real and byte-stable · GLSL real for render pipelines ·
Multi-target (SPIR-V/MSL/HLSL) ASPIRATIONAL.

**The compile-time cost that shaped the last quarter.** Emitting one language runs
`validate → autoVars → lowerModule → fp64Lower → optimizer fixpoint` over the whole module
on every emit, on both backends (`shader-dsl/src/core/passes/opt/optimize.ts` header,
`map/src/render/material/wgsl-for.ts:10-15`). Recorded costs:

| Measurement                                                          | Where recorded                                |
| -------------------------------------------------------------------- | --------------------------------------------- |
| 58–184 ms per retained-family emit                                   | `map/src/render/material/wgsl-for.ts:85`      |
| `buildPolygonModule` 2 ms vs 80 ms for the vertex emit alone         | `map/src/render/material/wgsl-for.ts:115-116` |
| ~768 ms of discarded WGSL per WebGL2 session before the thunk seam   | `map/src/render/material/wgsl-for.ts:12-13`   |
| hillshade fixpoint 2211 ms → ~492 ms main-thread block after #1405   | `map/src/shaders/baked/seed-hillshade.ts:7`   |
| heatmap's three passes 33.9 ms (WGSL) / 38.4 ms (GLSL) at first draw | `map/src/shaders/baked/install.ts:106-107`    |

The baked store (`map/src/shaders/baked/`), its sync gates, body guards, download groups and
lazy prefetch exist because of these numbers. That subsystem is correct and well-gated; the
point for a five-year plan is that it is a **cache for a compiler that is too slow to run
where it runs**, and a cache has its own invariants to keep forever.

**What is already decided and must not be re-derived** (facts, per §9.5):

- Publish FROM the monorepo; the git-subtree mirror is the distribution today; a separate
  repository was rejected because the real-driver verification lives in `playground/e2e`
  (#1681, README).
- The compute tier is DECLARED (`portable: true`), never inferred from device capabilities;
  `run()` is async on every tier (#1903, `docs/plans/2026-08-18-portable-kernel-tier.md`).
- `semanticDiff` classifies declared production transforms rather than ignoring them
  (#1806 → #1807).
- `#define`-style preprocessing is answered by build-time specialisation, `override`
  constants, and fail-closed capabilities (`AUTHORING.md` §11).
- No house binary formats, ever (CLAUDE.md §12 custom-format trap).

---

## 1. The benchmark set — what mature systems do that this DSL does not (yet)

The CLAUDE.md preamble asks for every architectural decision to be benchmarked against
mature engines. For a shader DSL the relevant set is not Unreal's material graph alone; it
is the systems that solved each of this DSL's sub-problems:

| System                        | What it gets right that is relevant here                                                                                                                       | Where this DSL stands                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **three.js TSL**              | Node-graph authoring with method operators, WGSL + GLSL backends, and a GLSL→TSL transpiler tool for migrating hand-written shaders                            | Authoring parity (the TSL shape was the model); no importer                                                             |
| **TypeGPU**                   | Data schemas are the single authority for layout AND typed host-side writers; specialisation through typed slots; JS-syntax function bodies via a build plugin | `reflect()` gives offsets and the uniform-slot modules derive from it; no generated typed writer; slots are string tags |
| **Slang**                     | Generics, interfaces, modules, a capability system, reflection, and multi-target from one compiler                                                             | Capability system and reflection exist; no generics, no interfaces, no module/import system                             |
| **WESL**                      | Community WGSL extension — `import`s and conditional translation — becoming the module standard for WGSL                                                       | No import model; variants are `composeModule` placeholders and `variantFamily` records                                  |
| **naga / Tint**               | Validation with uniformity analysis; naga also turns WGSL into SPIR-V / MSL / HLSL / GLSL, which is why nobody else writes those backends                      | Validation is a lint engine plus real-browser compile gates; no uniformity analysis; no offline validator in vitest     |
| **Unity / Unreal**            | Shader variants are enumerated offline, stripped, and cached; runtime compilation is the exception, not the design                                             | Bake exists for three groups; runtime emit is still the default path a new draper gets                                  |
| **GraphicsFuzz / spirv-fuzz** | Compiler correctness by differential fuzzing over generated programs                                                                                           | Per-pass oracle tests and a GPU differential on fixed modules; no generated-program corpus                              |
| **Herbie / FPTaylor / Gappa** | Rigorous floating-point error analysis of a given expression                                                                                                   | An f64 oracle (which is not an f32 oracle, by its own header) and hand-built error budgets in skills                    |

The DSL's **distinctive assets** against that set are real and should be protected, not
diluted: the CPU oracle, emulated fp64 with unchanged authoring syntax, `semanticDiff`, the
declared portable compute tier, the host-boundary APIs (`hostBlock`, `externVar`,
`variantFamily`), the fail-closed capability profile, and the production emit plugins. Every
direction below either compounds one of these or removes a cost that they currently pay.

---

<!-- §2 directions and §3 sequencing are filled from the facet audits -->

## 5. Explicitly NOT — with the reason, so it is not re-proposed

| Not doing                                                                | Why                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MSL / HLSL / SPIR-V emitters**                                         | X-GIS is a web engine; WebGPU already runs on every native host through Dawn/wgpu, and WGSL → naga/Tint → MSL/HLSL/SPIR-V is a solved, maintained path. A third hand-written backend triples every parity gate for zero rendering surface. The README's "aspirational" row should be retired to "via naga/Tint", not built. |
| **JS-syntax authoring via a source transpiler** (TypeGPU's build plugin) | It couples authoring to a bundler plugin, breaks runtime emit and the `new Function` CPU tier's CSP story, and the ceremony audits (#740, #763) already settled the method-operator surface. Revisit only if authoring volume, not preference, makes it the bottleneck.                                                     |
| **A separate repository for the DSL**                                    | Rejected in #1681 with the reason that survives: the real-driver gates are X-GIS scenes.                                                                                                                                                                                                                                    |
| **Inferring the compute tier / capabilities at dispatch time**           | Rejected in #1903 and the portable-kernel design: it is the three.js silent-fallback failure mode that `rejected[]` exists to prevent.                                                                                                                                                                                      |
| **A house IR serialisation format on disk**                              | CLAUDE.md §12 custom-format trap. Bake artifacts stay the emitted target text plus a content hash; any IR cache is in-memory or plain JSON.                                                                                                                                                                                 |
| **Widening the public barrel with `core/` internals**                    | `shader-dsl/AGENTS.md`: `core/` is private; the API-surface gate (`src/api-surface.test.ts`) exists so the surface grows by decision, not accretion.                                                                                                                                                                        |

---

## 6. Verification discipline every direction inherits

- **Byte-identical vs semantic** emit changes stay two classes (`shader-dsl/AGENTS.md`): a
  refactor is gated by the golden/snapshot suites; a semantic change owes the oracle parity
  gate AND a real-GPU render on both backends (CLAUDE.md §5 — WebGPU runs headlessly here on
  SwiftShader; "no GPU here" is a false claim).
- **A witness is applied at the single producer** of the value it perturbs (§12, #2165) — a
  new pass or type is verified by cutting it and reading the failure message, not by
  observing green.
- **Consumers' gates, not the feature's** — a change to a shared path (emit, layout, inline)
  owes the polygon/line/point/icon/text compile-and-render gates, not the gate of the feature
  that motivated it (§12).
- **Bake after every shader edit-probe** (`bun run bake:shaders`, §12 #2117); an un-rebaked
  probe proves nothing about the page.
- **Every direction files its issue first** with the symptom, the root cause at `file:line`,
  what is ruled out, and the closing verification (§9.5) — this document is the index, not
  the ticket.

---

## 7. Open decisions for the owner

<!-- filled after the facet audits -->
