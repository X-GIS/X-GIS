# X-GIS Pipeline — Package Responsibility Charter

> **Authority document.** Use this to judge whether a piece of code lives in the right
> package. When two packages both seem to "own" something, the **Cross-Cutting Boundary
> Rulings** (§4) settle it; the **Known Violations** table (§5) lists where today's code
> breaks these rules and the principled fix direction.
>
> Generated 2026-06-25 from each package's `AGENTS.md` charters + first-hand code reads.
> Updated 2026-06-29: the `@xgis/compiler → @xgis/shader-dsl` edge is now wired (§1, §5).
> Keep it in sync when a package's responsibility genuinely changes.

---

## 1. Pipeline overview

X-GIS compiles a **`.xgis` style source (or an imported Mapbox/MapLibre style) + GeoJSON/MVT
data** into deterministic GPU-ready artifacts, then paints pixels:

```
style → lex → parse → IR (lower / optimize / emit)
      → { SceneCommands, ShaderVariant strings, CompiledTile vertex layouts, palettes }
      → runtime upload → per-frame pass chain → pixels   (across 8 projection surfaces)
```

The internal dependency DAG is strictly **acyclic** with two leaves — `@xgis/shared`
(WGS84/ECEF math) and `@xgis/shader-dsl` (zero-dependency shader-authoring framework):

```
                 @xgis/runtime          (top: WebGPU/WebGL2 render engine)
                /      |       \
   @xgis/compiler   @xgis/shared   @xgis/shader-dsl
        |    \________/   |____________/
   @xgis/shared        (leaves: no internal deps)
        + @mapbox/vector-tile, pbf

   @xgis/compiler ──▶ @xgis/shader-dsl  (acyclic; now wired — see §5)
```

`@xgis/compiler` depends on `@xgis/shared` and `@xgis/shader-dsl` (+ `@mapbox/vector-tile`, `pbf`).
`@xgis/runtime` sits at the top and depends on all three. The `@xgis/compiler ──▶
@xgis/shader-dsl` edge is now present (shader-dsl is zero-dep and runtime already imports it,
so it is acyclic); adding it retired the bulk of the duplication tracked in §5.

---

## 2. The three charters

### `@xgis/compiler` — the GPU-free front-end
- **OWNS:** Everything from `.xgis`/Mapbox-style text to deterministic render artifacts —
  lexing, parsing, IR lower/optimize/emit, expression evaluation & Mapbox-expression
  semantics, color resolution, label formatting, the style-spec oracle, and the **data-side
  tiler** (clip/simplify/tessellate/pack into GPU vertex layouts).
- **DOES NOT OWN:** Any `GPUDevice` call or GPU resource (emits *strings & typed data* only);
  the shader IR/optimizer machinery (that is `@xgis/shader-dsl`'s); per-frame scheduling,
  draw calls, or projection-matrix math (runtime's). It **produces** artifacts; it never executes them.

### `@xgis/shader-dsl` — the content-free shader framework
- **OWNS:** The shader *machinery* — the typed IR (`Expr`/`Stmt`/`Decl`, `Node<K>`, `Builder`),
  the single neutral tree-walk emit, the `Backend` contract + WGSL/GLSL writers, the neutral
  intrinsic-spelling registry, the CPU-f64 oracle, the layout SoT (`sot.ts`) + reflection,
  and all passes (validate/caps/match-lower/lint/optimizer/cse/autoVars).
- **DOES NOT OWN:** Any *concrete application shader* (the polygon/heatmap/raster graphs live
  in runtime); any target *content* or domain knowledge; any GPU call or byte-offset *binding*.
  It is a framework that authors shaders once and emits to many backends — it carries **zero**
  X-GIS-specific graph.

### `@xgis/runtime` — the WebGPU/WebGL2 render engine
- **OWNS:** Everything that touches the GPU and the live map — device lifecycle, the camera +
  8 projection surfaces (CPU mirror), the renderer/pass chain, the tile data layer
  (cache/eviction/selection), the text/sprite stages, the data-ingestion loaders, and
  **authoring the actual X-GIS shader graphs** on top of the `@xgis/shader-dsl` framework
  (in `engine/shaders/dsl/`).
- **DOES NOT OWN:** The compiler's artifact production (it *consumes* `SceneCommands`/
  `ShaderVariant`/`CompiledTile`); the shader IR/backend/optimizer *machinery* (it *uses*
  `@xgis/shader-dsl`); style/expression semantics. It **executes** artifacts; it never re-derives them.

---

## 3. Per-module responsibility tables

### 3a. `@xgis/compiler`

| module | owns | consumes → produces | must NOT do (belongs to X) |
|---|---|---|---|
| **lexer** | Stage-1 tokenizer; token/keyword/unit vocabulary | `.xgis` string → `Token[]` | grammar/AST (→ parser); no regex/backtracking; keep Newline tokens |
| **parser** | Recursive-descent; AST node types; `parseExpressionString` | `Token[]` → AST | tokenizing (→ lexer); lower/eval (→ ir/eval) |
| **ir** | `lower→optimize→emit`; `PropertyShape`/`Dep`/`Scene` | AST + eval + spec → `Scene`, `SceneCommands` | WGSL (→ codegen); hardcoded spec defaults (→ spec); 4-stage order fixed |
| **ir/passes** | Deterministic `Scene→Scene` opt (CSE/DCE/fold/merge) | `Scene` → `Scene` | order outside declared deps; keep analysis/rewrite split |
| **codegen** | Compiler back-end: `RenderNode → ShaderVariant`/compute-kernels/palettes (pure strings); authors kernel bodies via the `@xgis/shader-dsl` IR | optimized `Scene` → `ShaderVariant`, `ComputeKernel` | **never touch `GPUDevice`**; IR/classification (→ ir); **must not re-spell emission — the residual hand copy in `node-to-wgsl.ts` is test-only, see §5** |
| **eval** | Mapbox/MapLibre expression evaluator; `reserved-keys` SoT | AST + props → `evaluate(...)` | side effects; helper→evaluator cycle |
| **format** | `{expr:spec;locale}` label templates; `formatValue` (number/date/GIS DMS) | spec + values → `formatValue` | evaluate embedded expr (→ eval) |
| **tiler** | clip/simplify/earcut/pack into 3 vertex layouts; **vertex-format + dequant mirror SoT** | GeoJSON + shared → `CompiledTileSet` | GPU dep; import runtime (math is intentionally bit-duplicated); earcut Mercator-only |
| **tiler/geojsonvt** | 1:1 ISC port of geojson-vt 4.0.2 + `encodeMVT` | GeoJSON → index + MVT bytes | modernize ported files / drop ISC provenance |
| **input** | MVT/`.pbf` decoder; un-quantize; flatten layers | PBF + z,x,y → `GeoJSONFeature[]` | **only place allowed `@mapbox/vector-tile`/`pbf`**; tile/pack (→ tiler) |
| **convert** | Mapbox v8 importer → `.xgis`; `MAPBOX_COVERAGE` | Mapbox JSON → `.xgis` + warnings | lower/render (→ ir); throw across a style |
| **diagnostics** | Read-only optimization profiler → `StyleProfile` | `Scene` → `StyleProfile` | mutate; GPU |
| **binary** | `.xgb` serialize of the **runtime command form** | `BinaryScene` → `serializeXGB` | serialize IR `Scene` (it's the command form); bump VERSION on layout change |
| **tokens** | Sole color-resolution layer → canonical hex; invertible Lab/LCh | color str → `resolveColor` | throw (returns `null`); interpolate/classify paint (→ ir/eval) |
| **schema** | `LANGUAGE_SCHEMA` of the 8 `.xgis` constructs | mirrors `parser/ast.ts` | editor-presentation fields (→ `@xgis/blueprint`) |
| **spec** | Style-spec SoT oracle; `zero-semantics` | spec lib + tokens → `specDefault` | **anything here reaching the runtime bundle** |
| **module** | `.xgis` import resolver | AST + injected reader → `resolveImports` | **call `fs`/`fetch`** (host injects I/O) |

### 3b. `@xgis/shader-dsl`

| module | owns | must NOT do |
|---|---|---|
| **core/ir** | Typed IR authoring (`ShaderType`/`Node<K>`/`Builder`/`fn`/`module`) | carry target lexemes (→ backend); walk/emit (→ emit); **concrete app shaders (→ runtime)** |
| **core/emit.ts** | The ONE neutral tree-walk + module assembly; control flow spelled once | re-implement per-backend; spell types/literals/intrinsics; let `matchExpr` reach it un-lowered |
| **core/backend.ts** | The `Backend` contract + `Capabilities` + `UnsupportedFeatureError` | hold concrete spelling or the walk (→ backends/*) |
| **core/intrinsics.ts** | Neutral intrinsic-spelling registry (SoT) | own type/literal/decl spelling; a divergent builtin = ONE entry here |
| **core/oracle.ts** | `compileModule → CpuModule` (f64 algebra oracle) | be treated as an f32 oracle (BLIND to f32 GPU rounding, #392/#360) |
| **core/sot.ts** | Layout SoT (declare IO/uniform/storage once → decl+binding+typed field) | compute byte offsets/std140 (→ reflect); emit/bind on GPU |
| **core/reflect.ts** | `reflect()` → bind-group/byte-layout/vertex-attr; offset engine | **be on an emit path** (pure + additive; only recovers) |
| **core/backends/wgsl.ts** | WGSL `Backend` + canonical module assembly; `emitModule` | fork the neutral walk (spelling + fragments only); author app shaders |
| **core/backends/glsl.ts** | GLSL ES 3.00 `Backend`; std140 UBO (fed by `reflect`) | duplicate the walk / locally rename intrinsics; SSBO/compute/MSAA fail closed |
| **core/passes/opt** | `cse` + `autoVars` (wired into emit); `optimize()` (GPU-parity gated) | put heavy `optimize()` on emit path without the real-GPU gate; skip `autoVars` on a new backend |
| **core/passes/lint** | Lint engine (registry + shared traversal, ~20 rules) | transform IR (read-only) |
| **core/passes** (validate / required-caps / match-lower / single-exit / inline) | Pre-emit transforms/gates | spell/emit (→ backends); run after emit |

### 3c. `@xgis/runtime`

| module | owns | must NOT do |
|---|---|---|
| **engine** (orchestration) | `XGISMap` lifecycle + decompositions; AST→SceneCommands interpreter; safety | emit draw calls (→ render); projection/camera math (→ projection); author WGSL (→ shaders/dsl) |
| **engine/gpu** | WebGPU infra: device init, blend/stencil/MSAA, `GPUArena`, staging, bind-tier, palette upload, `ComputeDispatcher` | tile selection / per-renderer draw (→ render); projection math/WGSL (→ projection, shaders/dsl) |
| **engine/projection** | Camera math + 8 projection surfaces; `PROJECTIONS` authority table; CPU fwd/inv; globe | **author WGSL projection fns** (→ shaders/dsl is the GPU SoT; this is the CPU mirror); branch on projType instead of the table |
| **engine/render** | Every GPU draw-call renderer; pass scheduling; pipeline factory; vertex-format descriptors | own projection/camera math (→ projection); inline-copy WGSL (import from shaders/); vertex-format must be byte-identical to WGSL `@location` |
| **engine/render/passes** | The fixed linear pass chain; stateless singletons; clear/depth/MSAA contracts | hold per-frame state (→ FrameContext/SceneView); re-clear color outside bg pass |
| **engine/shaders** | Thin re-export shim of DSL-emitted WGSL snippets + 2 CPU log-depth helpers | contain hand-written WGSL/projection/SDF math — re-export only (graphs in shaders/dsl) |
| **engine/shaders/dsl** | **Authors every X-GIS shader graph** on `@xgis/shader-dsl`; one IR → WGSL + f64 CPU mirror | own IR/backend/optimizer (→ `@xgis/shader-dsl`); hand-maintain the CPU mirror (`cpu-projections` is GENERATED); `configureProjections()` before first emit |
| **engine/text** | SDF text pipeline (resolve/shape/wrap/collide/raster/atlas) + quad draw; `TextStage` | projection (screen-px only); hardcode vertex layout (derive from `TEXT_FORMAT`) |
| **engine/sprite** | Sprite/icon protocol + atlas + batched raster+SDF draw; `IconStage` | projection; split raster+SDF into 2 pipelines |
| **engine/state** | `DirtyDomains` 8-domain invalidation bitset | drive per-frame skips yet (write-only at S3) |
| **data** | CPU tile data layer: catalog/cache, LRU+byte eviction, over-zoom, frustum select, polar-cap synth | GPU types/upload (→ render/VTR); frustum projection beyond table lookups (→ projection) |
| **loader** | Ingestion: GeoJSON earcut + great-circle; vector source (SSRF/size guards); `visibleTilesSSE` | skip SSRF/body-cap; GPU upload (returns CPU buffers) |
| **core** | GPU-free CPU primitives for renderers + workers: line-segment packing, ECEF extrusion, priority queue | import `@webgpu/types`/WGSL (worker-imported); stride out of sync with WGSL `LineSegment` |
| **web** | `<xgis-map>` custom element (Shadow-DOM canvas + overlay) | contain real render logic (thin DOM wrapper) |

---

## 4. Cross-cutting boundary rulings

| # | seam | RULE — owner | why |
|---|---|---|---|
| **a** | Shader IR (`Expr`/`ShaderType`/`Node`/`Builder`) | **`@xgis/shader-dsl/core/ir` is the SOLE owner.** No other package may define a parallel IR type. | One typed IR is the whole point of the framework — a second copy is drift by construction. |
| **b** | WGSL/GLSL string emission | **`@xgis/shader-dsl/core/emit` + `core/backends/*` own all emission;** consumers receive strings, never spell them. | Control flow is spelled once over a neutral walk; any per-package `emitExpr` re-implementation re-introduces the divergence the DSL exists to kill. |
| **c** | The shader optimizer (cse/autoVars/optimize) | **`@xgis/shader-dsl/core/passes/opt` owns it;** it runs inside backend emit, gated by the real-GPU parity test. | Optimization is IR→IR machinery, not application logic. |
| **d** | The intrinsic registry (per-target spelling SoT) | **`@xgis/shader-dsl/core/intrinsics.ts` owns it;** a divergent builtin is ONE entry, never a hardcoded per-writer name. | Single spelling SoT prevents `call`/`select` drift. |
| **e** | Shader **authoring** (the polygon/heatmap/raster/text graphs) | **`@xgis/runtime/engine/shaders/dsl` owns it.** | The framework is content-free; the graphs are X-GIS domain content and belong to the renderer that runs them. |
| **f** | GPU compute-kernel generation for the tiler | **`@xgis/compiler/codegen` owns *which* kernels to emit; the WGSL body must be authored through the `@xgis/shader-dsl` IR**, not raw strings. | Kernel *selection* is a compile-time artifact decision (compiler); kernel *spelling* is shader emission (shader-dsl). |
| **g** | Mapbox-expression / color parsing & CPU eval | **`@xgis/compiler` owns it: `eval/` (expressions), `tokens/` (color), `spec/` (semantics).** | Deterministic, GPU-free, style-semantic concerns — the compiler's core competency. `colorHexToRGBA` belongs to `tokens/`. |
| **h** | Tiling / geometry (clip/simplify/tessellate/pack) | **`@xgis/compiler/tiler` owns the vertex-format byte-contract SoT + CPU dequant mirror; `@xgis/runtime` consumes `CompiledTile`.** | Tiling is GPU-free data compilation (compiler); runtime layouts must stay byte-identical, never fork. |

---

## 5. Known violations (2026-06-25)

| violation (where) | what it is | rule broken | fix direction |
|---|---|---|---|
| `compiler/src/codegen/node-types.ts` | ~~hand-copy of shader-dsl `Expr`/`ShaderType`~~ — **RESOLVED**: now imports `Expr`/`ShaderType` from `@xgis/shader-dsl` (only the compiler-local `rawString` op is added) | **(a)** | done — the acyclic `compiler → @xgis/shader-dsl` dep is wired |
| `compiler/src/codegen/node-to-wgsl.ts` | copy of `emitExpr` (drifted: array spacing; **hardcodes `call`/`select`** vs the intrinsic registry). Now **test-only** — the production renderer splice-point retired (PR 2e.B.2); survives as an emit-shape oracle | **(b) + (d)** | **delete + dedup**: assert against the package backend instead of the hand copy |
| `compiler/src/codegen/compute-gen.ts` | ~~compute kernels built as **raw WGSL strings**~~ — **RESOLVED**: kernel bodies now authored through the shader-dsl IR (`emitTernaryComputeKernel` → `matchExpr` → WGSL switch), inheriting cse/autoVars; compiler keeps only *which* kernel | **(b) + (c) + (f)** | done — IR-routed |
| `runtime/.../shaders/dsl/compute-match.ts` | an **unwired IR twin** of the compiler's compute kernel (PoC, test-only) | **(f)** | **dedup + wire** (finish "Phase 2.5") **or delete** the unwired twin — do not keep both |
| `colorHexToRGBA` (triplicated) | same color→RGBA helper copied in 3 places; the runtime copy already drifted (named colors → black) | **(g)** | **dedup**: single definition in compiler `tokens/`; others import it |
| provenance comments citing `runtime/src/engine/shader-dsl/` | a **dead path** (the package was extracted to `/shader-dsl/`) | meta (extraction debt) | **repoint** the references; the "import would create a cycle" excuse is stale |

**Root cause:** *extraction debt.* When `shader-dsl` was lifted out of `runtime/` into the
standalone zero-dependency package, `compiler/codegen`'s copies were missed by the move, and
their justifying "importing would create a cycle" became false the moment the package shipped
zero-dependency. **The highest-leverage fix — adding the acyclic
`@xgis/compiler → @xgis/shader-dsl` edge — has now landed**, retiring violations (a) and (f)
(node-types imports the IR; compute-gen routes through it). What remains is the test-only
`node-to-wgsl.ts` emit-shape oracle (b)/(d): re-point it at the package backend. A dedup
caveat: `shader-dsl`'s `core/` is documented as private, so the dedup either consumes the
`./core/*` package subpath export or formally exposes the IR + emit through the public barrel.
