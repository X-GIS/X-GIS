# TypeShade — ecosystem embedding: injecting the reason to exist into other libraries (2026-09-07)

**Citation convention.** Every host fact below carries a bracket key resolved in §8 to a full URL, **all fetched 2026-09-07**;
the date is not repeated per line. Claims from memory are marked "(from memory)". Host research was produced by six researchers
and then adversarially verified; where a verifier refuted a claim, the corrected form is what appears here — the refuted form
does not.

## 0. Executive summary

TypeShade's survival is currently a function of X-GIS's survival — a single point of failure. The owner's fix, restated as a
strategy: make OTHER libraries, and their users, the ones who need TypeShade to keep existing. The name is the
**Forward-Compatible Ingredient Strategy** (전방호환 인그리디언트 전략): TypeShade ships as a branded, `reflect()`-backed
*ingredient* inside other people's engines — one adapter per host and per host version, maintained like an OpenTelemetry
instrumentation package — so the host gains a capability it did not build and the host's users get shaders that outlive the
host's current GPU API. Three moves:

1. **Adapters.** `@typeshade/{pixi,maplibre,deck,three,babylon,cesium}` — one core, peer-ranged, zero runtime deps, with a
   host-version × backend conformance matrix in CI. That matrix, not a landing page, is the product (§2).
2. **A written forward-compatibility promise**, scoped to the shader source and dated from the `0.1.0` freeze, whose honest
   caveats are published beside it (§5) — including the hosts where the migration pitch does not apply at all.
3. **An upstreaming ladder** climbed one rung at a time (§4), aimed at the *build-time* seam — the host generating its own
   shaders from TypeShade — never at a runtime dependency, which every host's culture rejects.

## 1. What this strategy is called

The owner's directive — _"inject the reason TypeShade is needed into OTHER libraries… per MapLibre version, a reflected adapter…
code written in TypeShade survives when MapLibre moves to WebGPU"_ — is not one strategy but a stack of five named ones. Below:
the name, the source, and the TypeShade mapping.

**1. Ingredient branding (Intel Inside, Gore-Tex, Dolby).** A component with its own brand identity, marketed _through_ the host
product so end users demand the ingredient — Kotler & Pförtsch analyse 100+ cases and build them on Intel, Gore-Tex, Dolby,
Tetra Pak, Shimano, Teflon. Intel's own account: Intel Inside launched 1991 as co-op marketing paying OEMs to carry the logo; by
end-1992, 500+ OEMs and 70% of eligible OEM ads. TypeShade's equivalent is a "shaders by TypeShade" line in a host engine's docs
plus a visible `reflect()`-backed adapter, not a silent vendored file. — Kotler & Pförtsch, _Ingredient Branding: Making the
Invisible Visible_ (Springer, 2010) [S1] (search-verified; direct fetch redirects to Springer auth) · Intel, "End-user
marketing: Intel Inside" [S2]

**2. Complementor strategy / co-opetition (Brandenburger & Nalebuff).** A complementor is a player whose product makes yours
more valuable to the same customer; the Value Net puts complementors opposite competitors, so "companies can succeed
spectacularly without requiring others to fail." TypeShade is a pure complementor to every WebGL2/WebGPU host: it removes the
twin-shader tax without competing for the host's scene graph, camera or tile pipeline. — Brandenburger & Nalebuff, "The Right
Game", _HBR_ Jul–Aug 1995 [S3] (quote from that page — the _complementor_/Value Net wording and _Co-opetition_ (1996) are **from
memory**; the landing page carries only the opening)

**3. Platform leadership (Gawer & Cusumano).** Their four levers: scope of the firm, product technology and interfaces,
relationships with complementors, internal organisation — "designing the right interfaces/connectors and disclosing intellectual
property selectively" plus "incentives for third-party companies to create the complementary innovations." TypeShade plays the
_complementor-side_ mirror: the host owns the platform; TypeShade owns one interface (typed source → WGSL + GLSL) and gives it
away. — Gawer & Cusumano, "How Companies Become Platform Leaders", _MIT SMR_, Jan 2008 [S4] (_Platform Leadership_, HBS Press
2002, **from memory**)

**4. Keystone / niche-player strategy (Iansiti & Levien).** Ecosystems have keystones (hubs that provide platforms others
leverage), dominators, and niche players at the edge supplying specialised innovation. TypeShade is deliberately a **niche
player that the keystones depend on** — not a hub. That is the durable seat: hubs churn, the triangulator does not. — Iansiti &
Levien, "Strategy as Ecology", _HBR_ March 2004 [S5] (authors/date confirmed there; the keystone / dominator / niche taxonomy is
from _The Keystone Advantage_, HBS Press 2004, **from memory**, corroborated by search)

**5. Platform envelopment — and why TypeShade is the inverse.** Envelopment is offence: "a provider in one platform market can
enter another platform market, combining its own functionality with the target's in a multi-platform bundle that leverages
shared user relationships," foreclosing the incumbent's users. TypeShade does the **inverse — voluntary self-envelopment**: it
hands its functionality _into_ the host's bundle, keeps zero user relationship of its own, and takes payment in dependency
status rather than in captured share. Same mechanism (shared users, bundled functionality), opposite direction and opposite
intent. — Eisenmann, Parker & Van Alstyne, "Platform Envelopment", _SMJ_ 32(12), 2011 [S6] (abstract read via search index; the
Wiley page returned 403 on direct fetch)

**6. Upstreaming / becoming a transitive dependency.** The tiny-library survival law: MapLibre GL JS today depends on `earcut` —
a small, zero-dependency triangulator originally built for Mapbox GL JS and since adopted by three.js, Pixi, deck.gl and Cesium.
The negative proof is the same mechanism failing: left-pad's unpublish caused "hundreds of failures per minute" of
dependents-of-dependents for 2.5 hours (2016), and xz/liblzma 5.6.0–5.6.1 was backdoored precisely because everything sits
downstream of it (CVE-2024-3094). The formalisation of "who counts" is OpenSSF's criticality score (0 = least, 1 = most
critical, weighted on dependents, age, maintenance) and Census II's half-million observations of FOSS libraries in production. —
[S7] earcut · [S8] left-pad · [S9] Freund, oss-security 2024-03-29 · [S10] criticality_score · [S11] Nagle et al., _Census II_

**7. Switching costs and lock-in — turned around.** Shapiro & Varian: lock-in is what happens when the cost of switching
technologies traps users, and it "can be a source of enormous headaches, or substantial profits, depending on whether you are
the one locked in the room or the one in possession of the key." TypeShade's inversion: it does not create switching costs, it
**absorbs** the one the industry already has (GLSL ES 3.00 → WGSL), so the user never pays it. Lock-in to TypeShade is then a
by-product of value delivered, not a toll — and the honest way to say so is that the escape hatch is the emitted WGSL/GLSL
itself. — Shapiro & Varian, _Information Rules_ (Harvard Business Press, 1998), chs. 5–6 [S12] (the "total switching costs ≈
profit from a customer" formulation is **from memory**)

**8. Real options / optionality.** An investment under uncertainty is worth holding as "the right, but not the obligation" to
act later; that option value is what a now-or-never NPV misses. The uncertainty here is documented, not hypothetical: MapLibre
GL JS's own roadmap says it "is getting a WebGPU rendering backend alongside the existing WebGL2 renderer," with a phase to
"port GLSL shaders to WGSL" (tracking issue #2606, open since 2023-05-28). A shader written in TypeShade is therefore a real
option on that migration: the host exercises it by switching backend, and the option costs its owner nothing to hold. — Dixit &
Pindyck, _HBR_ May–Jun 1995 [S13] · [ML-roadmap] · [ML-2606]

**9. Insulation layers — the four patterns the adapters must implement.** - **Anti-corruption layer (Evans, DDD).** "Implement a
facade or adapter layer between different subsystems that don't share the same semantics… so that dependencies on outside
subsystems don't limit an application's design." TypeShade's adapter translates a host's uniform/attribute conventions into
`reflect()`-derived layouts so the host's API churn never reaches the shader source. — [S14]
- **Ports and adapters / hexagonal (Cockburn, 2005).** Intent: "Allow an application to equally be driven by users, programs,
  automated test or batch scripts, and to be developed and tested in isolation from its eventual run-time devices and
  databases." TypeShade's core is the port (typed IR → two targets); every host integration is an adapter, and the CPU f64
  oracle is the isolation test. — [S15]
- **Compatibility promise (Go 1, Rust editions, Bazel).** Go 1: "programs written to the Go 1 specification will continue to
  compile and run correctly, unchanged, over the lifetime of that specification." Rust editions: crates in one edition **must**
  seamlessly interoperate with those compiled with other editions. Bazel: breaking changes ship as `--incompatible_*` flags,
  each with an issue and a migration recipe. TypeShade needs exactly one of these, written down, covering emitted-source
  semantics. — [S16] [S17] [S18]
- **Adapter matrix (Testcontainers, Sentry, OpenTelemetry).** One core, many host adapters, each versioned against its host:
  Testcontainers lists ~200+ "preconfigured implementations of various dependencies" across seven languages; Sentry's SDK "uses
  integrations to hook into the functionality of popular libraries"; OpenTelemetry keeps a stable API that libraries depend on
  while per-library instrumentation ships as separate contrib packages with their own version-support ranges. This is the
  literal shape of "per MapLibre version, a reflected adapter". — [S19] [S20] [S21] [S22]

**The name to use.** **Forward-Compatible Ingredient Strategy** — Korean: **전방호환 인그리디언트 전략** (짧게: _성분 전략_ — 남의 엔진 안에 심는 브랜드 성분 +
세대 이전 보증).

TypeShade ships as a branded, `reflect()`-backed ingredient inside other people's engines — one adapter per host and per host
version, maintained like an OpenTelemetry instrumentation package — so the host gains a capability it did not have to build, and
the host's users gain shaders that outlive the host's current GPU API. The strategy pays for itself by absorbing the WebGL2 →
WebGPU switching cost inside a written compatibility promise, which moves the reason to keep TypeShade alive from X-GIS onto the
hosts and their users.

## 2. The mechanism — host adapters as the survival layer

**Shape.** One core (`typeshade`) + per-host adapter packages, each in its own repository in the product org so it can accept
PRs directly and be its own landing page (per strategy §6.2): `@typeshade/pixi`, `@typeshade/maplibre`, `@typeshade/deck` (+
`@typeshade/luma`), `@typeshade/three`, `@typeshade/babylon`, `@typeshade/cesium`. Every one: MIT, **zero runtime
dependencies**, `import type`-only against the host, host declared as a `peerDependency`, build-time-first (emit is 33–152 ms
warm on this tree with `optimize` at 89%, so a runtime-emitting adapter would put a compiler on a host's first frame and be
correctly rejected).

**What the adapter generates from `reflect()`.** The generic contract, instantiated per host:

| Layer | What `reflect()` supplies | Per-host instantiation |
| --- | --- | --- |
| Program creation | both emits from one IR | Pixi `GlProgram`+`GpuProgram`; MapLibre compile/link **with status checks the official examples omit**; three `wgslFn`/`glslFn`; Babylon `Effect.RegisterShader(…, ShaderLanguage.GLSL / .WGSL)`; Cesium `CustomShader{vertex,fragment}Text`; luma `ShaderModule{source,vs,fs}` |
| Bindings | `BindEntry {group,binding,name,space,access,resourceKind,glslSpelling,structName,textureDim}` | Pixi `GpuProgramOptions.layout`/`.gpuLayout` + `Shader.groupMap`; luma `ShaderLayout`; Babylon `ComputeShader.bindingsMapping`; MapLibre `getUniformLocation` table + typed setter arity |
| Uniform packing | std140/std430 offsets, `StructLayout.fields[].offset` | MapLibre: we write the UBO. Pixi/luma/Cesium/Babylon: **the host packs** — we supply the declaration and cross-check its offsets in a test. Say which side owns the bytes, per host, in the README |
| Vertex layout | `VertexLayout {attributes, arrayStride}` | Pixi `Geometry` formats; luma `AttributeDeclaration.location/stepMode`; MapLibre `vertexAttribPointer` size/type/stride/offset |
| Entry points | `EntryInfo` | never a string literal a refactor can desync |
| Capability | `requiredFeatures`, fail-closed profile | build FAILS with a source location when the host cannot express the program (e.g. Cesium: no uniform arrays, no UBO/SSBO, no compute, square matrices only) |

**What the user writes.** One TypeShade module plus one adapter call. No GLSL string, no WGSL string, no `@group`/`@binding`, no
`getUniformLocation`, no hand-chosen `gl.uniform*` arity, no `bindingsMapping`, no `UniformType` enum, no per-backend `if`.

**What stays stable.** The module. Everything a host can change — uniform NAME sets, prelude function sets, option-bag shapes,
GL call sequence, preset state, dialect rules — lives in the adapter's per-major entry (`@typeshade/maplibre/v6`,
`pixiAbi('8.20')`, `dialect/v9.ts`).

**The compatibility matrix, and it is the product.** For each supported host major × each published host minor (patches
included) × each backend: (a) install the host from the registry, (b) emit both arms, (c) assert the adapter's reflected tables
deep-equal the host's own derivation where the host exposes one — Pixi's `extractStructAndGroups` / `generateGpuLayoutGroups`
are supported public API since 8.20.0 (PR #12143) and importable back to 8.7.0, but `generateLayoutHash` is **still
`@internal`**, so pin the layout hash against recorded fixtures too [PX-12143]; (d) parse the host's own published shader
sources and assert every declared `externVar`/`externFn` still exists — MapLibre's npm tarball ships `src/`, so the preludes are
readable from the immutable registry for every published version [ML-pkg]; (e) compile the WGSL on Tint and the GLSL on real
WebGL2, both of which run headlessly on SwiftShader in this repo's CI today; (f) render both arms and run the CPU f64 oracle.

**Why this keeps TypeShade alive with zero X-GIS involvement.** The matrix converts "it still works on host N+1" from a hope
into a published, dated measurement — which is the one artifact a host maintainer, a host user, and an agent can all check. Once
a host's own users write shaders through an adapter, the demand for the next adapter release comes from them, not from X-GIS;
once a host generates its own shaders through a build-time step (§4 rung 5), the demand comes from the host's maintainers.
Neither channel routes through X-GIS. The honest counterweight, which must be planned for rather than assumed away: until a
rung-5 relationship exists, the adapters make TypeShade depend on the hosts' release trains while the hosts depend on nothing of
ours — see §7.

## 3. Host-by-host findings

**A — facts.** (Every row's sources are keyed in §8.)

| Host | Extension point | Backend today | WebGPU status | Duplication tax today | Cadence | Governance |
| --- | --- | --- | --- | --- | --- | --- |
| **PixiJS** 8.20.1 | `Shader.from({gl,gpu})`, `Filter`, `Mesh`, `GpuProgram.layout`/`.gpuLayout`, `Shader.groupMap` | WebGL2 + WebGPU + Canvas2D, **WebGL tried first** | shipped-not-default; docs label it 🚧 Experimental and "recommend the WebGL renderer for production" | **live and permanent**: both programs required or the shader/filter is skipped; pixi-filters = 4,387 hand-written lines, every one of the 36 shader dirs carrying both | 69 stable 8.x over 21 minors; 7 minors + 7 patches in the last 12 mo | 4 active volunteers, unpaid; ~$40.3k/yr Open Collective; 2 approvals + 24 h |
| **MapLibre GL JS** 6.7.0 | `CustomLayerInterface` / `CustomRenderMethod(gl, {shaderData, getProjectionData, …})` | **WebGL2 only** (WebGL1 removed in 6.0.0) | in-progress: Phase **5 of 6** in tracking issue #7640 (the roadmap page numbers the same work "phase 4"); nothing on main; no dates | none per-backend yet; instead ~114 lines of plumbing around ~25 lines of shader in the official globe example, none of it checking compile or link status | a release every ~5–6 days; majors ~19 mo apart | charter (2022-08-25), TSC open to all, monthly video, 5-person elected board, Open Source Collective host |
| **deck.gl / luma.gl** 9.4.0 | `ShaderModule {source, vs, fs, uniformTypes}`, `Layer.getShaders()`, `LayerExtension` | WebGL2 by default; WebGPU strictly opt-in (~1% of `@luma.gl/core` installs) | in-progress, "not production ready"; all catalogue layers ✅ at 9.4 but 7 of 8 extensions ❌ and general WGSL injection unsupported | shader **body** twice + uniform **struct** three times, and the three disagree in the flagship layer | ~2 minors/yr, accelerating; alpha→GA 1.1–4.4 mo | OpenJS **Incubation**; 4-person vis.gl TSC; "we are actively looking for new maintainers" |
| **three.js** r185.1 | `wgslFn`/`glslFn` + `NodeMaterial.{vertex,fragment}Node`; `ShaderMaterial` (WebGL only) | WebGL2 default import; `three/webgpu` since r167 | **experimental by its own label** — manual says so and `files.json` files every demo under `webgpu (wip)` at every tag r168→r185; the default `three` import does not export `WebGPURenderer` | native-code path duplicates per backend, and `CodeNode.language` is consulted by **no** node builder, so a WGSL string reaching the GLSL builder is mis-parsed, not rejected | monthly through r180, then 57–69-day gaps | BDFL, personal account, no GOVERNANCE.md, 29 sponsors; @sunag owns TSL+NodeMaterial |
| **Babylon.js** 9.25.0 | `ShaderMaterial` + `ShaderStore*WGSL`, `Effect.RegisterShader`, `MaterialPluginBase`, `ComputeShader` | WebGL2 default ctor; `WebGPUEngine` opt-in; `EngineFactory.CreateAsync` **prefers WebGPU** | shipped since 5.0 (May 2022), declared parity | two languages, two Babylon-specific dialects, and three methods branch on `shaderLanguage` in the official plugin example (`getCustomCode`, `getUniforms`, `isCompatible`) | ~10 releases in 29 days; annual late-March majors | Microsoft-employed team, BDFL (Catuhe); no funding config |
| **CesiumJS** 1.145 / engine 26.3 | `CustomShader` (@experimental), `PostProcessStage`, Fabric `Material`, `Appearance` | **WebGL2 only** (WebGL1 fallback narrowing) | **discussed only**: 0 `.wgsl` files (against a 319-file GLSL control), 0 WebGPU-titled PRs ever, 0 of 6,285 changelog lines, #4989 open since 2017-02-10 unmilestoned | one language, three embedding dialects, zero type-safety; Cesium already owns the binding boilerplate | monthly, first business day, 32 consecutive months | single-vendor (Cesium GS / Bentley since 2024-09-06), CLA-gated, ion-SaaS funded |

**B — strategy fit.**

| Host | Reach (npm/wk) | Pain today | Migration to be forward-compat WITH | Governance openness | Map-domain fit | Realistic ceiling |
| --- | --- | --- | --- | --- | --- | --- |
| PixiJS | 920k | **highest** | none — dual is permanent by decision | good (docs PR, 2 approvals) | low | **rewrite pixi-filters on TypeShade** (rung 5) |
| MapLibre | 4.37M | low today | **published and tracked** (2027–2028) | formal, slow, open | **highest** | build-time codegen for their 71 `.glsl` sources |
| deck.gl/luma | 791k (`@luma.gl/core`) | maintainers', not users' | in flight, seam being redesigned now | OpenJS TSC, short-handed | high | codegen the `.wgsl.ts`+`.glsl.ts`+`uniforms.ts` triple |
| three.js | 14.0M | bounded to raw/compute/plugin paths | already largely done | one person, zero-deps forever | low | an official `examples/` entry |
| Babylon | — | bounded, and NME/editors compete | done in 2022 | corporate BDFL, no deps | medium | `BabylonJS/Extensions` + an NME CustomBlock WGSL PR |
| Cesium | 321k (`@cesium/engine`) | untyped, but boilerplate already solved | **none exists** | CLA, no RFC process, no plugin registry | **highest** | an independent adapter; nothing above it is reachable |

### 3.1 MapLibre GL JS — the flagship narrative, not the first ship

The adapter declares MapLibre's boundary as TypeShade host primitives: `externVar` for the prelude uniforms
(`u_projection_matrix`; under globe also `u_projection_tile_mercator_coords`, `u_projection_clipping_plane`,
`u_projection_transition`, `u_projection_fallback_matrix`), and `externFn` for the prelude entry points **declared per variant,
not as one flat list**: `projectTile(vec2)`, `projectTile(vec2,vec2)`, `projectTileWithElevation`, `projectTileFor3D` and
`projectLineThickness` exist in both, while `projectCircleRadius` exists **only in the mercator prelude** — the globe prelude
mentions it in a comment and never defines it, so a flat declaration links under mercator and fails to link the moment the user
switches to globe [ML-merc] [ML-globe]. A `variantFamily` keyed on the host's own `shaderData.variantName` values
`'mercator'`/`'globe'` handles the swap once [ML-custom].

Reserved names for the single translation unit are gated against the **fetched prelude text**, never a hand-kept list: `PI`, the
`u_projection_*` set, the varying `v_projection_tile_x`, the macro `GLOBE_RADIUS`, the entry points above, and the globe
prelude's internal helpers `globeRotateVector`, `globeGetRotationMatrix`, `circumferenceRatioAtTileY`, `projectToSphere` (×2),
`globeComputeClippingZ`, `interpolateProjection`, `interpolateProjectionFor3D`, plus the `GLOBE`/`PROJECTION_MERCATOR` defines
[ML-globe].

Corrections that change the plan. The `#ifndef PROJECTION_UBO` guard is **unreleased** — GM2.1 (#8290) merged 2026-09-03, one
day after v6.7.0, exists only on main and appears in no CHANGELOG section, so an adapter pinned to the current release sees the
pre-UBO contract [ML-8290]. The contract also moves in **patch** releases: `projectionTransition` went from hardcoded-1 to live
in **6.4.1** (#8169, published 2026-08-18), filed under bug fixes — so run the drift check continuously, not per-major [ML-chg].
`addLayer(layer: AddLayerObject, beforeId?)` takes a union of which `CustomLayerInterface` is one arm [ML-map]. MapLibre's own
71 shaders are already generated by `build/generate-shaders.ts` into `.g.ts` modules that are **gitignored** and produced by
`npm run codegen` wired to `prepare` — a build-time seam with zero runtime and zero repo footprint, which is the only rung-5
shape their bundle-size culture can accept [ML-gen] [ML-pkg]. One free credibility item: the JSDoc example inside
`custom_style_layer.ts` shows `render({gl, modelViewProjectionMatrix})` while `CustomRenderMethod` a hundred lines above takes
two positional arguments — the documented example does not typecheck against the documented type [ML-custom].

### 3.2 PixiJS — the live tax, and the cheapest reach

The rule is in the class docblock and has not moved since 8.0.0: "you need to provide both a WebGL program and a WebGPU program…
If only one is provided, the shader won't function with the omitted renderer" [PX-shader]; `Filter` says the same and the filter
is silently skipped [PX-filter]; on WebGPU a GL-only mesh shader emits a DEV-only `warn` and returns [PX-mesh]. Measured:
pixi-filters ships 1,907 lines of GLSL against 2,480 of WGSL for ~38 effects, and every one of the 36 src directories that ships
shader source ships both [PX-filters]. Seven of the eleven core examples with a `.frag` ship no `.wgsl` at all — the missing
`.wgsl` is the load-bearing fact, not the `preference: 'webgl'` line, since two of the four that DID write the twin also pass it
[PX-ex].

The strongest artifact: `bulge-pinch` guards its clamp with `if (coord != clampedCoord)` in GLSL (true when *any* component
differs) and `if (coord.x != … && coord.y != …)` in WGSL (true only when *both* do), so the two backends darken a different set
of edge pixels, and a dead `compareVec2` sits below it as the fossil of the hand-port [PX-bulge]. **Publish this as "the two
hand-written halves are not the same program, here are the lines" — not as a measured pixel difference — until the oracle has
run both arms** (neither shader was executed during research).

Injection points are real but not total: supplying `layout` + `gpuLayout` means Pixi never *derives* a layout from our WGSL, but
`extractStructAndGroups` runs unconditionally in the same constructor and `attributeData` is a getter with **no** injection
point — and that regex has already failed on valid WGSL once (#11819) [PX-gpuprog] [PX-attr]. The emitted WGSL therefore stays
coupled to a host parser and must be re-gated every minor. The APIs are **additively** stable, not frozen: `Shader.from`,
`GpuProgramOptions` (incl. `layout`/`gpuLayout`) and `Filter.from` are byte-identical to v8.0.0, while `GlProgramOptions` gained
`transformFeedbackVaryings` and `FilterOptions` gained `clipToViewport` and widened `resolution` to `number | 'inherit'`
[PX-diff]. Never ship "zero changes" — one `git diff` refutes it.

**The rung that makes Pixi first:** `skills/` is in `package.json`'s `files` array, so 26 first-party Agent Skills ride inside
the tarball that 920k installs a week pull down, and `skills/pixijs-custom-rendering/SKILL.md` is the file that currently
teaches an agent to write `const glVertex = '…'; const wgslSource = '…'` side by side [PX-skill] [PX-pkg]. A docs PR adding one
subsection reaches every agent's context on the next release.

### 3.3 deck.gl + luma.gl — the sharpest defect, the shortest window

`ShaderModule` carries `source` (WGSL) and `vs`/`fs` (GLSL) in ONE plain-data object, `Layer.getShaders()` merges it
(`layer.ts:469-478`), and switching backend is one `deviceProps` change — so the mechanism the forward-compat promise needs
already exists here [DG-mod] [DG-layer]. The defect: `ScatterplotLayer` declares its uniform struct three times — a GLSL std140
block, a WGSL struct, and a `uniformTypes` table — and they disagree (`filled` is GLSL `float` / `uniformTypes` `f32` / WGSL
`i32`; same for `antialiasing` and `billboard`), while the validator compares **names only**
(`areStringArraysEqual(expectedUniformNames, actualUniformNames)`) and `UniformLeafType` maps a `number`-or-`boolean` prop onto
the union `'f32'|'i32'|'u32'` so tsc cannot see it either [DG-uni] [DG-wgsl] [DG-val]. Two nuances make the finding land instead
of insulting: the shader **body** is written twice and the **struct** three times, and the WGSL only ever compares those fields
against zero (`!= 0` / `== 0`, never `== 1`), which is a deliberate accommodation of float-packed booleans. File it as "three
declarations, no check, and the host's own docblock says types MUST match", never as a demonstrated rendering fault.

Version floors matter and were mis-dated in research: `@binding(auto)`, `bindingLayout`, `firstBindingSlot` and
`validateShaderModuleUniformLayout` all landed in **9.3** (2026-03-31); only `scanWGSLInterface` and the split `GLSL`/`WGSL`
assemblers are new in 9.4 [DG-93] [DG-94]. And `ShaderModule.source` starts at 9.1 while `Model`'s `source?:` is already in
`@luma.gl/engine@9.0.0` — state which seam a floor refers to [DG-model]. The alpha window for testing an unreleased host is
**1.1–4.4 months and shrinking** (9.3 was 1.1, 9.4 was 1.7), so only an automated alpha-tracking CI job is a keepable commitment
[DG-npm]. The competing authority is half-built already: `generateShaderForModule` dispatches to `generateGLSLForModule` /
`generateWGSLForModule` today, so lead with the shader body and the oracle, not with the struct [DG-gen].

### 3.4 three.js — biggest audience, hardest sell

`wgslFn`/`glslFn` + `NodeMaterial.{vertex,fragment}Node` is the injection point, and it is unusually stable: the 135-section
migration guide has **zero** entries for `FunctionNode`, `CodeNode`, `wgslFn` or `glslFn` [TJ-mig]. But TSL is first-party,
free, and genuinely compiles one graph to both backends; r184 added `WebGLRenderer.setNodesHandler` so TSL node materials now
run on the legacy renderer too; and an official GLSL→TSL transpiler ships in-repo [TJ-r184] [TJ-transp]. The defensible ground
is therefore **portability out of three** plus typed signatures plus the oracle — never "one source, two backends". Two hard
facts for the adapter: `varyingProperty` takes **two** arguments (`varyingProperty('vec2','vUv')` — the name is what the WGSL
body addresses as `varyings.vUv`) [TJ-ex], and the new `Renderer` has `getContext()` but **no** `resetState()`, so the
raw-pipeline path where TypeShade does the most work is the one that does not survive three's own WebGPU migration
[TJ-renderer]. @sunag is the named owner of TSL and NodeMaterial; mrdoob cuts releases. Rung 5 does not exist — `three` has had
zero runtime dependencies at every tag from r100 (2018) to r185 [TJ-pkg].

### 3.5 Babylon.js — no migration to sell, one genuinely cheap arm

WebGPU shipped in 5.0 (May 2022) with declared parity, so the migration pitch is four years late here and must not be used
[BJ-webgpu] [BJ-status]. What is live: `getCustomCode(shaderType, shaderLanguage)`, `getUniforms(shaderLanguage)` **and**
`isCompatible(shaderLanguage)` all branch by hand in Babylon's own plugin example — and `isCompatible`'s base default returns
true for GLSL only, so a plugin that forgets it is silently inert on WebGPU no matter how correct its WGSL [BJ-plugin]
[BJ-base]. The research's headline risk is refuted and reversed: a body carrying `#version 300 es` hits `shaderProcessor.ts`'s
"Already converted" branch, which strips that one line and **returns before any rewrite runs** (because `WebGL2ShaderProcessor`
leaves `parseGLES3` unset), so the GLSL arm is nearly free — **emit** the directive, do not suppress it; the cost is that
Babylon's `#ifdef` evaluation is skipped, so resolve defines at emit time [BJ-proc]. WGSL is the expensive arm and is **two**
dialects: decoration-free for materials ("You must NOT add the `@group(X) @binding(Y)` decoration"), and hand-decorated for
`ComputeShader`, where the docs say the engine "is not able to automatically retrieve the binding and group values" [BJ-wgsl]
[BJ-compute]. Ceiling: `BabylonJS/Extensions` (contributing.md points there; it prunes projects untouched for 2 years) plus the
standing invitation to contribute WGSL support for NME `CustomBlock`, which today emits a single `code` body with no
`ShaderLanguage` branch [BJ-contrib] [BJ-block].

### 3.6 CesiumJS — highest map reach, no migration, ship the adapter anyway

`CustomShader` is `@experimental` and explicitly outside the deprecation policy, and a monthly release has already broken user
shaders (1.139 stopped casting UINT metadata to signed ints) [CJ-cs] [CJ-chg]. Cesium already owns the binding boilerplate
(`shaderBuilder.addUniform` + `combine(…uniformMap)`), so the adapter sells **types**, a **fail-closed capability gate**, and
**one body across three dialects** (`CustomShader`, `PostProcessStage`, Fabric) — not "we removed your binding code"
[CJ-pipeline]. The capability surface is **17** `UniformType`s, not 16: `SAMPLER_CUBE` ships in both `UniformType.js` and the
published `index.d.ts`, yet it is the only member with no JSDoc and has no row in the CustomShaderGuide table — model it as
shipped-but-undocumented rather than rejecting it [CJ-ut] [CJ-guide]. Two research claims corrected: the plugin registry does
not exist (cesiumjs.org/plugins redirects to the marketing homepage, cesium.com/plugins 404s, and `kring/cesium-plugins-list` —
first-party tooling, initial commit by the AnalyticalGraphics account — last committed 2014-01-14) [CJ-plugins]; and WGSL
**can** express `inout czm_modelMaterial`, as `ptr<function, czm_modelMaterial>` — the obstacle is that only Cesium can define
and publish the contract, not that WGSL lacks the construct [S23]. Fabric's own wording is "Uniform arrays are not supported
yet, **but are on the roadmap**" — quote the clause, or a roadmapped gap reads as a permanent one [CJ-fabric].

## 4. Ranking and sequencing

**Weighting** (pain today ×2, migration imminence, reach, governance openness, map-domain fit):

1. **PixiJS** — the only host where the tax is being paid today, in counted lines, by decision rather than by transition; and
   the cheapest high-reach rung in the whole programme (a docs PR into an Agent Skill that ships inside the npm tarball). Ship
   first.
2. **MapLibre GL JS** — best domain fit (X-GIS already implements the globe/mercator variant problem the adapter must solve) and
   the **only** host with a publicly tracked migration to be forward-compatible with. It carries the strategy's narrative even
   though it ships second.
3. **deck.gl / luma.gl** — sharpest measured defect, a `ShaderModule` shaped exactly like our output, an OpenJS TSC that says it
   is short of maintainers, and a genuinely open build-time rung.

three.js (reach, but TSL is a free first-party incumbent closing the gap), Babylon (migration over, editors compete) and Cesium
(no migration, boilerplate already solved) come after, and Cesium only as an independent adapter.

**Definition of done, per adapter.** (a) Published, MIT, zero runtime deps, peer-ranged, build-time-first. (b) Conformance
matrix green across every published host version in the supported range, with the host-source drift gate reading the registry
tarball. (c) One example that runs the SAME module on both of that host's shader targets (or, where the host has one, on both
projection variants), with the frames compared. (d) A README that states which side owns the uniform bytes, which host versions
are gated, and what the promise does not cover. (e) One measured artifact the host's own maintainers can check — for Pixi the
bulge-pinch divergence run through the oracle; for MapLibre the prelude drift gate; for deck.gl the three-way struct divergence
with a counter per branch.

**The upstreaming ladder, and the cost of each rung.**

| Rung | What | Decider | Cost | Where it is reachable |
| --- | --- | --- | --- | --- |
| 0 | Independent adapter + demo | us | days, then one release per host minor forever | everywhere |
| 1 | The checkable artifact (matrix + oracle report) | us | one CI shard per host | everywhere |
| 2 | The host's own channel (forum / Slack / Discussions) | whoever replies | hours; needs rung 1 first | everywhere |
| 3 | Docs listing / **agent skill** / ecosystem page | host doc maintainers, by PR | one PR + review latency | Pixi (skill, highest value), MapLibre, deck.gl, Babylon (`Extensions`); **not** Cesium (no registry) |
| 4 | An official example in the host repo | host owner/TSC | weeks; CLA where required (Cesium) | MapLibre (`test/examples/`), three (`examples/`), Pixi, deck.gl, Cesium (Sandcastle) |
| 5 | **Build-time codegen of the host's OWN shaders** (devDependency) | host TSC/owner | months + a relationship | MapLibre (`generate-shaders.ts`), deck.gl (the `.wgsl.ts`/`.glsl.ts`/`uniforms.ts` triple), pixi-filters |
| 6 | Runtime dependency | host owner | — | **closed**: three.js and Babylon ship zero deps at every tag; Pixi forks-and-freezes (`@pixi/colord`); MapLibre inlines (`whoots-js`) and forks (`@maplibre/geojson-vt`) |

Rung 5 is worth more than rung 6 for the stated goal: it already makes the host's shaders *derive* from TypeShade, so the host
has a reason to care that TypeShade keeps working, without asking anyone to put an unproven package in millions of weekly
runtime installs.

## 5. What the promise must NOT claim yet

- **Not "zero changes".** The promise covers the shader SOURCE; the adapter absorbs the host binding. Someone will diff it.
- **Not "survive the WebGPU migration" at every host.** PixiJS chose dual permanently; Babylon migrated in 2022; Cesium has no
  migration at all. Saying it there reads as not having read their docs and damages the claim where it IS true (MapLibre,
  deck.gl).
- **Not a MapLibre WebGPU custom-layer API.** None exists, none is designed, none is tracked; `CustomRenderMethod` is hard-typed
  `(gl: WebGL2RenderingContext, …)` and the one WebGPU prototype put custom layers explicitly out of scope. The wording must be:
  *on the day that contract exists, the WGSL is already emitted, already Tint-compiled in CI, and already proven equal to the
  GLSL by a CPU f64 oracle — the work left is ours, in the adapter, not yours, in the shader.*
- **Not pixel identity.** Hosts own lighting, tone mapping, colour space and entry wrappers and change them. The oracle proves
  OUR two emissions agree with each other.
- **Not feature parity across backends.** Workgroup memory, atomics and barriers have no WebGL2 preimage; Cesium's
  `CustomShader` has no compute at all; Babylon's `ComputeShader` is WebGPU-only.
- **Not from an unfrozen API.** TypeShade is `0.0.1`, unpublished, with two BREAKING changelog entries in 2026-09 alone. Date
  the promise from the `0.1.0` tag and the `api-surface.test.ts` freeze — pitching forward compatibility to PixiJS, whose
  relevant API has been additively stable for 2.5 years, inverts the argument.
- **Not a measured pixel claim we have not measured.** Every divergence in §3 was established by reading two source files
  against the specs. Run the oracle before any of it reaches an issue, a PR body or a landing page (CLAUDE.md §12: a cause read
  off a condition is worth less than one counter).

## 6. Leading indicators and thresholds

| Indicator | Why it is the right instrument | Threshold that means "working" |
| --- | --- | --- |
| Adapter downloads ÷ host core downloads | absolute counts flatter a 14M/wk host and flatter nothing at 920k | ≥ 0.1% of the host's core within 6 months of publish (resium/`@cesium/engine` runs ~10.8%; `three-custom-shader-material`/`three` ~0.3%) |
| Adapter downloads ÷ `typeshade` core downloads | tells whether adapters are the front door or an afterthought | any adapter > core means the ingredient strategy, not the compiler, is the entry point — the intended outcome |
| Host-docs / agent-skill listing | a line inside the host's own tarball or docs reaches users with no traffic of ours | ≥ 1 landed by month 6 (Pixi skill is the cheapest); ≥ 3 hosts by month 18 |
| Issues opened by **host users**, not by us | the single cleanest proof the reason-to-exist has moved off X-GIS | ≥ 5 non-authored issues per adapter per quarter |
| Host-version matrix green streak | converts the promise into a dated measurement | ≥ 10 consecutive host releases green with **no adapter code change**; any red must be fixed within one host release |
| Inbound reference by a host maintainer | rung 2→3 has actually happened | ≥ 1 per host before attempting rung 4 |
| Rung-5 conversations open | the only indicator that predicts survival rather than usage | ≥ 1 by month 18 |

A failing gate is also an indicator: an adapter that lags a host release is worse than no adapter, because it publicly falsifies
the promise. Treat "adapter red for two consecutive host releases" as a decision point to archive that adapter, not to apologise
for it.

## 7. Risks and defenses

| Risk | Evidence | Defense |
| --- | --- | --- |
| **Host API churn** | MapLibre ships every ~5–6 days and changed a custom-layer semantic in a **patch** (6.4.1); Pixi lands narrow breaking changes in minors; three's TSL vocabulary renamed in r173/r179/r181/r183/r185; Cesium's `CustomShader` is outside the deprecation policy | Continuous drift gate against the host's **published** sources (registry tarballs, not GitHub tags); per-major dialect tables; never a hand-kept reserved-name list |
| **The host ships its own DSL** | three.js TSL (first-party, free, and r184's `setNodesHandler` closes the remaining gap); luma's `generateShaderForModule` already emits both languages; Pixi's `high-shader`; Babylon's NME/Smart Filters; Cesium's `demodernizeShader` | Do not fight on "one source, two backends" — that is theirs. Lead with portability OUT of the host, typed signatures, and the CPU oracle, which none of them has |
| **A host adds a WGSL→GLSL transpiler** | the obvious alternative a reviewer will raise; Babylon already loads twgsl on demand | Same answer: types, `reflect()`-derived layouts, and a proof of agreement are what a transpiler does not give |
| **Maintenance scales hosts × versions** | 6 hosts × 2–52 releases/yr, for one maintainer | Ship 3, not 6. One shared conformance harness. Publish the supported range and archive rather than lag (§6) |
| **The adapters invert the dependency** | rungs 0–4 make TypeShade depend on the hosts' trains while they depend on nothing of ours | Only rungs 5–6 create the reciprocal edge; treat rungs 0–4 as the evidence that buys a rung-5 conversation, and price the outcome "a well-maintained adapter with modest usage" as the base case |
| **Single-host concentration** | reproducing the X-GIS problem under a new name | earcut is the model: small, correct, depended on by MANY renderers. Never a flagship adapter |
| **Bus factor is the question that gets asked** | deck.gl-community exists *because* add-ons outlive their authors; Cesium and Babylon both prune stale third-party projects | Answer it before it is asked: a published cadence commitment, adapters in the product org (not a personal account), and the matrix history as the track record |
| **License** | BSD-3 (MapLibre), MIT (three, Pixi, deck/luma, Cesium's `@cesium/wasm-splats` chain), Apache-2.0 (Cesium, Babylon) — all permissive; MIT adapters raise no question. Cesium in-repo contributions require a CLA assigning broad rights to Cesium GS / Bentley | Adapters stay MIT and outside host repos by default; treat the Cesium CLA as a deliberate decision, not a side effect of a demo |
| **Trademark** | the host names are marks we do not own; TypeShade's own mark is the one non-copyable asset (strategy §4) | `@typeshade/<host>` is our namespace; every README carries "not affiliated with or endorsed by <host>"; file the TypeShade mark before the launch post |

## 8. Sources

All fetched **2026-09-07**.

**Strategy literature.** [S1] link.springer.com/book/10.1007/978-3-642-04214-0 · [S2] intel.com/content/www/us/en/history/virtual-vault/articles/end-user-marketing-intel-inside.html · [S3] hbr.org/1995/07/the-right-game-use-game-theory-to-shape-strategy · [S4] sloanreview.mit.edu/article/how-companies-become-platform-leaders/ · [S5] hbr.org/2004/03/strategy-as-ecology · [S6] papers.ssrn.com/sol3/papers.cfm?abstract_id=1496336 · [S7] github.com/mapbox/earcut · [S8] blog.npmjs.org/post/141577284765/kik-left-pad-and-npm · [S9] openwall.com/lists/oss-security/2024/03/29/4 · [S10] github.com/ossf/criticality_score · [S11] linuxfoundation.org/research/census-ii-of-free-and-open-source-software-application-libraries · [S12] books.google.com/books/about/Information_Rules.html?id=z0hQ12PrERMC · [S13] hbr.org/1995/05/the-options-approach-to-capital-investment · [S14] learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer · [S15] alistair.cockburn.us/hexagonal-architecture/ · [S16] go.dev/doc/go1compat · [S17] doc.rust-lang.org/edition-guide/editions/index.html · [S18] bazel.build/release/backward-compatibility · [S19] testcontainers.com/modules/ · [S20] docs.sentry.io/platforms/javascript/configuration/integrations/ · [S21] opentelemetry.io/docs/concepts/instrumentation/libraries/ · [S22] github.com/open-telemetry/opentelemetry-js-contrib · [S23] w3.org/TR/WGSL/#function-declaration-sec (pointer parameters in the function address space). All `https://`.

**MapLibre GL JS** — `https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/` + [ML-custom] `src/style/style_layer/custom_style_layer.ts` · [ML-globe] `src/shaders/glsl/_projection_globe.vertex.glsl` · [ML-merc] `src/shaders/glsl/_projection_mercator.vertex.glsl` · [ML-draw] `src/webgl/draw/draw_custom.ts` · [ML-map] `src/ui/map.ts` · [ML-gen] `build/generate-shaders.ts` · [ML-chg] `CHANGELOG.md` · [ML-pkg] `package.json` + https://registry.npmjs.org/maplibre-gl (the tarball ships `src/`). Also [ML-roadmap] https://maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/ · [ML-7640] https://github.com/maplibre/maplibre-gl-js/issues/7640 · [ML-2606] `/issues/2606` · [ML-8290] `/pull/8290` · [ML-8262] `/issues/8262` · [ML-7411] `/pull/7411` · [ML-charter] https://raw.githubusercontent.com/maplibre/maplibre/main/CHARTER.md · [ML-sponsors] https://maplibre.org/sponsors/ · [ML-native] https://maplibre.org/roadmap/maplibre-native/webgpu/

**PixiJS** — `https://raw.githubusercontent.com/pixijs/pixijs/dev/` + [PX-shader] `src/rendering/renderers/shared/shader/Shader.ts` · [PX-gpuprog] `src/rendering/renderers/gpu/shader/GpuProgram.ts` · [PX-filter] `src/filters/Filter.ts` · [PX-mesh] `src/scene/mesh/gpu/GpuMeshAdapter.ts` · [PX-skill] `skills/pixijs-custom-rendering/SKILL.md` · [PX-pkg] `package.json` · [PX-auto] `src/rendering/renderers/autoDetectRenderer.ts`. Also [PX-attr] https://github.com/pixijs/pixijs/issues/11819 · [PX-12143] `/pull/12143` · [PX-820] `/releases/tag/v8.20.0` · [PX-team] https://pixijs.com/team + https://github.com/pixijs/pixijs/wiki/Core-Team · [PX-renderers] https://pixijs.com/8.x/guides/components/renderers · [PX-7833] https://github.com/pixijs/pixijs/discussions/7833 · [PX-oc] https://opencollective.com/pixijs · [PX-bulge] https://raw.githubusercontent.com/pixijs/filters/main/src/bulge-pinch/bulge-pinch.{frag,wgsl} · [PX-filters] [PX-ex] [PX-diff] local measurement on shallow clones pixijs/pixijs @ e3a29ef and pixijs/filters @ e9d1ca9 (v6.1.5), plus tag diffs against `https://raw.githubusercontent.com/pixijs/pixijs/v8.0.0/…`

**deck.gl / luma.gl** — [DG-mod] `…/visgl/luma.gl/master/modules/shadertools/src/lib/shader-module/shader-module.ts` · [DG-val] same dir `/shader-module-uniform-layout.ts` · [DG-gen] `…/shadertools/src/lib/shader-generator/generate-shader.ts` · [DG-scan] `…/shadertools/src/lib/shader-assembly/wgsl-interface-scan.ts` · [DG-layer] `…/visgl/deck.gl/master/modules/core/src/lib/layer.ts` · [DG-uni] `…/deck.gl/master/modules/layers/src/scatterplot-layer/scatterplot-layer-uniforms.ts` · [DG-wgsl] same dir `/scatterplot-layer.wgsl.ts` · [DG-webgpu] `…/deck.gl/master/docs/developer-guide/webgpu.md` · [DG-new] `…/docs/whats-new.md` (all on `https://raw.githubusercontent.com/`). Also [DG-10270] https://github.com/visgl/deck.gl/issues/10270 · [DG-93] [DG-94] [DG-model] [DG-npm] https://data.jsdelivr.com/v1/packages/npm/@luma.gl/shadertools@{9.2.0,9.3.0,9.4.0} + https://registry.npmjs.org/{deck.gl,@luma.gl/core,@luma.gl/engine} · [DG-tsc] https://raw.githubusercontent.com/visgl/tsc/master/{README,GOVERNANCE}.md · [DG-oj] https://openjsf.org/projects

**three.js** — `https://raw.githubusercontent.com/mrdoob/three.js/r185/` + [TJ-fn] `src/nodes/code/FunctionNode.js` · [TJ-ex] `examples/webgpu_tsl_interoperability.html` · [TJ-files] `examples/files.json` (category key `webgpu (wip)` at r168–r185) · [TJ-renderer] `src/renderers/common/Renderer.js` · [TJ-transp] `examples/jsm/transpiler/` · [TJ-pkg] the same `package.json` at r100/r120/r150/r163/r167/r171/r180/r185. Also [TJ-mig] https://raw.githubusercontent.com/wiki/mrdoob/three.js/Migration-Guide.md · [TJ-owners] `…/wiki/mrdoob/three.js/Owners.md` · [TJ-manual] https://threejs.org/manual/#en/webgpurenderer · [TJ-r184] https://github.com/mrdoob/three.js/releases/tag/r184 with dates taken from https://registry.npmjs.org/three · [TJ-29781] https://github.com/mrdoob/three.js/issues/29781

**Babylon.js** — `https://raw.githubusercontent.com/BabylonJS/Documentation/master/content/` + [BJ-webgpu] `setup/support/webGPU.md` · [BJ-status] `setup/support/webGPU/webGPUStatus.md` · [BJ-wgsl] `setup/support/webGPU/webGPUWGSL.md` · [BJ-compute] `features/featuresDeepDive/materials/shaders/computeShader.md` · [BJ-plugin] `features/featuresDeepDive/materials/using/materialPlugins.md` · [BJ-break] `breaking-changes.md`. And `https://raw.githubusercontent.com/BabylonJS/Babylon.js/master/packages/dev/core/src/` + [BJ-base] `Materials/materialPluginBase.pure.ts` · [BJ-proc] `Engines/Processors/shaderProcessor.ts` + `Engines/thinEngine.functions.ts` · [BJ-block] `Materials/Node/Blocks/customBlock.pure.ts`. Also [BJ-contrib] `…/Babylon.js/master/contributing.md` + `…/BabylonJS/Extensions/master/readme.md` · [BJ-80] https://blogs.windows.com/windowsdeveloper/2025/03/27/announcing-babylon-js-8-0/ · [BJ-90] `…/2026/03/26/announcing-babylon-js-9-0/`

**CesiumJS** — `https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/` + [CJ-cs] `Scene/Model/CustomShader.js` · [CJ-ut] `Scene/Model/UniformType.js` (+ https://unpkg.com/@cesium/engine@26.3.0/index.d.ts) · [CJ-pipeline] `Scene/Model/CustomShaderPipelineStage.js` · [CJ-demod] `Renderer/demodernizeShader.js`. Also [CJ-chg] `…/cesium/main/CHANGES.md` · [CJ-contrib] `…/cesium/main/CONTRIBUTING.md` · [CJ-guide] https://github.com/CesiumGS/cesium/blob/main/Documentation/CustomShaderGuide/README.md · [CJ-4989] https://github.com/CesiumGS/cesium/issues/4989 · [CJ-fabric] https://github.com/CesiumGS/cesium/wiki/Fabric · [CJ-roadmap] https://cesium.com/blog/2025/06/23/cesium-roadmap-for-bridging-the-built-and-natural-environment/ · [CJ-bentley] https://cesium.com/blog/2024/09/06/cesium-joins-bentley/ · [CJ-plugins] https://github.com/kring/cesium-plugins-list + https://cesiumjs.org/plugins/ (redirects to the marketing homepage) + https://cesium.com/plugins/ (404)

**Local (not host sources).** `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` §0–§4, §6.2, §8 · `docs/plans/2026-09-01-shader-dsl-improvement-direction.md` §0, §5 · `shader-dsl/src/core/reflect.ts` · the site brief at `docs/design/00-brief.md`.

**Instrument limits recorded during research.** The GitHub REST API was blocked for several sessions (403 "GitHub access to this repository is not enabled"), so issue/PR bodies came from HTML and file contents from `raw.githubusercontent.com` or shallow clones; two metadata sub-claims (#4989's last-activity date, MapLibre #797's age) were dropped as unverifiable rather than passed through.
