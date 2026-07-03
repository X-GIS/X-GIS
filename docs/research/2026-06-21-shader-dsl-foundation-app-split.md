# Content-blind runtime: the engine / content split (game-engine model)

**Date:** 2026-06-21
**Status:** PLAN — execution held (user: "먼저 계획만, 실행 보류")
**Owner directives:**

- "shader dsl 은 luma.gl이나 C++처럼 바탕을 제공해야하는데 지금 보니 실제 지도 렌더링 기능을 포함하고 있습니다."
- "런타임은 무엇을 렌더하는지 아예 몰라야한다고 생각합니다 … 게임 엔진도 무엇을 렌더하는지 모르잖아요."

---

## 0. North star — runtime must not know WHAT it renders

A game engine renders meshes/materials/draw-calls; it does not know it is drawing a "car."
The map-specific precedent is **luma.gl (generic GPU) ↔ deck.gl (map content)**. Today
`runtime` is fused: it is both the engine AND it hardcodes "I draw map polygons / lines /
labels / OFM styles." The target is a **content-blind runtime** with the map as pluggable
content.

**This is a product requirement, not just cleanliness** (owner: "지도 위에 포토리얼리스틱한걸
나중에 올리거나 게임으로 만들 가능성 … 실제 웹 환경의 게임까지도 생각"). `runtime` is to become a
general-purpose web-GPU engine; **the map is one content domain among several to come**
(photorealistic 3D, a web game). The engine MUST be domain-blind because future content
packages (`@xgis/game`, a photoreal package, …) will sit beside `@xgis/map` on the same
engine. So `@xgis/map` is not "the app" — it is the first of N content domains; the engine
may never name any of them.

### Target tiers

| Tier                               | Knows                                                                                                                                                                                   | Does NOT know                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `@xgis/shader-dsl` (foundation)    | GPU shader IR, backends, oracle                                                                                                                                                         | maps, renderers                                 |
| `runtime` (engine, content-blind)  | device, pipeline/bind-group, passes, frame loop, arena/resources, draw submission, generic camera/view+proj matrices, the `render-node`/`render-stage` abstraction, surface/device-loss | polygon, line, tile, style, OFM, map-projection |
| `@xgis/map` (content = the "game") | the shaders (polygon/line/point/…), domain renderers (map data → draw-calls), the style system, the tile pipeline, sprite/glyph, **map projection** (Mercator/globe/geoid)              | —                                               |
| app / public API                   | assembles `XGISMap` from engine + map content                                                                                                                                           | —                                               |

The engine consumes `render-node`s and submits them; it never names a domain object.
`@xgis/map` registers its renderers/shaders into the engine.

### Two honest caveats (the hard parts)

1. **Map projection is the real seam.** Mercator/globe/geoid + in-shader per-vertex
   reprojection is woven across the engine (camera matrices), the shaders, and data
   (tile-select). Evidence: `projection/projections-table.ts` is consumed by 10+ files
   spanning `data/tile-select`, `engine/camera`, `engine/gpu`, `map.ts`, and projection
   tests — and this seam is the repo's **#1 bug-density area** (#392 fill-displace, #360
   polar-cap, geoid). A content-blind engine requires _map_ projection to live in `@xgis/map`
   while the engine keeps only generic view/proj matrices. Achievable, but the riskiest cut —
   gate it on the real-GPU render-parity matrix.
2. **The generic draw abstraction must stay zero-overhead.** The `render-node`/`render-stage`
   DSL already exists, so the boundary is partly built; the rule is no per-frame cost added
   by the engine/content seam.

### Phasing (whole-codebase, multi-phase — not one PR)

`runtime/src/engine` is 139 files / 44.6K LOC. The split is staged:

- **Phase 1 (this plan, concrete, low-risk):** the 21 **self-contained** shaders (verified:
  zero imports of any renderer/gpu/data — only the foundation `core/*` + sibling shaders)
  move out of `@xgis/shader-dsl` into the content layer (`@xgis/map` seed). `@xgis/shader-dsl`
  reverts to foundation-only. Same mechanical cost as a runtime-folder move, but lands in the
  correct tier — a sibling package, not runtime bulk.
- **Phase 2:** extract the domain renderers (`engine/render`, the shader-consuming pipeline
  factories) into `@xgis/map`; the engine keeps generic device/pipeline/passes.
- **Phase 3 (the hard seam):** split map-projection (content) from generic camera matrices
  (engine). Gated on the render-parity matrix.
- **Phase 4:** `runtime` becomes the content-blind engine; `@xgis/map` plugs in via a
  registration API; the public-API app assembles the two.

### Priority — map spec 100% comes first; the game is far-future

Owner (2026-06-21): "게임은 매우 나중으로 미루고 지도 본연의 사양을 100% 지원하는 것을 목표."
The content-blind / game-engine vision (§0) is the **long-term north-star** — it is recorded
now so near-term structure does not paint us into a corner. But the **current execution goal
is the MapLibre/Mapbox style-spec 100% campaign**, and the architecture re-org must NOT compete
with it:

- **Phase 1 (the shader split) is north-star-compatible AND spec-campaign-safe** — it only
  un-inverts `@xgis/shader-dsl` (foundation vs content) with a byte-identical WGSL guard. It
  does not touch projection, renderers, or the spec pipeline, so it can land without slowing
  spec work. Low-risk, self-contained, immediate cleanup win.
- **Phases 2–4 are deferred behind the spec campaign** — the renderer extraction and especially
  the projection seam (Phase 3) are high-risk and would directly contend with spec-compat render
  work. Do them only once they no longer compete (and the game becomes a real near-term target).

The rest of this document specifies **Phase 1** (the shader split) in detail. Phases 2–4 are
the north-star roadmap above; each is its own design pass before execution.

---

# Phase 1 — shader split (foundation ⇄ content), detailed spec

---

## 1. The problem (confirmed with evidence)

`@xgis/shader-dsl` is **inverted**. A foundation toolkit (luma.gl, a C++ base lib) must
expose its _machinery_ and contain _zero_ application shaders — the app authors its shaders
on top. The package today does the opposite:

- **`src/index.ts` exports the 21 X-GIS map shaders as the package's public API** —
  `projections`, `polygon` (61K), `line` (63K), `point` (26K), `heatmap-*`, `raster`, `icon`,
  `text`, `sdf`, `compute-match`, `log-depth`, `ecef`, `oit-compose`, `overdraw-*`, … — and
  its header comment explicitly states _"the IR authoring layer (core/ir, backends, schema)
  is internal and not part of the public surface."_ That is exactly backwards.

- **Consumer audit (51 import sites: 43 runtime + 8 playground):**
  - **~45 consume the map shaders** — 26 via the bare barrel (symbols `projectWgsl`,
    `emitRasterWgsl`, `emitLineWgsl`, `emitHeatmapAccumWgsl`, `cosC`, `needsBackfaceCullWgsl`,
    `configureProjections`, …) + ~34 via `@xgis/shader-dsl/shaders/*` direct subpaths.
  - **only 6 consume the foundation** — `core/oracle`×2, `core/ir`×2, `core/backends/wgsl`×2,
    across 4 files (`render/pipeline-factory.ts` + 3 runtime tests).

The package is being used as a **shader library**, not a foundation. The framework (the DSL)
and the application (X-GIS's map shaders) are fused in one package.

---

## 2. Target architecture

### `@xgis/shader-dsl` = the foundation only

Contains **`core/` and nothing else** — the domain-neutral DSL toolkit:

| Layer             | Files                                                   | Public API                                                                                                                     |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| IR authoring      | `core/ir/{types,nodes,node,builder}` (barrel `core/ir`) | `fn`, `module`, `Node`, the type constructors, builder helpers                                                                 |
| Backends          | `core/backends/{wgsl,glsl}`                             | `wgslBackend`, `glslEs300Backend`, `emitModule`, `emitGlslModule`, `wgslType`, `f32Lit`, `emitExpr`, `UnsupportedFeatureError` |
| Backend contract  | `core/backend.ts`                                       | `Backend`, `Capabilities`, `Capability`                                                                                        |
| Neutral emit walk | `core/emit.ts`                                          | `emitExpr`, `emitStmt`, `emitBody`, `forHeader`                                                                                |
| Oracle            | `core/oracle.ts`                                        | `compileModule` (f64 differential ground truth)                                                                                |
| Passes            | `core/passes/match-lower.ts`                            | `lowerModule`                                                                                                                  |
| Schema            | `core/schema.ts`                                        | the IR schema types                                                                                                            |

**No projection. No polygon. No map domain knowledge.** Adding a target = one file under
`core/backends/`. This is the luma.gl / naga position.

### The 21 map shaders → `@xgis/map` (content)

`projections`, `cpu-projections`, `polygon`, `line`, `point`, `sdf`, `icon`, `text`, `raster`,
`raster-color`, `heatmap-accum`, `heatmap-blur`, `heatmap-compose`, `compute-match`,
`log-depth`, `ecef`, `frame-uniform`, `oit-compose`, `overdraw-fs`, `overdraw-compose`,
`_polygon-fixtures` — these are the map domain's shader **graphs authored using**
`@xgis/shader-dsl`. They move into the new **`@xgis/map`** content package (the first content
domain — see §0) and consume the foundation as a dependency. They are **self-contained**
(verified: zero imports of any runtime renderer/gpu/data — only `core/*` + sibling shaders),
so they seed `@xgis/map` cleanly without dragging the renderers/data/loader along.

**Rule (no exceptions):** even `sdf` and `log-depth` are concrete graphs → application content.
The foundation holds _no_ concrete shader.

---

## 3. Open decisions

1. **Where do the 21 shaders live? — RESOLVED: a new `@xgis/map` package** (§0). They are
   self-contained (depend only on the foundation), so they form a clean content package rather
   than runtime bulk; this is also required by the content-blind north-star (the engine must
   not contain map shaders). Package mirrors `shared/`: `package.json` (`@xgis/map`, `private`,
   `type: module`, `build: tsc --build`), `tsconfig.json` (composite, `extends ../tsconfig.base`),
   dep on `@xgis/shader-dsl`. Added to root `workspaces` + `tsconfig` references.

2. **`configureProjections` seam — KEEP it** (reversed from the earlier runtime-folder
   assumption). The `projections-table.ts` is consumed by 10+ runtime files (`data/tile-select`,
   `camera`, `gpu`, `map.ts`, projection tests) — it is cross-cutting map-projection knowledge,
   the exact thing the **Phase-3 projection seam** must untangle. We do NOT solve that in
   Phase 1. So the table stays in `runtime` for now; `@xgis/map`'s `projections.ts` keeps the
   injected-`ProjectionSpec` seam (PR-A/PR-B #487/#488) and stays zero-dep on runtime; `runtime`
   injects via `configureProjections(PROJECTIONS)` (constructor) — the same wiring as today, just
   pointed at `@xgis/map`. Dropping the seam now would force the table into `@xgis/map` and make
   runtime depend on content (backwards) → deferred to Phase 3. (Note: this means runtime↔@xgis/map
   is not yet a strict one-way DAG on projection — runtime still _constructs_ the spec list. That
   residual is precisely the Phase-3 work, and it is contained to the projection table.)

3. **Cruft:** `shader-dsl/src/.omc/state/...` — session state accidentally committed into the
   package src. Remove it as part of the move (it is not package content).

---

## 4. Move map (precise)

**Stay in `@xgis/shader-dsl`:** all of `src/core/**` (12 source files + 7 tests:
`core/ir/*.test`, `core/backends/glsl.test`, `core/backends/projection-3way.test`).

**Move to `@xgis/map/src/`** (new package; `git mv`, preserve history):

- 21 shader source files `src/shaders/*.ts` (excl. tests).
- 12 shader tests: `polygon-dsl`, `polygon-variant-diff`, `polygon-worldcopy-fill`, `line-dsl`,
  `line-pattern-reachable`, `point-dsl`, `heatmap-dsl`, `icon-dsl`, `oit-compose-dsl`,
  `raster-dsl`, `sdf-dsl`, `text-dsl`.
- the byte-identity snapshot dir `src/shaders/__polygon-variant-snapshots__/`.

**Delete:** `src/.omc/` (committed cruft).

---

## 5. Public-API redesign

**`shader-dsl/src/index.ts`** — flip from re-exporting `./shaders/*` to re-exporting the
foundation:

```ts
// @xgis/shader-dsl — the backend-neutral shader IR toolkit (foundation, no app shaders)
export * from './core/ir' // fn, module, Node, type ctors, builder
export * from './core/backend' // Backend, Capabilities, Capability
export * from './core/emit' // emitExpr/emitStmt/emitBody/forHeader
export * from './core/backends/wgsl' // wgslBackend, emitModule, wgslType, f32Lit, emitExpr…
export * from './core/backends/glsl' // glslEs300Backend, emitGlslModule, UnsupportedFeatureError
export * from './core/oracle' // compileModule
export * from './core/schema'
// passes/match-lower stays internal (consumed by the writers); export only if a consumer needs it
```

**`package.json` exports:** keep `"."`, keep `"./core/ir"`; the `"./*": "./src/*.ts"` wildcard
already resolves every `core/**` subpath (`core/oracle`, `core/backends/wgsl`, …). The
`./shaders/*` subpaths simply disappear with the files.

---

## 6. Rewire (4 mechanical classes)

1. **Shader-internal `../core/*` → package import** (22 files, 40 import lines:
   `../core/backends/wgsl`×17, `../core/ir`×18, `../core/oracle`×4, `../core/schema`×1).
   On move they become `@xgis/shader-dsl` (or `@xgis/shader-dsl/core/*`). This is the inverse
   of the PR-C rewire.
2. **External shader importers → `@xgis/map`** (~45 sites): the 26 bare-barrel imports + the
   ~34 `@xgis/shader-dsl/shaders/*` subpath imports repoint to `@xgis/map` (a package import;
   add the workspace dep to `runtime` + the vite alias to playground). Audit each of the 26
   bare-barrel imports — all sampled symbols are shader content, so all 26 repoint.
3. **Foundation importers — untouched** (6 sites in 4 files): `core/oracle`, `core/ir`,
   `core/backends/wgsl` subpaths still resolve from `@xgis/shader-dsl`. No change.
4. **Barrel flip + seam re-point** (§5, §3.2): `@xgis/shader-dsl/src/index.ts` → foundation API
   (drop the `./shaders/*` surface); `@xgis/map` re-exports the shaders. The `configureProjections`
   seam is KEPT — its import just moves `@xgis/shader-dsl` → `@xgis/map` (`map.ts:10`, vitest
   setupFiles, e2e specs); the projection table stays in runtime (§3.2).

**Also:** move/rewrite `shader-dsl/src/AGENTS.md` (it documents the shaders + the table coupling,
which is leaving); arch-ratchet `LOC_CEILINGS` — the relocated shaders re-enter runtime's ceiling
set (re-run for exact figures; `polygon.ts`/`line.ts` ceilings return to runtime).

---

## 7. Verification (the byte-identity guard travels WITH the shaders)

The proof that the move changed nothing is the **`polygon-variant-diff` snapshot** —
it byte-compares emitted WGSL against `__polygon-variant-snapshots__/`. It moves to runtime
and **must stay byte-equal** (the shaders emit the same WGSL; only their _location_ and the
_source_ of the projection table changed). Run sequentially (never concurrent — a vitest+tsc
race froze the machine earlier):

1. **Canonical tsc** — `node node_modules/typescript/bin/tsc --build` (all packages; NOT
   npx/bunx). Catches every dangling import from the rewire.
2. **shader-dsl suite** (foundation only now) — `bunx vitest run shader-dsl/` — core/ir + glsl +
   3-way differential still green; package is self-contained (no runtime import).
3. **runtime suite incl. the relocated shaders** — `bunx vitest run runtime/` — the moved
   `polygon-variant-diff` snapshot byte-equal + all shader-dsl tests green at the new path.
4. **Real-GPU executed-WGSL parity** — `cd playground && bunx playwright test
_shader-math-parity.spec.ts _flat-mercator-flatness.spec.ts` (headed Chrome) — emitted WGSL ↔
   CPU-f64 unchanged after the move (the seam is kept; projection math untouched).
5. **Build exit 0** — `bun run build` (all packages).

**Exit proof:** polygon snapshot bytes unchanged + `_shader-math-parity` green + canonical-tsc
clean + `grep -r "shaders/" shader-dsl/src` empty (foundation holds no shader) + `grep -r
"@xgis/shader-dsl/shaders" runtime playground` empty (no stale subpath).

---

## 8. Risks (ranked)

1. **Atomicity.** The barrel flip and the shader move are coupled — the barrel can't export
   shaders that have left. One PR, not a stack. A temporary package→runtime re-export would
   recreate the very coupling we are removing → forbidden. Mitigate with the byte-identity gate.
2. **The ~45-site shader rewire** — mechanical but wide. tsc --build (canonical) + the moved
   snapshot are the catch. Use a scripted in-place rewrite (the PR-C perl approach, reversed).
3. **Seam removal touches projection math** — the repo's highest bug-density code (#392, #360).
   Behavior is identical (the graph reads the same table, just directly). The real-GPU
   `_shader-math-parity` + the byte-equal snapshot are non-vacuous proof.
4. **playground vite alias** — the new runtime path must resolve in dev; add/adjust the alias
   before the dev-serve check or playground serves stale shaders.
5. **arch-ratchet drift** — shaders re-entering runtime's ceiling set; re-run for exact numbers.

---

## 9. Sequencing

Single atomic PR (the barrel flip ⇄ shader move are inseparable). Internal order:

1. Scaffold the `@xgis/map` package (package.json/tsconfig mirroring `shared/`; root
   workspaces + tsconfig refs; dep on `@xgis/shader-dsl`).
2. `git mv` the 21 shaders + 12 tests + snapshot dir `@xgis/shader-dsl/src/shaders/` →
   `@xgis/map/src/`; delete `@xgis/shader-dsl/src/.omc/`.
3. Rewire class 1 (shader-internal `../core` → `@xgis/shader-dsl`).
4. Flip `@xgis/shader-dsl` `index.ts` to the foundation API (drop `./shaders/*`); `@xgis/map`
   `index.ts` re-exports the shaders.
5. Rewire class 2 (~45 external shader importers → `@xgis/map`); add the runtime workspace dep +
   playground vite alias.
6. Re-point the `configureProjections` seam import `@xgis/shader-dsl` → `@xgis/map` (KEEP the
   seam; table stays in runtime — §3.2).
7. Move/rewrite AGENTS.md; fix arch-ratchet ceilings.
8. Verify §7 (sequential). Per-PR merge approval per the standing cadence.

**Net effect:** `@xgis/shader-dsl` becomes a true foundation — a backend-neutral shader IR
toolkit with zero map-domain content, ready to be lifted to its own repo and to grow
SPIR-V/MSL backends, exactly the luma.gl position the owner asked for.
