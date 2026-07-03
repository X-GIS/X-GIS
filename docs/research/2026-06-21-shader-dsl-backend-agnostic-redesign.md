# `@xgis/shader-dsl`: from a WGSL emitter to a backend-neutral shader IR (WebGPU + WebGL2)

**Status:** design / RFC · **Scope:** `shader-dsl/` package + its `runtime` consumers ·
**Verification basis:** 6-dimension read-only assessment (run `wf_1321dd61-bb0`), cited inline.

## 1. Problem statement

The package presents itself as a _backend-agnostic shader DSL_, but it is in fact a **single-target
WGSL code generator with a thin neutral veneer**. Concretely: the only render backend is the WGSL
string emitter (`core/backends/wgsl.ts`); the second "backend" (`core/backends/cpu.ts`) is an f64
tree-walk **validation oracle**, not a render target (it `throw`s on `textureSample`/`fwidth`); and
there is **no GLSL/WebGL backend**, so backend-neutrality has never been exercised, let alone proven.
Backend-specific assumptions have leaked into the IR itself, so "neutral" is aspirational.

**Goal.** A genuinely retargetable shader IR: a backend-neutral, typed authoring layer lowered by
**pluggable emitters** (WGSL today; GLSL ES 3.00 / WebGL2 next), with the CPU oracle retained as a
differential ground-truth. This is the architecture that earns the intended "luma.gl-class" position.

## 2. Positioning & prior art

This is a solved _class_ of problem; the design should follow the established shape rather than invent.

| System                | Shape                                                                                                                                                  | Relevance                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **naga** (wgpu)       | typed IR (`Module`) + per-backend writers (WGSL/SPIR-V/GLSL/HLSL/MSL) + `Capabilities` bitflags                                                        | the closest precedent; our `Backend` interface ≈ naga's `Writer`, our capability flags ≈ `naga::valid::Capabilities`                                      |
| **Tint** (Dawn)       | IR + transform _passes_ + per-target generators; features gated by `transform::` passes                                                                | validates the "neutralize-then-specialize **pass pipeline**" model below                                                                                  |
| **SPIRV-Cross**       | one IR → many GLSL/MSL/HLSL emitters; handles the exact WGSL↔GLSL mismatches we hit (combined samplers, `std140`, struct-IO flattening, `gl_Position`) | the GLSL-emit hazards are well-trodden; reuse its decisions                                                                                               |
| **Slang**             | high-level typed shader language → multi-target                                                                                                        | the authoring-ergonomics target                                                                                                                           |
| **luma.gl / glslify** | _string_ shader modules + `#define`/injection, NOT a typed IR                                                                                          | what the owner wants the **position** of, but our typed-IR route is strictly stronger (compile-time safety + a CPU oracle) than luma.gl's string assembly |

**Takeaway.** Our DSL is architecturally a _naga-lite_ (typed IR + emitter), already ~70% there. The
work is not a rewrite; it is **de-leaking WGSL out of the IR** and adding a second writer + a
capability/feature model — exactly naga/Tint's structure.

## 3. Coupling analysis — where WGSL has leaked into the IR

The Expr tree (`binop/unop/compare/logical/member/construct/index/lit/var/const`), the Stmt
control-flow set (`let/var/assign/if/for/switch/return/break/continue/discard`), the `matchExpr`→
`switch` lowering, `ConstDecl`'s dual `wgslValue`/`cpuValue`, and the `ShaderType` _kind_ descriptors
are **already target-neutral** (GLSL ES 3.00 maps them 1:1). The leaks are four **lexical** layers
and two **semantic** (model) mismatches.

### 3a. Lexical coupling (de-leakable; WGSL output stays byte-identical)

- **L1 — type _identity_ is WGSL spelling.** `types.ts:typeKey()` and the phantom `KeyOf<T>` encode
  `vec3<u32>` / `mat4x4<f32>` and `typeEq` compares those strings, so _the IR's notion of "same type"
  is a WGSL lexeme_. ~24 authoring sites spell keys inline (`Node<'vec4<f32>'>`, `swizzle<'vec3<f32>'>`).
  This is the **AC4 compile-time type-safety substrate** — the highest-blast change.
- **L2 — intrinsic names baked 1:1.** `emitExpr` `call` emits `${fn}(args)`, so `textureSample`,
  `unpack4x8unorm`, `bitcast<u32>`, `select`, `atan2` are WGSL identifiers living in IR nodes. Of
  ~35 distinct intrinsics: **23 portable verbatim**, ~10 rename/reorder, ~5 "deep" (the texture
  family — GLSL _combines_ texture+sampler and drops an argument).
- **L3 — entry/IO/bindings are raw WGSL attribute _strings_.** `@vertex`, `@location(0)`,
  `@interpolate(flat)`, `@builtin(position)`, `@group(N) @binding(M)` are stored as syntax, not
  structured descriptors.
- **L4 — `raw` Stmts** carry literal WGSL (the compiler emits the polygon match-chain as a string).

### 3b. Semantic coupling (NOT spelling — no WebGL2 equivalent; must be capability-gated)

- **S1 — storage buffers.** `line/point/polygon/sdf/heatmap-accum` read per-feature `feat_data`/
  `segments`/`shapes` via `var<storage,read> array<T>`. WebGL2 has **no SSBO**, and the UBO size cap
  (16–64 KB) cannot hold runtime-sized per-tile arrays. The only WebGL2 path is **data-texture
  emulation**, which also rewrites the _producer_ (VTR `writeBuffer`).
- **S2 — compute.** `@compute`/`@workgroup_size`/`read_write` scatter (the `compute-match` continent
  kernel). WebGL2 has no compute stage; closest paths are **transform feedback** (vertex-only) or a
  fragment-scatter rewrite, or fall back to the CPU oracle.

## 4. Target architecture

### 4.1 IR as a normal form

Make the IR a **canonical, spelling-free normal form**; all target lexemes move into writers.

- `canonicalKey(t: ShaderType): string` — structural token (`scalar:f32`, `vec:3:f32`, `mat:4:f32`,
  `tex:2d:f32`, `arr:<key>:N`, `struct:Name`). `typeEq := canonicalKey(a) === canonicalKey(b)`.
- `KeyOf<T>` re-expressed over the neutral token (or a branded structural tuple) so the AC4 phantom
  gate no longer encodes WGSL; `ElemKey` parses `vec:N:E`. Authoring spells keys through **type
  aliases authored once** (`type Vec4f = Node<…>`), never inline — so adding GLSL never touches a
  shader graph.

### 4.2 Lowering pipeline (neutralize → specialize → emit)

```
authoring graph ──► IR (normal form) ──► [neutral passes] ──► [backend passes] ──► string
                     │                     │                    │
                     │   matchExpr→switch  │  struct-IO flatten │  Backend.typeName / .intrinsic
                     │   const-fold        │  (GLSL only)       │  / .emitBinding / .lowerEntry
                     │                     │  sampler-fuse(GLSL)│  / .finalizeModule
                     └── cpu oracle ◄──────┘  (differential ground truth, not a render target)
```

Neutral passes run for all targets; backend passes are target-specific transforms (mirrors Tint).

### 4.3 The `Backend` contract (`core/backends/backend.ts`)

```ts
interface Backend {
  readonly id: 'wgsl' | 'glsl-es300'
  typeName(t: ShaderType): string
  literal(v: number | boolean, t: ShaderType): string
  intrinsic(id: IntrinsicId, args: string[], argTypes: ShaderType[], ret: ShaderType): string
  emitBinding(d: ResourceDecl, slot: SlotAssignment): string
  lowerEntry(e: EntryDecl, m: ModuleDecl): string
  finalizeModule(parts: ModuleParts): string // GLSL: '#version 300 es' + precision header
  readonly caps: Capabilities // see §6
}
```

`WgslBackend` re-implements _today's exact emit_ behind this (byte-identical, pinned by the snapshot
gate). `GlslBackend` is additive. `cpu.ts` is **not** a `Backend` — it is the oracle.

### 4.4 The six de-leak refactors

1. **Type normal form + writer-owned spelling** (L1) — `canonicalKey`, neutral `KeyOf`, `Vec*` aliases.
2. **Intrinsic registry** (L2) — `Expr.op:'intrinsic'` carrying an `IntrinsicId` enum +
   `INTRINSICS: Record<IntrinsicId, { wgsl; glsl?; cpu }>` (folds `cpu.ts` `BUILTINS` in). `glsl?`
   _undefined_ ⇒ unsupported on WebGL2.
3. **Structured entry/IO/stage** (L3) — `ShaderStage` enum, closed `IOBuiltin` enum, `IOSlot` /
   `StageIO` / `EntryDecl` replace attribute strings.
4. **Logical resource model** (L3/S1) — `ResourceKind = uniform-block | read-buffer | rw-buffer |
sampled-texture | sampler | storage-texture`; `logicalGroup` string tag (no hardcoded `@group`);
   per-backend `ResourceLowering.assign() → LayoutPlan` (see §5).
5. **Kill `raw`** (L4) — the compiler returns `Stmt[]` (it already builds the chain) → neutral
   `inlineGraph`; `raw` survives only as a `backendOnly:'wgsl'` **fail-closed** escape.
6. **Backend extraction** — thread `backend` through emit instead of module-level `wgslType`/`emitExpr`.

## 5. Memory layout & the producer/consumer contract

This is the repo's **#1 historical defect class** (producer↔consumer format drift; the 256-byte
`Uniforms` is flagged load-bearing, `AGENTS.md:52`), so it gets a first-class model.

- WGSL uniform layout ≈ **`std140`-ish but not identical**; GLSL ES 3.00 UBOs are strict `std140`.
  The disagreements that bite: `vec3` is **16-byte aligned** (padded to a `vec4` slot) in both, but
  **array element stride** and **struct member rounding** differ; matrices are column-arrays of
  `vec4`. Storage-style packed layouts (WGSL's relaxed rules) have **no `std140` equivalent**.
- **`LayoutPlan` is the single source of truth** binding the CPU `writeBuffer` offsets to the shader
  struct. Today that knowledge is split between `vector-tile-renderer.ts` constants (`UNIFORM_SLOT`,
  the 256 B map) and the shader struct order. The redesign makes `ResourceLowering.assign()` emit a
  `LayoutPlan { byteSize, fields: {name, offset, size}[], groupBindingFor(name) }` consumed by **both**
  the emitter and VTR — so a field move can no longer silently mis-bind.
- **Acceptance:** the WGSL `LayoutPlan` must reproduce **today's exact** offsets + `@group/@binding`
  integers (group 0/1, bindings 0–6), proven by the byte-equal snapshot + the executed-WGSL parity
  spec. GLSL emits an independent `std140` plan validated by a UBO round-trip test.

## 6. Capability tiers & shader feature matrix

Model targets as **capability levels** (mirrors naga `Capabilities` / D3D feature levels). A module
declares the features it uses; a backend declares what it supports; emit of an unsupported feature is
a typed `UnsupportedFeatureError`, **never** silent mis-emit.

```
Capabilities = { storageBuffers, compute, msaaTextureLoad, vertexPulling, … }
WgslBackend.caps = ALL ;  GlslEs300Backend.caps = { } (none of the above)
```

| Tier                       | Requires                        | Shaders                                                 | WebGL2                           |
| -------------------------- | ------------------------------- | ------------------------------------------------------- | -------------------------------- |
| **T0** FS compositor       | UBO + sampled texture           | raster, overdraw-compose, heatmap-blur, heatmap-compose | trivial                          |
| **T1** classic VS+FS       | vertex attributes + UBO         | (none today author attributes; all pull from storage)   | easy once authored               |
| **T2** vertex-pulling      | data-texture `texelFetch` in VS | polygon, line, point, sdf, icon, text, heatmap-accum    | **gated on §7 emulation**        |
| **T3** compute / MSAA-load | compute / per-sample resolve    | compute-match, oit-compose (MSAA)                       | **WebGPU-only** (or rearchitect) |

So a GLSL/WebGL2 backend yields **partial** coverage immediately (T0; T1 once shaders are authored
with attributes), with the render-heavy shaders blocked on the §7 data-texture work, and T3
fundamentally WebGPU-only.

## 7. Emulation strategies for the semantic gaps

- **Storage buffer → data texture (S1).** Encode the SoA f32 stream as an `R32F`/`RGBA32F` texture of
  width `W` (e.g. 2048); element `i` field `f` lives at `texelFetch(buf, ivec2((i*stride+f) % W,
(i*stride+f) / W), 0)`. The shader reads through the existing `bindingRef(...).at(i)` accessor
  (`point.ts:109`) so only the _lowering_ changes, not shader source. **The producer must change too**:
  VTR's `writeBuffer(LineSegment…)` becomes a `texSubImage2D` pack — a real data-path PR with its own
  parity gate. Vertex-pulling uses `gl_VertexID`/`gl_InstanceID` + `texelFetch`.
- **Compute scatter → transform feedback or CPU (S2).** The `compute-match` write is
  `out_color[fid] = …` (gid-indexed) → expressible as a **transform-feedback** vertex pass (one vertex
  per feature, captured into a buffer) OR simply routed to the **CPU oracle** (it already computes the
  same f64 result). Decide per-use; do not fake compute on WebGL2.
- **MSAA `textureLoad` (oit).** WebGL2 cannot sample a multisampled texture in-shader → **resolve
  first** (blit to a single-sample texture) then sample; or keep OIT WebGPU-only.

## 8. Verification strategy

A three-tier oracle structure (each phase wires the next tier):

1. **Golden / regression (WGSL byte-equality).** `polygon-variant-diff` snapshot + `*-dsl.test.ts`
   `toContain` spellings PIN that every de-leak refactor leaves WGSL **byte-identical**. This is the
   primary guard for R1–R3.
2. **Differential (WGSL ↔ GLSL ↔ CPU).** For portable shaders, emit _both_ targets, execute each on a
   fixed input grid (WGSL on WebGPU, GLSL on a headless WebGL2 context, CPU via the oracle), assert
   agreement within the f32/truncated-const tolerance the existing `_shader-math-parity` spec uses.
3. **GLSL compile gate.** `createShader`/`compileShader`/`getShaderInfoLog` on a headless WebGL2
   context — a generated GLSL string that fails to compile is a hard CI failure (cheap, no GPU draw).
4. **Real-GPU WebGL2 render parity** (R5 only) — pixel parity vs the WGSL render for the emulated
   shaders, gated by the existing `compare-parity-pixeldiff` discipline (CLAUDE.md §5).

## 9. Migration plan (WGSL stays byte-identical through R1–R3)

| PR     | Content                                                                                                      | Risk                                                                                                                       | Guard / acceptance                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `Backend` interface extraction (#6) + type normal form (#1: `canonicalKey`, neutral `KeyOf`, `Vec*` aliases) | **HIGH** — touches AC4 gate + `type-safety.test.ts` `@ts-expect-error` probes; do **atomically**, one typecheck-gated pass | `tsc --build` clean; snapshot byte-equal; suite green                                                                                     |
| **R2** | Intrinsic registry (#2); fold `cpu.ts` BUILTINS                                                              | LOW-MED                                                                                                                    | each `INTRINSICS[x].wgsl` reproduces today's exact string; snapshot byte-equal; CPU oracle unchanged                                      |
| **R3** | Structured entry/IO/stage (#3) + logical resource model + `LayoutPlan` to VTR (#4) + kill `raw` (#5)         | **HIGH** — the layout/binding hazard (§5)                                                                                  | WGSL `LayoutPlan` reproduces exact offsets+group/binding; snapshot byte-equal; executed-WGSL parity                                       |
| **R4** | `GlslEs300Backend` (T0/T1 shaders) + GLSL compile gate + differential test                                   | MED                                                                                                                        | raster/compositors/icon/text emit valid GLSL that compiles + matches WGSL/CPU within tolerance; render shaders raise `UnsupportedFeature` |
| **R5** | Data-texture buffer-emulation (S1) incl. VTR producer; transform-feedback or CPU for S2                      | **HIGH / week+**                                                                                                           | real-GPU WebGL2 pixel parity for polygon/line/point/sdf                                                                                   |

**Per-PR guards (all):** canonical `node node_modules/typescript/bin/tsc --build`; `polygon-variant-diff`
byte-equality; `_shader-math-parity`; full suite; `bun run build`. Sequential — never concurrent heavy
jobs.

## 10. Risk register

| #   | Risk                                                                                       | Likelihood | Impact | Mitigation                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------- |
| 1   | `std140` ≠ current 256-byte WGSL layout → producer/consumer drift (repo's #1 defect class) | high       | high   | `LayoutPlan` as the single SoT; round-trip UBO test; WGSL plan byte-pinned      |
| 2   | `KeyOf` normal-form change breaks the AC4 phantom gate / stale `@ts-expect-error`          | med        | med    | atomic R1, typecheck-gated; the gate's own tests are the oracle                 |
| 3   | data-texture emulation diverges from storage-buffer reads (precision / index math)         | med        | high   | differential test vs WGSL; the `.at(i)` accessor isolates the lowering          |
| 4   | scope creep into a full WebGL2 renderer                                                    | med        | med    | R1–R4 deliver a neutral IR + proof on easy shaders **without** committing to R5 |
| 5   | GLSL `precision`/derivative/`flat` edge cases                                              | low        | med    | GLSL compile gate catches at CI                                                 |

## 11. Non-goals

- Not a from-scratch rewrite — the IR is ~70% neutral; this de-leaks it.
- Not full WebGL2 render parity in the first tranche — T3 (compute/MSAA) stays WebGPU-only.
- Not changing WGSL render output — R1–R3 are byte-identical by construction.
- Not adopting luma.gl's string-module model — the typed IR is retained (it is strictly stronger).

## 12. Recommendation

Execute **R1–R3** (de-leak the IR into a genuine normal form; zero render-output change, byte-pinned),
then **R4** to _prove_ neutrality with a GLSL backend on the T0/T1 shaders, **before** committing to
R5's data-texture rewrite. After R1–R4 the package is honestly backend-neutral and the "luma.gl
position" is real; R5 (and a future SPIR-V/MSL writer) becomes incremental.

## References

naga `Writer`/`Capabilities`; Tint transform passes; SPIRV-Cross GLSL emit (combined samplers,
`std140`, struct-IO flatten); WGSL spec § shareable types & address spaces; GLSL ES 3.00 spec §4
(uniform blocks, `std140`); WebGL2 (no compute / no SSBO). Internal: `AGENTS.md:52` (256-byte
Uniforms), `_shader-math-parity.spec.ts`, `polygon-variant-diff.test.ts`.
