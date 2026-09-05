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

How it was produced: five facet audits (IR/type system, emit backends, optimizer passes,
CPU oracle/compute/fp64, consumers/DX) read the source directly with `file:line` evidence;
every defect they reported was re-reproduced by the session lead before it was filed
(#2274, #2275, #2276). Claims marked _reported, not re-verified_ come from an audit and were
not independently reproduced.

---

## 0. Where it stands — measured on this tree, not remembered

| Quantity                    | Value                                                                                                                                                                                                                                      | Source                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Core (non-test) size        | ~27.1k LOC / 230 files under `shader-dsl/src`; largest `backends/glsl.ts` 2233, `ir/node.ts` 2147, `ir/builder.ts` 1573                                                                                                                    | `wc -l` on this tree                                  |
| Unit suite                  | 137 files / 1544 tests, all green, 52 s                                                                                                                                                                                                    | `npx vitest run --root . shader-dsl` on this tree     |
| In-repo consumers           | `map/src/shaders/dsl`: 56 files / 13.7k LOC (143 `fn(`, 22 `uniformStruct`, 18 `storageBuffer`); `compiler/src/codegen`: 11 files; `rhi-webgpu` reflection                                                                                 | `grep -rl '@xgis/shader-dsl'`, `grep -c`              |
| `reflect()` callers         | 49 inbound (uniform-slot modules, bind-group registry, drapers, variant-family, semantic-diff)                                                                                                                                             | codebase-memory `trace_path reflect inbound`          |
| Escape hatches in consumers | 0 `rawStmt` / `b.raw` / `hostBlock` / `externVar` in `map/` + `compiler/` non-test code; 6 `externFn` (`projections.ts:429-439`); 4 forced casts                                                                                           | `grep` on this tree                                   |
| IR-level workarounds        | 22 `new Node({ op: 'varref' … })`, 11 `new Builder()`, 11 named `Let('x', …)`, 6 `b.placeholder` in `map/src/shaders/dsl` — the placeholder-composition idiom                                                                              | `grep` on this tree                                   |
| Committed baked shader text | 6 generated files, 864,836 bytes, 114 keys (`baked-{glsl,wgsl}-{boot,hillshade,lazy}.generated.ts`) — was 742,525 bytes / 106 keys before #2499 keyed the split-bind twins, oit-compose, extrude-shell and the three unwired lazy families | `ls -la map/src/shaders/baked/`, `registry.ts`; #2499 |
| External consumer           | dc4i.js: 41 portable entries across 26 modules, 4 `variantFamily` families, 0 raw GLSL files, `hostBlock`/`externVar` in production                                                                                                        | #1806 (2026-08-18)                                    |

**Capability standing, as the package itself states it** (`shader-dsl/README.md` taxonomy):
Author STRONG · Type-check STRONG · Optimize STRONG · Validate/lint STRONG · CPU-oracle
DISTINCTIVE · Reflect NEW · WGSL real and byte-stable · GLSL real for render pipelines ·
Multi-target (SPIR-V/MSL/HLSL) ASPIRATIONAL.

**The compile-time cost that shaped the last quarter.** Emitting one language runs
`validate → assertCaps → assertBuiltins → autoVars → lowerModule → fp64Lower → spellExterns →
optimizer fixpoint` over the whole module on every emit, on both backends
(`shader-dsl/src/core/emit.ts:240-265`, `passes/opt/optimize.ts` header — per-function
fixpoint, up to 8 iterations, structural-equality convergence). Recorded costs:

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
  (#1681, README). #1681 increments A (breaking cleanups) and B (packaging) have landed;
  C (release mechanics) is open.
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

## 2. Directions — ranked by five-year leverage

Each direction states the evidence it rests on, the work, what it deliberately is not, how
it is verified, and a size (S / M / L per increment). The order is leverage, not urgency;
§3 gives the sequence.

### D1 — Compile at build time; make runtime emit the exception

**Evidence.** The cost table in §0. The baked seam is opt-in per call site: `wgslFor` /
`glslFor` / `glslStagesFor` take an OPTIONAL id and fall through to a live emit on any miss
(`map/src/render/material/wgsl-for.ts:93-108`, `shaders/baked/store.ts` counts `miss` /
`absent` / `closed` apart). Polygon style variants are emitted at runtime and memoised by
`variant.key::pick::b<epoch>` (`map/src/render/polygon-shader-cache.ts:87`); hillshade uses
`shaderRequestKey`; compute keys on the source string — three cache-key systems for one
compiler. Layout derivation runs the emit: `reflect(buildLineModule())` EMITS the
projection functions (`map/src/render/line-uniform-slots.ts:17-20`), which is why five
`*-uniform-slots.ts` modules repeat a "LAZY — never call from a module-level const" warning
and `no-eager-uniform-reflect.test.ts` enforces it, while the handle-only
`wgslLayout(U.struct)` form (`heatmap-renderer.ts:52`, `graticule-renderer.ts:41`) already
avoids the problem. The edit loop is three steps (`bun run build` → `bake:shaders` →
reload) and `map/scripts/bake-shaders.ts:8-14` documents that baking without the build
rewrites all six artifacts with STALE bytes at exit 0 (caught later by
`baked-sync.test.ts`, not at the moment of the mistake); there is no HMR for shader edits.

**Work.**

1. Profile the pipeline per pass (`optimizerReport` in `core/measure.ts` gains timings) and
   fix what the profile names — today nothing says where the 80 ms of a vertex emit go.
2. One in-memory, content-addressed cache of lowered + optimised modules keyed by IR identity
   and target, so a module emitted for two stages or two languages lowers once (the
   `glslStagesFor` "lower once for both stages" rule, generalised), and one content-hash key
   (`bakedContentHash`) for the three pipeline caches.
3. Bake becomes the default for every registered family: the baked id is REQUIRED at
   registration, runtime emit stays as the dev fallback (`?nobake=1`) and for genuinely
   open-set style variants. Layout derivation moves to the handle-only `wgslLayout` form
   everywhere, so `reflect()` never triggers an emit.
4. Bake HMR: a playground Vite plugin re-runs `buildBakedArtifact` (`shaders/baked/bake.ts`,
   already type-checked under `map/src`) in-process on a change under `map/src/shaders/dsl/**`
   and invalidates the artifact module — one-step edit loop, and the stale-bake trap becomes
   unreachable.
5. The residual runtime emit moves off the main thread.

**Not this.** Shipping the emitter to end users as the primary path; any on-disk IR cache
format (§5).

**Verify.** Cold-start TTFM through the `?measure=boot` scenario #2150 asks for (the
instrument does not exist yet — it is the first deliverable here); `baked-sync.test.ts`
remains the byte gate; the §0 cost table is re-measured after each step. Size: S (1, 2),
M (3), S/M (4), S (5).

**Status (2026-09-05).** 1 landed (#2449 → #2459, `profileEmit`). 2 ANSWERED, not built
(#2459): one repeated lowering per boot, and bake-by-default takes the count to zero. 3 is
#2499, landed in #2506 / #2516 and their follow-up: the boot provenance gate
(`_2499-boot-shader-provenance-gate.spec.ts`) found a WebGPU boot compiling **28 of 30**
shader modules from runtime-emitted text — the legacy polygon base (`buildShader(null)`
never asked the store; `wgsl/polygon` was baked and read by nobody), the split-bind twins
and oit-compose (no WGSL-only key shape), each on frame one — plus three registered lazy
families baked, shipped and read by nobody. Now: `WgslOnlyFamily` / `WgslOnlyPlainFamily`
/ `oit-compose` key shapes; every registered family reads its bake; the seam's id is
REQUIRED with `LIVE` as the spelled open-set door; both doors are shrink-only lists
(`shader-seam-doors.test.ts`); the five `*-uniform-slots.ts` helpers derive from the
`uniformStruct` handle, so a fully baked boot builds no module and never pays the
projection fixpoint. The gate's WebGPU runtime table is empty and baked vs `?nobake=1`
frames hash equal on both backends. 4 (bake HMR) and 5 (off-main-thread residual emit)
are open; the residual emit is the open set (coverage, composer variants) plus `?nobake=1`.

### D2 — Precision as a checked property

**Evidence.** The oracle is an f64 algebra oracle and says so (`core/oracle.ts:20-38`, "NOT
an f32 GPU-precision oracle"); the only f32 modelling is `==`/`!=` on f32 operands, `fma`,
and the bitcast/pack builtins. An f32-exact wrapper exists — `froundWrap`, an IR
`mapModuleExprs` wrapper plus a `__fround` user fn — copy-pasted across seven test files
(`fp64/df64-known-answer.test.ts:40-61` and siblings), never exported;
`docs/research/2026-06-audit-numerical-precision.md:21,32` already asked for it. Because the
reference is f64, every GPU parity gate is tolerance-based: 100 m on hardware,
`max(3 km, 2e-3·|v|)` under SwiftShader (`_shader-math-parity`, `_optimizer-gpu-parity`),
and the compute-runner fixtures must use `k/255` inputs so f32 and f64 round the same way
(#1903). The reference itself is wrong on integer arithmetic and one control-flow shape —
#2274, #2275 (§4). Error budgets are hand-transcribed into a third authority
(`map/src/camera/coordinate-error-budget.test.ts:82-116`), the drift the
`render-error-budget` skill exists to prevent. fp64: `map/` authors zero `f64` IR (hand-packed
DSFUN hi/lo in `line.ts:296`, `raster.ts`, `polygon.ts:194-211`); all 13 f64 consumers are
`shader-dsl/examples/fp64-*.ts`; `recommendFp64Flavor` is wired only in
`site/src/pages/shader-dsl/fp64-probe.astro`, so the day a map shader adopts `f64` on Apple
it collapses to f32 silently (`fp64/flavor-select.ts:32-36`). The integer flavor's cost was
never written down; measured this session with `countOps` after `fp64Lower` + `inline({
opaque: 'all' })` + `fixpoint`:

| op  | float flavor (IR ops) | integer flavor (IR ops) |
| --- | --------------------: | ----------------------: |
| add |                    74 |                   1,749 |
| mul |                    68 |                   1,250 |
| div |                   411 |                   8,719 |
| sin |                 2,296 |                  48,340 |

(f32 `a*b+a` is 2 ops on the same scale.)

**Work.**

1. Fix #2274 and #2275; pin every row of #2274's semantics table with a fail-before test in
   both CPU engines.
2. `compileModule` / `compileModuleJs(m, { precision: 'f32' })`: promote `froundWrap` to a
   core pass applied in both engines (fround every f32-typed op, literal and param; Inf on
   overflow for free), delete the seven copies. The parity story becomes three-way — f64
   truth, f32 emulation, GPU — and the hardware tolerances shrink toward ulp scale; the
   `k/255` fixture constraint goes away.
3. IR-derived error budget: an interval/affine evaluator over the same op table,
   `boundFn(module, fn, domain) → { maxAbsErr, dominantNode }`, replacing the hand-transcribed
   paths in `coordinate-error-budget.test.ts` with `PROJECTION_MODULE` functions. This makes
   the skill's §1 executable for every DSL function and names the node that loses the bits.
4. Precision lint pack: int→float above 2^24, literal division by zero, NaN-producing
   builtins (`normalize(0)`, `sqrt(neg)`, `log(0)`, `pow(neg, non-int)`), silent integer
   wrap, shift ≥ 32 — beside the existing `no-float-eq` and `smoothstep-edge-order`.
5. fp64 productisation OR an honest retreat (owner decision, §7): wire `recommendFp64Flavor`
   at device init before any map shader adopts `f64`; document the cost table above in
   `AUTHORING.md` §7; fill the gaps that block a globe (`%`, `exp/log/pow/atan2`, int
   conversions, vec attributes) — or keep DSFUN hand-packing in `map/` and narrow the
   "unchanged syntax" claim to the examples.

**Not this.** Bit-exact GPU parity across vendors for transcendentals (vendor libraries
differ; the f32 oracle bounds the algorithm's own error, which is the quantity that matters).

**Verify.** `_dsl-builtin-gate` gains integer lanes that are bit-exact on both backends;
`_shader-math-parity` / `_optimizer-gpu-parity` tolerances are tightened against the f32
oracle and the change is recorded; the budget test replaces the hand paths and must
reproduce the skill's known numbers. Size: S (1), M (2), L (3), S (4), S–M (5).

### D3 — Finish the language where the globe needs it

**Evidence** (from `core/ir/types.ts`, `nodes.ts`, `node.ts`): `Scalar = 'f32' | 'i32' |
'u32' | 'bool'` (`types.ts:19`) with `f64` a separate kind lowered to `vec2<f32>`; vector
`elem` has no `'bool'`, so `vecN<bool>`, vector comparison, `any`/`all` are unrepresentable;
`unop` carries no operator tag — negation only (`oracle.ts:148-151`), so `!` and `~` do not
exist and consumers hand-apply De Morgan (`line.ts:695,809`, `raster.ts:316`); matrices are
square-only (`types.ts:65`, `typeKey` `mat${n}x${n}`), f32 constructors and `transpose`
exist only for the f64 twins (`node.ts:2045-2108`), and `mat2` in std140 throws
(`reflect.ts:124-131`); textures are `2d | 2d-array | 2d-ms` with one `sampler` — no cube,
3d, depth, comparison sampler, storage texture, `textureGather`; no `var<workgroup>`,
atomics or barriers (`passes/portable-kernel.ts:22-25`: "None of them is authorable"),
`workgroupSize` is 1-D (`builder.ts:791`); no `arrayLength`, no `@align`/`@size`
(`nodes.ts:299-313`), `@interpolate` beyond `flat` is dropped on GLSL; `f16`, `subgroups`,
`multiview` are declarable but unauthorable and sit in the reachability allowlist
(`backends/capability-reachability.test.ts`).

**Work.**

1. Boolean vectors + unary operators: `'bool'` in `vec.elem`, `unop.uop: '-' | '!' | '~'`,
   vector `compare` → `vecN<bool>`, `any` / `all` / vector `select`, a `.not()` method — in
   all three engines at once (M).
2. Matrix completion: non-square `{ cols, rows }`, `mat2x2fT` / `mat3x3fT`, f32
   constructors, `transpose` / `determinant`, typed `mat × vec`, the std140 mat2 rule (M).
3. A declared WebGPU-native compute tier ABOVE `portable`: `var<workgroup>`, `atomic<T>`
   with `atomicAdd/…`, `workgroupBarrier` / `storageBarrier`, 3-D `workgroupSize`, and for the
   portable tier multi-output and f32 output. GLSL fails closed through the existing cap
   profile and `rejected[]` names the reason — the asymmetry is declared, which is the whole
   point of #1903's design (L). This is what GPU-driven culling, label placement (#1177's
   "GPU-uniform epic"), terrain normals and particle systems need.
4. Texture kinds: cube / 3d / depth + comparison sampler / storage + `textureStore` /
   `textureGather` with their GLSL mappings and `reflect()` view dimensions — atmosphere
   (#1258), terrain shadows (#2201), volumetrics (L).
5. `arrayLength`, `@align` / `@size`, `@interpolate` modes on GLSL, `retLocation` (S).
6. `f16` stays behind the reachability gate until a consumer (mobile bandwidth) asks.

**Not this.** Pointers / out-parameters — struct returns cover the need and the
`ReadonlyNode` parameter contract is a safety property; speculative `f16`.

**Verify.** Every new type or intrinsic lands in the same PR on WGSL, GLSL and the oracle —
`intrinsic-coverage.test.ts` and `oracle-backend-parity.test.ts` pin the row; each compute
feature gets a real-GPU lane beside `_compute-runner-parity`.

### D4 — Typed specialisation and a typed host boundary

**Evidence.** `structT()` returns a widened `ShaderType` (`types.ts:331`), so every struct
node is `Node<string>`; `construct`, `arrayLit`, `callFn`, `IoStruct.construct`,
`PlainStruct.construct` return untyped `Node` (`node.ts:1846-1874`, `sot.ts:190-192, 291`);
`fn()`'s TypeScript return type comes from the body's returned value, so a guard-style body
(`If(…, () => Return(x))`) or a struct return infers `string` (`builder.ts:613-616`) — this
is why the deprecated `swizzle<R>(comps: string)` (`node.ts:523-525`) is still alive and why
`line.ts:1300,1314` cast to `Node<'vec3<f32>'>`. Variant composition is string-tagged:
filling a `b.placeholder('fill-return')` requires `new Node({ op: 'varref', name })` (22
sites), `new Builder()` (11), named `Let('x', …)` (11) and `void x` (5) in `map/src/shaders/dsl`,
and the code calls the idiom a "trick" (`point.ts:712-714`) and a "footgun"
(`polygon.ts:1388`, `line.ts:911`); dc4i.js adopted `variantFamily` and found no seam for
`composeModule` (#1806). Layout single-authority has holes the tests paper over: `feat_data`
is a flat `storageBuffer('feat_data', f32T)` in six shaders, so reflection cannot see the
record and six hand-maintained `*-feat-layout.ts` tables exist (plus literal slot offsets in
`heatmap-accum.ts:100-149` / `heatmap-renderer.ts:106-108,388-420`); line's `TileUniforms`
is a hand byte-mirror of polygon's `Uniforms` (`line.ts:123-221`, twelve `_pad_*`) guarded
by `polygon-line-uniform-parity.test.ts`; the Frame/Show/Tile blocks re-declare `polygonU`
fields guarded by `uniform-split-partition.test.ts`; one of nine bind-group layouts is derived
from reflection (`point-renderer.ts:99`), the rest are hand-written
(`pipeline-factory.ts:654-680`, `line-renderer.ts:566-590`). `module()` collects functions
transitively but not the structs / consts / bindings they reference (`builder.ts:937-1019`).
The fullscreen-triangle vertex shader exists in 13 copies across 8 files plus 6 `vsFullGl`
Y-flipped twins; there is no `dot`-less reason for it — `flow-advect.ts:112` says "the DSL
has no `dot`" while `line.ts:39` imports it.

**Work.**

1. Phantom-key precision: `structT<N extends string>` with a `struct:${N}` key arm, typed
   `construct` / `arrayLit` / `IoStruct.construct`, and a `fn()` overload that REQUIRES `ret`
   when the body returns a struct or nothing; delete `swizzle<R>`; re-bake the API surface (M).
2. Typed slots: `slot<T>('name')` handles usable both in a body and in the swap record,
   `composeModule(base, { [slot]: stmts })`, and ONE variant-enumeration object that bake,
   tests and the runtime share — the 22/11/11/5 workaround sites disappear (M).
3. Struct-typed `feat_data` (`storageBuffer('feat_data', PointFeat)`) with CPU slots from
   `wgslLayout(PointFeat, 'std430')`; the six tables become reflect-parity gates and then go
   (M — byte-neutral, all fields are f32; the array-of-struct GLSL lowering is already proven
   by `LineSegment`).
4. `view()` / `partition()` struct constructors so the line mirror and the Frame/Show/Tile
   blocks are DERIVED from `polygonU`; the two parity tests turn into construction (M).
5. Bind-group layouts from `reflectionToBindGroupLayoutEntries`
   (`rhi-webgpu/src/reflection-to-webgpu.ts:103`) at every site (S).
6. Key-parameterised function families (`fnFamily(name, keys, (K) => body)`) — the public
   form of the internal `genType1` — so the f32/f64 twin surfaces (`transformMat4` vs
   `transformMat64`) collapse to one definition (M).
7. `module()` collects structs, consts and bindings transitively (S).
8. `@xgis/shader-dsl/lib`: promote `examples/_fullscreen.ts` (target-aware flip), DSFUN
   recombine, abs-Mercator inverse, the geo-block reader — the 13 + 6 copies go (S).

**Not this.** A JS-syntax transpiler (§5); Slang-style interfaces before the typed-slot
mechanism has proven the variant model.

**Verify.** These are refactors: byte-identical goldens and `baked-sync.test.ts` are the
gate for every step; a parity test is deleted only after its constructive replacement is in.

### D5 — IR maturation: make the passes stop re-deriving what the IR should know

**Evidence.** The IR is an immutable plain-object tree with no CFG, SSA, dominators or
use-def chains; every pass recomputes `collectLocals` / `collectMutatedRoots`
(`passes/opt/expr-utils.ts:249-367`). The CSE family is three passes — `cse` (fn-top,
input-only), `cseLocal` (one statement), `gvn` (straight-line blocks) — because scope
information is re-derived per pass, and the 2026-08 changelog shows the family being patched
incrementally four times (#1865, #1887, #1892, #1894). Five passes assume unique local names
within a function without a rule that checks it (`const-prop.ts:187-190`, `copy-prop.ts:244`,
`dead-branch.ts:517`, `member-fold.ts:257`, `inline-linear.ts:407`). LICM is input-only and
hoists to the function top (`licm.ts:397-401, 544`), so a loop nested in a branch pays its
invariants unconditionally; there is no dead-store elimination (`dce.ts:303-304`) and no
unused-parameter removal; `matchExpr` always lowers to `var` + `switch`
(`match-lower.ts:195-229`); nothing checks uniformity, so a derivative under non-uniform
control flow is a Tint error and GLSL undefined behaviour; `countOps` is unweighted
(`measure.ts:58-116`) and no per-shader GPU timing exists; `constFold` folds in f64
(`const-fold.ts:6-9`) so O2 is not bit-identical to O0 on GLSL and `x+0→x` is observable
through −0.0 (`algebraic.ts:21-25`). On the emit side: `Backend` (`backend.ts:136-255`) has
no slots for module assembly, entry IO, binding declaration or binary-operator spelling, so
the GLSL writer bypasses the `emitModule` driver with its own `lowerForGlsl` + `assembleGlsl`
(`glsl.ts:2149-2162`) and eight two-target `be.id === 'wgsl' ? … : …` branches survive
(`emit.ts:277, 432`, `fragment.ts:89-93`, `emit-identity.ts:36`, `variant-family.ts:86-90`,
`emit-alias.ts:161`, `RawStmt`, `ExternVarDecl.spelling`); five hand-written IR walkers are
duplicated in `glsl.ts` / `glsl-sanitize.ts` while `rewriteExprsInFunc` exists; and the
target conventions — framebuffer Y origin, clip-Z range, `position.w` — live in hand-written
twins (`vsFullGl` in six files, the `apply_log_depth` + `frag_depth` convention in seven
shaders, `log-depth.ts:22-38`) rather than in the IR, with no backend depth-value parity
gate.

**Work.**

1. CORE lint `no-shadowed-local` + a dev-assert in `fixpoint` — the five passes' premise
   becomes checked (S).
2. Structured-control-flow annotations: block ids, loop preheaders, dominance by construction
   (the IR is structured, so no general CFG is needed) — one scope analysis shared by
   CSE / cse-local / GVN / LICM, LICM v2 placing invariants at preheaders, GVN across
   `else if` / `switch` headers (M–L). **Measured out (#2465, 2026-09-05):** the premise was
   wrong — the two scope walks cost ≤ 14.6 ms of a ~236 ms optimize (they run once per
   function per pass; `keyOf` runs per expression node, 254k times per `line` emit). The
   real lever landed as #2492: `keyOf` memoised on the `Expr` object, optimize −25 % to
   −37 %, soundness verified by a 12,405-test recompute-and-compare sweep. LICM v2: the
   five `_licm` lets that sit in branch-nested loops are all uniform/storage reads — nothing
   to gain. GVN across `else if` is unsound (the arms' conditions are not both evaluated);
   `switch` scrutinee tallying measured 26 candidate sites against 2,363 — not worth a pass.
3. Dead-store and unused-parameter DCE; `deadBranch` for literal `switch` / `for false`
   (S–M). **Measured out (#2465):** over 409 functions — 0 dead declarations, 4 dead
   assigns (`compute_line_color._av6`, three unrolled tails in
   `vs_arrow_retained_advected`), 2 unused parameters that are IO-contract locations
   (`center` on `vs_point` / `vs_heatmap`), 0 literal `switch` / `for` / `if`. Nothing here
   pays for a pass.
4. Uniformity analysis: a conservative lint first (derivatives / `textureSample` under
   conditions that depend on fragment inputs, builtins or storage indices), then an emit
   requirement (M–L).
5. Float policy tiers: O2 strict IEEE (drop `x+0→x`, per-backend fround-aware const-fold so
   O2 ≡ O0 bitwise), O3 opt-in fast-math with reassociation and `pow(x,2)→x*x` (M).
6. Weighted cost model (`costOf(m)` with an intrinsic weight table) driving
   `inline({ opaque })`'s growth budget, `unroll`, and `optimizerReport`; a per-shader GPU
   timing lane on `?gpuprof=1` (relative under SwiftShader) (M).
7. Backend contract v2: assembly / entry-IO / binding / binop slots so `emitModule` drives
   both writers; spelling records keyed by `Backend['id']`; walkers unified on
   `rewriteExprsInFunc`; a `conventions` record (`framebufferOrigin`, `clipZ`,
   `fragPositionW`) lowered by a neutral pass that replaces the `vsFullGl` twins; a
   GL ↔ WebGPU depth-value parity e2e (M). Justified by the two writers' parity, not by a
   third writer (§5).

**Not this.** A general SSA rewrite; register allocation heuristics beyond what the cost
model shows to matter.

**Verify.** Byte-gated (goldens, `baked-sync`) and oracle-gated per pass; the O1 "bit-exact
mover" claim gets its differential in D6.

### D6 — Verification platform: shift the gates left and make them generative

**Evidence.** No generated-program corpus exists — every "property" test randomises INPUTS
over fixed kernels; the O1 bit-exact claim is unverified. No offline WGSL/GLSL compiler runs
in the unit tier: the root `devDependencies` have only `@webgpu/types`, `bun run build` and
`precheck` never compile a shader, and all compile gates (`_wgsl-compile-gate`,
`_glsl-compile-gate`, `_emit-obfuscate-gate`, `linkVariants`, `validateVariantsWgsl`) run
in the Playwright `render-shard`. `captureLoc` skips frames by the literal path
`/shader-dsl/src/core/` (`diagnostics/loc.ts:61`), so a bundled consumer gets DSL-internal
frames as author locations; there is no IR dump, no emitted-line → authoring-line map (only
`decodeShaderLog`'s name reversal). The 24 lint rules run in tests over 8 modules
(`shader-static-analysis.test.ts`); 46 of 56 consumer modules are never linted. `semanticDiff`
compares interface / resources / constants / control-flow skeleton, not expression trees —
a review aid, not an equivalence proof (`semantic-diff.ts:85-91`). Three defects the audit
found (§4) were each invisible to every existing gate.

**Work.**

1. A seeded, typed random-IR generator (over `BUILTINS`, structured control flow, the three
   scalar kinds) and three differentials: interpreter ≡ codegen (`Object.is`);
   `oracle(pass(m)) ≡ oracle(m)` per pass and at fixpoint (O1 bit-exact, O2 within an ulp
   budget); GPU ≡ f32 oracle under SwiftShader after D2.2 (M).
2. Offline validation in the unit tier: compile the 102 emit goldens and the 6 baked
   artifacts with a real WGSL validator and a GLSL ES 3.00 validator — naga-cli or Tint as a
   CI step first, a wasm build inside vitest next — as a ROOT devDependency so the package
   stays zero-dep; included in `precheck` (M).
3. Diagnostics: compute `captureLoc`'s filter from the package root at load time; a
   deterministic `dumpIr(module)` on `/dev`; optional Expr locations; an emitted-line map
   consumed by `decodeShaderLog` (S–M).
4. Lint everywhere: the lint engine over all 56 consumer modules with a warning ratchet, and
   an ESLint plugin for the authoring-level mistakes that tests currently police
   (`no-eager-uniform-reflect`, bare `rawStmt(` in a body, positional same-type calls) (M).
5. A playground shader inspector (`?shaderdump=1`): which seam served each pipeline, its
   emit text, per-pipeline GPU ms (S/M).

**Verify.** The fuzzer must go red when #2274 or #2275 is reverted (a witness at the
producer, §12); the offline validator must reject the `(--1.0)` shape of #2276; the lint
ratchet starts at the measured count and only shrinks.

### D7 — Ecosystem: publish what is true, then widen

**Evidence.** #1681 C (release mechanics) and #1903's site section are open. The README is
stale against the tree: "Reflect NEW" with 49 callers; "3 cartographic / 16 generic / 1
compute" examples vs 36 in `examples/index.ts`; "WebGL2 canvas" while the page runs both
backends; a `swizzle<'vec3<f32>'>('rgb')` snippet where `.rgb` exists.
`shader-dsl/AGENTS.md` still names `runtime/` and a `shaders/` subdirectory, both gone.
`DESIGN.md` §3 already names WESL as the module layer to build on; three.js ships a GLSL→TSL
transpiler; the site's examples render build-time strings only ("No shader-dsl on the
client").

**Work.**

1. Docs honesty pass: README taxonomy (Reflect → mature; fp64, `semanticDiff`,
   `variantFamily`, portable compute rows; "aspirational multi-target" → "via naga/Tint"),
   `AGENTS.md`, the drift items in §4 (S).
2. #1681 C: version policy, first tag after Wave 1 (§3) with `api-surface.test.ts` as the
   freeze, npm publish from the monorepo, the `exports → dist` decision (M).
3. `@xgis/shader-dsl/lib` (D4.8) and the compute-runner site section (#1903) (S).
4. WESL interop study — import WESL modules as IR, or emit WESL-compatible modules — decided
   once WESL's import semantics stabilise (research, no code).
5. A WGSL importer only after D6.1 exists (the fuzzer is its oracle) and only if a migration
   corpus appears — today `compiler/` authors IR natively and `AUTHORING.md` §12 is the
   vocabulary map (L, deferred).
6. A live playground via esbuild-wasm, deferred until external demand (L).

---

## 3. Sequencing

| Wave                 | Items                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Gate before the next wave                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — now (S each)** | COMPLETE. #2274, #2275, #2276 fixes and the verified doc drift landed in PR #2270; D5.1 `no-shadowed-local` (#2341), D6.3 `captureLoc` (#2342) and the D7.1 README/AGENTS rows (#2343) landed after it. D5.1 grew on contact: the premise was not merely unchecked but VIOLABLE — a duplicated local name miscompiled at O1 and captured a parameter at O0 (see #2341), so the lint rule ships fail-closed in CORE alongside a `fixpoint` premise assert | shader-dsl suite green; goldens byte-identical (no production text moves) — met: 139 files / 1582 tests green, goldens and `baked-sync` unchanged. Wave 0 close-out re-measured: 0 functions in 1163 files / 10377 tests reach the optimizer with a duplicate local name |
| **1 — foundations**  | D2.2 f32 oracle mode; D6.1 fuzzer (interp ≡ codegen, oracle(opt) ≡ oracle); D6.2 offline validation; D1.1–1.2 profiling + cache; D4.1 phantom keys                                                                                                                                                                                                                                                                                                       | fuzzer catches reverted #2274/#2275; validator rejects #2276; TTFM instrument exists                                                                                                                                                                                     |
| **2 — compounding**  | D1.3–1.4 bake-by-default + HMR; D4.2 typed slots + variant enumeration; D4.3–4.5 `feat_data` struct, view/partition, BGL; D5.2–5.3 IR annotations, LICM v2, DSE; D5.7 backend contract v2 + conventions + depth parity                                                                                                                                                                                                                                   | §0 cost table re-measured; parity tests replaced by construction; depth-parity e2e green on both backends                                                                                                                                                                |
| **3 — capability**   | D3.1–3.2 bool vectors + matrices; D3.3 compute tier; D2.3 error-budget analyzer; D5.4 uniformity; D5.5–5.6 float tiers + cost model                                                                                                                                                                                                                                                                                                                      | every new op on all three engines; compute lanes on real GPU                                                                                                                                                                                                             |
| **4 — reach**        | D3.4 textures; D4.6 generics-lite; D7.2 publish; D7.4–7.5 WESL / importer decisions                                                                                                                                                                                                                                                                                                                                                                      | API surface frozen by tag                                                                                                                                                                                                                                                |

Rules: an item becomes a GitHub issue before it starts (§9.5); a wave's byte-moving items
wait for the previous wave's gates; D2.5 (fp64 in `map/`) and D3.6 (`f16`) start only on
the owner decisions in §7.

---

## 4. Defects found during the audit

Each was reported by a facet audit and then reproduced by the session lead on this tree
before filing. All three are fixed in PR #2270 (owner approval 2026-09-01) with fail-before
tests: `core/cpu-int-semantics.test.ts` (both CPU engines, every row of #2274's table plus
the #2275 shapes), the `swcont` / `swbrk` fixtures in `core/cpu-codegen.test.ts`'s A1
differential, and `core/backends/literal-spelling.test.ts` (both writers, SD0017).

| Issue | Defect                                                                                                                                                                                         | Root cause                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #2274 | Integer `/` on the CPU tier returns a fraction (`idiv(7,2) = 3.5`; WGSL 3) in BOTH the interpreter and `compileModuleJs`; u32 wrap, `x/0`, `x%0`, `min(NaN, 1)`, `clamp` order also unmodelled | `core/cpu-runtime.ts:49-58` `scalarBin` and `core/cpu-codegen.ts:262-271` evaluate JS `/` with no operand kind; only `>>` reads `isI32`                      |
| #2275 | The reference interpreter drops a `continue` raised inside a `switch` case within a loop (interpreter 4, codegen 3, WGSL 3)                                                                    | `core/oracle.ts:352-362` propagates only `return` / `discard` out of a switch body                                                                           |
| #2276 | Literal spelling is fail-open: `neg(lit(-1))` emits `(--1.0)` at O0 and on the const `valueExpr` path; out-of-range i32 literals print verbatim                                                | `core/emit.ts:76-77, 83-84` unop spelling; `backends/wgsl.ts:97-100` `literal()` has no range/finiteness check; `optimize.ts:185-190` optimises `funcs` only |

Documentation drift found and fixed in the same PR (each verified on this tree first):
`flow-advect.ts:112` ("the DSL has no `dot`" — `line.ts:39` imports it);
`passes/opt/member-fold.ts:198-200` says "wired into DEFAULT_PASSES" while `optimize.ts`
lists it as unwired; `ir/nodes.ts:15-16` and `AUTHORING.md:330-331` say GLSL rejects float
`%` while `glsl.ts:402-407` lowers it to `a - b*trunc(a/b)`; `AUTHORING.md:299` "no
`addAssign`" vs `Builder.addAssign` (`builder.ts:229-231`); `AUTHORING.md:543-546` "builtin
name typed as string" vs `WgslBuiltinName` (`sot.ts:112-136`).

Reported by the audits, not re-verified here (check before acting): `select` is eager on
WGSL and a short-circuiting ternary on GLSL (`intrinsics.ts:74`), value-identical only while
the IR stays pure; `no-recursion` checks direct self-calls only and is not in `CORE_RULES`;
`recommendFp64Flavor` receives no signals from any engine host; `_polygon-fixtures.ts:9-11`
claims composer emit while `emitForFixture` splices strings; the storage→data-texture
lowering keeps struct `u32` fields in R32F texels (denormal flush risk noted in
`glsl.ts:1147-1149`).

---

## 5. Explicitly NOT — with the reason, so it is not re-proposed

| Not doing                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MSL / HLSL / SPIR-V emitters**                                         | X-GIS is a web engine; WebGPU already runs on every native host through Dawn/wgpu, and WGSL → naga/Tint → MSL/HLSL/SPIR-V is a solved, maintained path. A third hand-written backend triples every parity gate for zero rendering surface — and the audit measured what it would cost: HLSL needs a binop-spelling hook the contract lacks, a third layout rule (cbuffer packing), and register-class slot assignment. The README's "aspirational" row is retired to "via naga/Tint", not built. |
| **JS-syntax authoring via a source transpiler** (TypeGPU's build plugin) | It couples authoring to a bundler plugin, breaks runtime emit and the `new Function` CPU tier's CSP story, and the ceremony audits (#740, #763) already settled the method-operator surface. Revisit only if authoring volume, not preference, makes it the bottleneck.                                                                                                                                                                                                                          |
| **A separate repository for the DSL**                                    | Rejected in #1681 with the reason that survives: the real-driver gates are X-GIS scenes.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Inferring the compute tier / capabilities at dispatch time**           | Rejected in #1903 and the portable-kernel design: it is the three.js silent-fallback failure mode that `rejected[]` exists to prevent.                                                                                                                                                                                                                                                                                                                                                           |
| **A house IR serialisation format on disk**                              | CLAUDE.md §12 custom-format trap. Bake artifacts stay the emitted target text plus a content hash; any IR cache is in-memory or plain JSON.                                                                                                                                                                                                                                                                                                                                                      |
| **Widening the public barrel with `core/` internals**                    | `shader-dsl/AGENTS.md`: `core/` is private; the API-surface gate (`src/api-surface.test.ts`) exists so the surface grows by decision, not accretion.                                                                                                                                                                                                                                                                                                                                             |
| **GLSL ES 1.00 / WebGL1**                                                | No `uint`, bit ops, UBO or `switch` — the IR cannot be lowered honestly; the web has moved on.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Transform feedback as a second GPGPU vehicle now**                     | Deferred in #1903 with its reason (varying-layout negotiation, two-authorities drift); revisit only for kernels whose output is not a 32-bit-per-invocation container.                                                                                                                                                                                                                                                                                                                           |
| **A shared scope analysis for the CSE family (D5.2 as written)**         | Measured, not argued (#2465): the scope walks are ≤ 14.6 ms of a ~236 ms optimize and `collectLocals` / `collectMutatedRoots` have 15 / 17 callers reaching the GLSL backend, `unroll`, `const-prop`, `copy-prop` and `member-fold` — the refactor owed all of their gates for under 6 %. The cost lever was `keyOf` (per-node, 254k calls per `line` emit), memoised in #2492.                                                                                                                  |
| **LICM v2 preheaders / GVN across `else if` and `switch` headers**       | #2465: every `_licm` let that lands in a branch-nested loop is a uniform/storage read, so preheaders move nothing; `else if` GVN is unsound (only the first arm's condition is evaluated on every path); `switch` scrutinee tallying measured 26 sites against 2,363. Re-open only with a corpus that changes those counts.                                                                                                                                                                      |
| **Dead-store / unused-parameter DCE (D5.3)**                             | Measured over 409 functions (#2465): 0 dead declarations, 4 dead assigns, 2 unused parameters that are IO locations and cannot be removed, 0 literal switch/for/if. A pass with nothing to delete is a pass to maintain.                                                                                                                                                                                                                                                                         |
| **An in-memory content-addressed cache of lowered modules (D1.2)**       | #2459 measured one repeated lowering per boot; bake-by-default (#2499) makes the boot count zero, which a cache cannot beat. The open set (coverage, composer variants) is keyed per variant already (`buildShader` / `buildSplitShader` memos).                                                                                                                                                                                                                                                 |

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

## 7. Owner decisions — SETTLED 2026-09-02

All seven were decided by the owner on 2026-09-02, each as the recommendation below. They are
FACTS now, not preferences to re-weigh: do not re-open one because the supporting detail has
scrolled out of a later session's context (§9.5). The two that gated work are unblocked —
**D2.5** (fp64 in `map/`) starts as decision 3 describes, **D3.6** (`f16`) stays parked by
decision 5.

| #   | Decision                                                                                                                                                 | DECIDED (2026-09-02) — the recommendation, adopted as written                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Runtime emit: keep it first-class (then invest in speed) or demote it to a dev fallback (then a baked id becomes mandatory for every registered family)? | Demote. Bake is mandatory for the closed set; runtime emit serves `?nobake=1` and open-set style variants only. Speed work (D1.1–1.2) still pays for the residual path.              |
| 2   | Accept a declared WebGPU-native compute tier that WebGL2 cannot run (fail-closed, `rejected[]`) — a backend asymmetry by design?                         | Yes. It is the portable-tier decision one rung up; the asymmetry is declared, never inferred.                                                                                        |
| 3   | fp64 in `map/`: adopt `f64` IR (wire the flavor probe first) or keep DSFUN hand-packing and narrow the "unchanged syntax" claim to the examples?         | Wire the probe (S) and pilot ONE shader (polygon RTC offsets) with the f32 oracle in place; decide from the measured cost. The cost table in D2 says the integer flavor is not free. |
| 4   | Float policy: strict-IEEE O2 (drop `x+0→x`, fround-aware const-fold — one golden re-bake) or keep today's bytes?                                         | Strict O2, re-bake once, and put fast-math behind O3. The oracle-equality story is cleaner when O2 ≡ O0 bitwise.                                                                     |
| 5   | `f16`: build now for mobile bandwidth, or wait for a consumer?                                                                                           | Wait; keep the reachability gate so the empty capability cannot be shipped by accident.                                                                                              |
| 6   | Publishing (#1681 C): when to tag 0.1.0?                                                                                                                 | After Wave 1, when D4.1's type changes are in — they are breaking, and `api-surface.test.ts` is the freeze.                                                                          |
| 7   | WESL / WGSL importer: research now or later?                                                                                                             | Research WESL now (no code); the importer waits for D6.1 and a real migration corpus.                                                                                                |
