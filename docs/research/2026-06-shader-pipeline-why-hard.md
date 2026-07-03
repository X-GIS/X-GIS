# Shaders in the X-GIS runtime — where the real risk is, and why Blender's shader architecture makes it cheaper

_Deep-research synthesis, 2026-06-08. Five web-researched angles (Blender shader codegen, WGSL/WebGPU pitfalls, variant explosion, shader testing/debugging, string-vs-structured generation) merged with a direct file:line audit of the X-GIS shader pipeline. Companion to `2026-06-runtime-architecture-why-hard.md` (that one is about invalidation; this one is about shaders). Claims cited inline; confidence/caveats carried from verification._

---

## TL;DR — the honest verdict

**X-GIS's shader layer is more disciplined than a naive WebGPU renderer, and the audit confirms it.** Shaders are authored as a **typed TypeScript IR → WGSL backend** (`runtime/src/engine/shader-dsl/`), not hand-concatenated strings; a **uniform-layout-consistency test** parses the emitted WGSL and asserts CPU byte-offsets match field-by-field; **projection CPU/GPU parity tests** give a genuine CPU oracle for the shader math; and pipelines are **bounded and pre-allocated** (27 named pipelines, no dynamic permutation cache), so the variant-explosion disease of AAA engines simply doesn't apply here. Credit where due — several of these are exactly the mitigations the research literature recommends.

**The real shader risk is concentrated in three places, and they are the three Blender's architecture is specifically built to remove:**

1. **Emitted WGSL is never compiled or reflected in tests** — so a _semantic_ shader error (wrong function signature, undeclared name, bad binding) leaks past CI and surfaces only at async `createShaderModule` on a real GPU, as a silently non-rendering layer.
2. **A regex-based string splice + raw-WGSL "trust me" preambles** (`renderer.ts:130-140`) — the one spot where the otherwise-structured pipeline reverts to the string-concatenation footgun, with no check that the splice even landed.
3. **The depth/clip-space convention is spread across `camera.ts` + three separate shader paths with no round-trip test** — which is _precisely why the reversed-Z fix (#4) is expensive_: the convention must be mirrored, atomically, in every path.

Blender answers all three with a **structured, typed shader-interface descriptor** (`GPU_SHADER_CREATE_INFO`), a **single-source shader language lowered to every backend** (BSL + `shader_tool`), a **dependency-tracked shared library**, and **`#line`-mapped error reporting**. X-GIS has the _first half_ of that idea (the IR DSL) but stops at WGSL strings, which is where the cost re-enters.

---

## A. What X-GIS already does right (and the research that validates it)

This matters because the answer to "are there shader problems?" is _not_ "it's a string-concat mess." The audit found genuine discipline:

- **Structured generation, not string soup.** Core shaders are emitted from a typed IR (`StructDecl`, an `Expr`/`Node` union) by a WGSL backend (`shader-dsl/`), with variant fill/stroke logic carried as IR nodes [audit §arch]. This is the recommended alternative to hand-written shader strings — the same principle behind three.js TSL ("no shader strings to typo… no duplicated GLSL+WGSL") [angle5-12] and Blender's node→codegen [angle1-1,2].
- **A single source of truth for buffer layout, _with a test that enforces it_.** `uniform-layout-consistency.test.ts:119-173` parses the emitted WGSL struct, computes WGSL std140-like alignment, and asserts the CPU `f32` offsets match byte-for-byte; a real historical drift bug (point `viewport` at slot 20 in WGSL vs 24 in CPU writes) is pinned by it [audit §3,robust-1]. This directly defuses **the top WebGPU footgun**: `vec3<f32>` has size 12 but **alignment 16**, so hand-packed CPU structs misalign every later member, and "get a single byte wrong… you won't get an error" — silent corruption [angle2-1,5; angle5-2]. The JS ecosystem's standard fixes are exactly this kind of reflection (`webgpu-utils makeShaderDataDefinitions` parses the WGSL to derive offsets [angle5-5]; `wgsl_reflect` exposes per-member offsets [angle5-7]). X-GIS hand-rolled the equivalent assertion — good.
- **A CPU oracle for the math.** `projection-wgsl-consistency.test.ts` checks CPU `forward()` vs the WGSL `proj*Wgsl()` to 1 mm across every projection [audit robust-2]. The literature's core lament is that **GPU correctness has no cheap oracle** [angle4-1; companion doc §4] — X-GIS built one for the projection half by mirroring the math on the CPU. That is a genuinely strong pattern worth extending (see §C).
- **Variant explosion avoided by construction.** 27 pre-allocated pipelines, no runtime permutation-key cache [audit §pipeline]. AAA engines drown here — Unity's flagship shader reaches ~100 billion _possible_ variants [angle3-2], and draw-time PSO compilation causes the infamous stutter [angle3-9,10]. X-GIS's bounded, pre-allocated set sidesteps all of it; the only watch-item is if per-palette/per-feature variants ever grow unbounded (then variant _stripping_ [angle3-5] becomes relevant — not today).

---

## B. Where shader bugs are still hard to catch in X-GIS

### B1 — Emitted WGSL is never compiled or reflected in CI (highest-leverage gap)

Tests check WGSL **shape** (struct present, braces balanced, snapshot byte-diff) but **never compile or reflect the emitted shader** [audit §3,8]. The consequences chain through the research:

- Static validators (Tint/naga) reliably catch **type / binding / syntax** errors at module creation — `wgpu` makes naga validation mandatory [angle4-12] — **but they provably do not catch logic/math errors** [angle4-13], and a shader can even pass naga yet fail a downstream backend compile [angle4-13]. X-GIS runs _neither_ the validator nor a compile in tests, so it forfeits even the part that _is_ mechanically catchable.
- WebGPU **device-timeline errors are asynchronous and do not throw** [angle2-15]; a bad shader/layout surfaces as wrong pixels or a non-rendering layer, with errors going to `console.error`, not a user-facing affordance [audit §3,8]. So a broken variant is discovered only when a user loads that exact layer on real hardware.

**Mitigation (small, high-value):** run every emitted shader variant through `createShaderModule` wrapped in `pushErrorScope`/`popErrorScope` [angle2-15], or a naga/tint pass, in CI. This converts an async-on-real-GPU failure into a deterministic test failure — and it runs fine without a GPU (compilation/validation ≠ rasterization, which is the part SwiftShader can't do).

### B2 — The regex preamble splice: the one un-structured seam

Variant preambles (categorical color-match chains) are injected into the polygon WGSL by **regex-matching `@group(0) @binding(6)` and slicing the string back together** (`renderer.ts:130-140`), and some preambles remain **raw WGSL strings** passed as `{ s: 'raw', wgsl: … }` [audit §1,2]. If the DSL emit order or that binding's formatting ever changes, the match fails **silently**, the preamble isn't inserted, and the shader references undefined names [audit §1]. This is the exact failure mode the rest of the DSL was built to avoid: **string-templated code gets no static checking and fails only at runtime** [angle5-2,15]. It's also the one place a compiler-side change to preamble syntax is opaque to the runtime (no shared type contract — the `variant.fillExpr` is cast `as unknown as RuntimeExpr` [audit §11]).

**Mitigation:** make the preamble a first-class IR node inserted at a structural anchor (the DSL already has `Stmt` nodes), not a regex splice into text. Drift becomes a builder-time error instead of a silent miss.

### B3 — Color-space has no cross-shader check

The canvas is `premultiplied` with no `-srgb` view and shaders emit sRGB-encoded color, so blending runs in sRGB space — a deliberate MapLibre-matching choice (documented at `gpu.ts:185`), **not** a bug. But there is no automated check that _every_ fragment path emits sRGB; a variant that samples a linear texture without correction would blend silently wrong [audit §5]. The research confirms both that sRGB-space blending is "physically wrong" but a legitimate canvas-format decision [angle2-9,10] — the risk is purely _consistency drift_ across paths, which a small assertion could guard.

---

## C. Why changes and features cost more — the depth case, concretely

The reversed-Z fix (#4) is the cost curve made physical, and the shader audit shows exactly why. The depth/clip-space convention is **spread across at least four places with no test tying them together**:

- `camera.ts` / `view-matrix.ts` build the MVP (and the GL-range `perspectiveMatrix`);
- `polygon.ts` has **three separate vertex paths** computing clip-space `z` differently — ECEF (`mvp·vec4(ecef_rtc,1)`), flat (`z` hardcoded to 0), extruded [audit §4];
- log-depth (`log-depth.ts`) overlays its own `z` transform;
- every pipeline carries its own `depthCompare`/`depthClearValue`/`depthBias` state.

WebGPU's depth NDC is **[0,1], not GL's [-1,1]** [angle2-6], and reusing a GL projection silently clips near geometry [angle2-7] — a textbook silent-depth footgun. Because the convention is mirrored by hand across all four sites with **no round-trip test** (CPU matrix → expected NDC `z` → GPU-emitted clip `z` → framebuffer) [audit §4, difficulty-1], #4 must edit every site **atomically** — "if any single site is missed, geometry inverts/disappears." That indivisible blast radius _is_ the coupling tax the maintainability literature describes [companion doc §5].

**Mitigation that also de-risks #4:** extend the pattern X-GIS already nails for projections — add a **depth round-trip CPU oracle** (sample points → CPU MVP → expected NDC `z` → assert against the WGSL-emitted clip `z`). The projection-parity test proves this style works [audit robust-2]; depth just doesn't have one yet. With it, reversed-Z becomes "change the convention, watch one CPU test" instead of "edit N coupled shader paths and validate by eye on a desktop GPU."

---

## D. What Blender does differently (the reference design)

X-GIS and Blender start from the _same_ good idea — generate shaders from a structured representation, not strings (Blender: material node-tree → `gpu_codegen` → generated shader, the node graph as single source of truth [angle1-1,2]; X-GIS: IR DSL → WGSL). The divergence is **how far the structure extends**:

| Concern                                            | Blender                                                                                                                                                                                               | X-GIS today                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Shader interface** (uniforms, inputs, resources) | Declared in a **typed descriptor**, `GPU_SHADER_CREATE_INFO` with `UNIFORM_BUF`/`VERTEX_IN`/`SAMPLER`/`PUSH_CONSTANT` macros [angle1-5]; one definition validated and instantiated by name [angle1-6] | IR `StructDecl` for buffers (good), **but** the bind layout + some preambles are WGSL strings / regex-spliced [audit §1,2] |
| **Cross-backend**                                  | One source (BSL) lowered to GLSL/MSL/SPIR-V by `shader_tool` (`convert_glsl/_msl`) with `GPU_OPENGL/_METAL/_VULKAN` defines [angle1-7,8]                                                              | Single backend (WGSL); not a current need, but no abstraction if it becomes one                                            |
| **Shared library / reuse**                         | `#include` resolved by **dependency tracking** (`gpu_shader_dependency.cc`), builtins auto-injected [angle1-9]                                                                                        | String-array `join('\n')` of module snippets [audit §arch] — reuse works but is positional, not dependency-tracked         |
| **Error debuggability**                            | `#line` directives injected so compile errors **map back to original source** across transforms [angle1-10]                                                                                           | Emitted as a joined string blob; a GPU compile error points into generated text with no source map                         |
| **Validation**                                     | Structured descriptor enables validation; backends compiled from one definition [angle1-6,7]                                                                                                          | No compile/reflect step in tests [audit §8]                                                                                |

The pattern is the spectrum the research lays out: **hand-offset strings (silent runtime corruption) → runtime reflection (single source of truth) → build-time codegen with compile-time assertions (`wgsl_to_wgpu`: "changing a uniform type raises a compile error") → node-graph systems (no shader strings at all)** [angle5, summary]. Blender sits at the structured-descriptor + codegen end. X-GIS sits in the middle — typed IR for the _body and buffer layout_ (with a layout test standing in for the compile-time assertion), but **strings + regex for the interface seam and no compile step**, which is where bugs re-enter and changes get expensive.

> Note: even Blender pays real shader costs that structure doesn't erase — EEVEE must compile every material's shaders (deferred shaders ~10–20k lines, ~100–200 ms to parse; order-of-magnitude, dev-estimated [angle1-14, med]) and added an async-compilation option to avoid UI stalls [angle1-13]. Structure lowers _bug_ and _change_ cost; it doesn't make shader compilation free. X-GIS's bounded pre-allocated pipelines actually make it _less_ exposed to that particular cost than Blender.

---

## E. Concrete next steps (small, grounded — not a rewrite)

Ranked by leverage-to-cost, all consistent with patterns X-GIS already uses:

1. **Compile/reflect every emitted shader variant in CI** (naga/tint, or `createShaderModule` + error scopes). Turns B1 from "async failure on a user's GPU" into a deterministic, GPU-free test. Highest leverage, smallest change. [angle4-12,13; angle2-15]
2. **Add a depth round-trip CPU oracle** mirroring the projection-parity test, so #4 (reversed-Z) and any future depth change are gated by one CPU assertion instead of N hand-mirrored shader edits. [audit robust-2, §4]
3. **Replace the regex preamble splice (B2) with a structured IR insertion node** — remove the last un-checked string seam. [audit §1,2]
4. **(Watch, not now)** keep variants bounded; if per-palette/feature variants grow, add variant stripping before PSO/compile cost matters. [angle3-4,5]

None of these is a rewrite — (1) and (2) extend testing patterns X-GIS already has, and (3) moves one seam from string to IR.

---

## Sources

**X-GIS codebase audit** (file:line): `runtime/src/engine/shader-dsl/` (IR DSL), `renderer.ts:130-140` (regex splice), `renderer.ts:95-123` (`as unknown` cast), `polygon.ts:1131-1139` (string-join compose), `polygon.ts` VS (three depth paths), `gpu.ts:185-195` (sRGB/premult), `vector-tile-renderer.ts:73-84` (UNIFORM_SLOT cap), `uniform-layout-consistency.test.ts:119-173` + `point-uniform-layout.test.ts` (layout oracle, robust), `projection-wgsl-consistency.test.ts` (CPU/GPU parity, robust), `polygon-variant-diff.test.ts` (snapshot diff, robust).

**Angle 1 — Blender shader codegen.** deepwiki 6.2-shader-system / 6.2-shader-preprocessing-system / 6-gpu-module (GPU_SHADER_CREATE_INFO, BSL, shader_tool, #include deps, #line) [high]; gpu_codegen Doxygen mirror (letworyinteractive) [high, C-era]; projects.blender.org commit 80859a6cb272 + developer.blender.org GPU docs [med, 403/snippet]; EEVEE shader-compilation issues #145347/#146340 [med].
**Angle 2 — WGSL pitfalls.** webgpufundamentals memory-layout / transparency / wgsl [high]; W3C WGSL + WebGPU specs [high]; gpuweb/gpuweb#416, toji/gl-matrix#369 (depth [0,1]) [high]; toji.dev webgpu-best-practices error-handling (async errors don't throw) [high]; gpuweb#2776/#2270 (NaN/Inf) [high].
**Angle 3 — variant explosion.** Unity shader-variants docs [high]; aras-p.info "Every Possible Scalability Limit" [high, blog]; therealmjp shader-permutations 1&2 [high]; Epic PSO-precaching docs + tomlooman + 80.lv [high]; Khronos VK_EXT_graphics_pipeline_library + NVIDIA PSO guidance [high]. (94%-stutter figure dropped — single unverifiable blog.)
**Angle 4 — shader testing/debugging.** learnopengl debugging [high]; NVIDIA Nsight shader-debug blog (dual-GPU) [high]; RenderDoc how_debug_shader / how_inspect_pixel (Pixel History) [high]; PIX devblogs [high]; webgpufundamentals storage-buffers (debug-buffer readback) [high]; naga/wgpu trackers #5433/#4456 (validates types, not logic) [high]; Vulkan debugPrintfEXT, hot-reload, Shaderator/ComputeTestTools [med].
**Angle 5 — string vs structured.** webgpufundamentals memory-layout + webgpu-utils (greggman) [high]; wgsl_reflect (Brendan Duncan) [high]; wgsl_to_wgpu (compile-time const assertions) [high]; wgsl-bindgen [med]; three.js TSL (Maxime Heckel) + Babylon NodeMaterial [high]; codegen type-safety arXiv 1002.1549 [med]. (One future-dated arXiv citation dropped.)

_Confidence: the X-GIS audit (direct repo read) and the high-confidence web claims (WGSL spec/webgpufundamentals/toji, RenderDoc/PIX/naga docs, Unity/Epic/Khronos, greggman/wgsl_to_wgpu) are load-bearing. Blender specifics lean on deepwiki + headers because official Blender domains 403'd; EEVEE compile-cost numbers are dev-estimated order-of-magnitude. Dropped in verification: a future-dated arXiv ID and an unverifiable PSO-stutter percentage._
