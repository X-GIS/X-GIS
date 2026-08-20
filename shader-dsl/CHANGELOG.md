<!--
  GENERATED FILE — do not hand-edit; every edit is lost on the next run.
  Rendered from git history by scripts/emit-changelog.ts.

  Regenerate (both steps — the generator emits prettier-clean markdown,
  and the pair is idempotent):
    bun scripts/emit-changelog.ts --path shader-dsl > shader-dsl/CHANGELOG.md
    bunx prettier --write shader-dsl/CHANGELOG.md

  Generated from: 7959f837eb75896ba396116fa24270e317df99ad
  History walked: first-parent of main
  Scope: commits touching shader-dsl/
  Repository: https://github.com/X-GIS/X-GIS
  What changed since this file was generated (run from a repo checkout):
    bun scripts/emit-changelog.ts --path shader-dsl --since 7959f837eb75
-->

# Changelog — shader-dsl

This repo ships no versioned releases and carries no git tags, so changes are grouped by month rather than by version. Each entry is one squash-merged commit on `main`; the short hash is the point in history it landed at.

_Entries are the commits touching `shader-dsl/`; a listed commit may also touch other packages._

### 2026-08

#### feat

- **shader-dsl:** reflect() publishes entry IO locations and per-binding stages ([#1909](https://github.com/X-GIS/X-GIS/pull/1909)) `c1cbcc5`
- **ci,shader-dsl:** land the changelog regeneration through a PR, and gate the public API surface (#1842) ([#1843](https://github.com/X-GIS/X-GIS/pull/1843)) `e874bf0`
- **rhi-webgl2:** dispatch compute by the portable declaration, not the deprecated flag ([#1824](https://github.com/X-GIS/X-GIS/pull/1824)) `35adaa2`
- **shader-dsl:** hyperbolic/saturate/2x16-pack builtins, backend-asymmetry hardening, the portable kernel tier ([#1805](https://github.com/X-GIS/X-GIS/pull/1805)) `672a55a`
- **shader-dsl:** classify declared production transforms in semanticDiff (#1806) ([#1807](https://github.com/X-GIS/X-GIS/pull/1807)) `00b8001`
- **shader-dsl:** validateVariantsWgsl — lift #1738's WGSL validation into the package (#1715) ([#1741](https://github.com/X-GIS/X-GIS/pull/1741)) `7c8dc6a`
- **shader-dsl:** emitGuardedFragment — the generated ladder, composable into a host program (#1712) ([#1731](https://github.com/X-GIS/X-GIS/pull/1731)) `8aaf90b`
- **shader-dsl:** the host boundary — emitFragment, externVar, hostUniform, variantFamily, buildRegistry, capabilityMatrix (#1710-#1713, #1716, #1717) ([#1721](https://github.com/X-GIS/X-GIS/pull/1721)) `a152943`
- **shader-dsl:** semanticDiff over IR + reflection, and the two render gates that had never run (#1714, #1715) ([#1719](https://github.com/X-GIS/X-GIS/pull/1719)) `08423be`
- **scripts,ci:** regenerate the changelogs on every merge, guard the shallow-clone footgun, and fix three render defects ([#1709](https://github.com/X-GIS/X-GIS/pull/1709)) `164c65d`
- **shader-dsl:** integer sampled textures (u32/i32 × 2d/2d-array) and the array&lt;u32&gt; storage lowering (#1703) ([#1705](https://github.com/X-GIS/X-GIS/pull/1705)) `9f5a8f9`
- **shader-dsl:** production shader emit — token-level minify, short identifiers, type aliases, minimal parens, prototype pruning, and a log decoder ([#1684](https://github.com/X-GIS/X-GIS/pull/1684)) `fffd79f`
- **map,shader-dsl:** baked-shader store with family-derived download groups, and a shader-dsl that compiles standalone (#1679, #1681) `483a30b`
- **shader-dsl:** WebGL2 extension profile surface — capProfile single authority, #extension emission, reflect().requiredFeatures (#1670) ([#1677](https://github.com/X-GIS/X-GIS/pull/1677)) `13394b7`
- **shader-dsl:** paired per-target raw statements — rawGlsl joins rawWgsl, fail-closed on the missing side (#1671) ([#1676](https://github.com/X-GIS/X-GIS/pull/1676)) `9b8253b`
- **shader-dsl:** GlslEmitOptions.floatPrecision — a build-time mediump knob for the GLSL float precision line (#1673) ([#1675](https://github.com/X-GIS/X-GIS/pull/1675)) `4d6a7b2`
- **shader-dsl:** absent WGSL builtins fail closed at emit — point_size, point_coord, frag_coord (#1672) ([#1674](https://github.com/X-GIS/X-GIS/pull/1674)) `4677149`
- **shader-dsl:** textureNumLayers — query the layer count of a 2d-array texture (#1658) ([#1662](https://github.com/X-GIS/X-GIS/pull/1662)) `3a2b79e`
- **shader-dsl:** derivative builtins join the fragment-only lint; SD0109 catalogue hint goes generic (#1654) ([#1660](https://github.com/X-GIS/X-GIS/pull/1660)) `bcfa81c`
- **shader-dsl:** texture_2d_array\<f32\> end-to-end (#1651) ([#1657](https://github.com/X-GIS/X-GIS/pull/1657)) `b84d4c2`
- **scripts:** generated changelog from the conventional-commit history (#1653) ([#1656](https://github.com/X-GIS/X-GIS/pull/1656)) `fe3df48`
- **shader-dsl:** textureSampleLevel + fragment-only lint for textureSample (#1650) ([#1652](https://github.com/X-GIS/X-GIS/pull/1652)) `4bf4610`
- **shader-dsl:** GLSL storage→data-texture emulation is default-on (#1647) ([#1648](https://github.com/X-GIS/X-GIS/pull/1648)) `a5eeaf9`

#### fix

- **shader-dsl:** carry the df64 opacity invariant on the DECL, not on its name (#1926) ([#1927](https://github.com/X-GIS/X-GIS/pull/1927)) `7959f83`
- **shader-dsl:** restore the GLSL entry work #1864 landed only the test files of ([#1858](https://github.com/X-GIS/X-GIS/pull/1858)) `0f0358d`
- **shader-dsl:** make main() the GLSL entry, in dependency order, with no IO struct ([#1858](https://github.com/X-GIS/X-GIS/pull/1858)) `a16d07f`
- **shader-dsl:** hoist discarding struct-ctor args to named GLSL locals (#1840) ([#1841](https://github.com/X-GIS/X-GIS/pull/1841)) `27e7a38`
- **shader-dsl:** explicit .js specifiers + nodenext — the package loads in plain Node (#1686) ([#1825](https://github.com/X-GIS/X-GIS/pull/1825)) `e704eaf`
- **playground:** make the e2e tsconfig typecheckable — rootDir + one window-global authority (#1683) ([#1762](https://github.com/X-GIS/X-GIS/pull/1762)) `bf04401`
- **rhi-webgl2:** storage writeBuffer drops the caller's view window — WebGL2 renders no points (#1703 regression) ([#1708](https://github.com/X-GIS/X-GIS/pull/1708)) `3b126a1`

#### perf

- **shader-dsl:** indexing a binding is a memory LOAD, not free navigation (#1886) ([#1894](https://github.com/X-GIS/X-GIS/pull/1894)) `44f893b`
- **shader-dsl:** let cse-local see an `if` condition too — −154 call sites (#1886) ([#1892](https://github.com/X-GIS/X-GIS/pull/1892)) `e33b629`
- **shader-dsl:** gvn sees `if` conditions and lets a nested block reuse an enclosing temp (#1886) ([#1887](https://github.com/X-GIS/X-GIS/pull/1887)) `5e862cd`
- **shader-dsl/glsl:** spell the storage fetch as a helper call, not an inline expansion ([#1880](https://github.com/X-GIS/X-GIS/pull/1880)) `36bfb12`
- **shader-dsl:** stop the emit recomputing hoistable values — post-inline cleanup + gvn wired (#1860, #1861, #1865) ([#1862](https://github.com/X-GIS/X-GIS/pull/1862)) `f005bbe`

#### refactor

- **shader-dsl:** remove the no-op emulateStorage flag from all consumers, tag it @deprecated (#1649) ([#1659](https://github.com/X-GIS/X-GIS/pull/1659)) `136fdef`

#### docs

- **shader-dsl:** prune()'s justification is a 9.5% figure #1858 made 0.00% (#1914) ([#1919](https://github.com/X-GIS/X-GIS/pull/1919)) `950687b`
- **shader-dsl:** note the retired frag_coord alias in the migration section (#1840) ([#1854](https://github.com/X-GIS/X-GIS/pull/1854)) `bfd997e`
- **shader-dsl:** stop transcribing signatures in AUTHORING.md and latch it (#1700) ([#1786](https://github.com/X-GIS/X-GIS/pull/1786)) `cdad8e2`
- **shader-dsl:** document the last 38 engine-internals exports — the doc-coverage allowlist reaches zero (#1695) ([#1727](https://github.com/X-GIS/X-GIS/pull/1727)) `1e394a0`
- **shader-dsl:** document the 20 ./dev diagnostic exports, and answer the policy their debt row deferred (#1695) ([#1726](https://github.com/X-GIS/X-GIS/pull/1726)) `dc02560`
- **shader-dsl,site:** document all 109 core/ir exports, and fix the API reference defects only a rendered page shows (#1695) ([#1725](https://github.com/X-GIS/X-GIS/pull/1725)) `e09a40e`
- **shader-dsl:** answer the `#define` question, replace the reference page, and make the docs pipeline self-checking (#1694, #1700, #1695) ([#1702](https://github.com/X-GIS/X-GIS/pull/1702)) `ddaa150`
- **shader-dsl:** document the eight star-re-exported backend symbols (#1697) ([#1698](https://github.com/X-GIS/X-GIS/pull/1698)) `259caf5`

#### test

- **shader-dsl:** cut the controlFlow regression axis and the lifting path in semanticDiff transforms (#1806) ([#1814](https://github.com/X-GIS/X-GIS/pull/1814)) `cbef7f4`
- **shader-dsl:** cover the mat4 host global, and correct two claims that did not match the code ([#1735](https://github.com/X-GIS/X-GIS/pull/1735)) `f91f107`
- **shader-dsl:** gate every public export on having a doc comment (#1695) ([#1696](https://github.com/X-GIS/X-GIS/pull/1696)) `3f6428e`

#### build

- **shader-dsl:** distribute via a git subtree mirror, and gate the invariant that makes it work ([#1681](https://github.com/X-GIS/X-GIS/pull/1681)) `54718a7`

#### other

- fix(ci)+feat(shader-dsl): the mirror that never ran, hostBlock, #1715's two gates, and 30 dark gates lit (#1693, #1710, #1714, #1715, #1716, #1720, #1724) ([#1723](https://github.com/X-GIS/X-GIS/pull/1723)) `b93df52`

### 2026-07

#### ⚠ BREAKING CHANGES

- **BREAKING** dissolve @xgis/runtime — @xgis/map becomes the published package ([#1343](https://github.com/X-GIS/X-GIS/pull/1343)) `176d494`

#### feat

- **shader-dsl:** df64 sin/cos transcendentals (luma.gl Taylor port) (#922) ([#961](https://github.com/X-GIS/X-GIS/pull/961)) `ee5ca97`
- **shader-dsl:** specialization constants — WGSL override ↔ GLSL #define (#923) ([#960](https://github.com/X-GIS/X-GIS/pull/960)) `f4fabb9`
- **shader-dsl:** caps-gated enable-directive language-feature knobs — f16 / subgroups (#628) ([#957](https://github.com/X-GIS/X-GIS/pull/957)) `0bc26be`
- **shader-dsl:** loop-unroll optimizer pass for small fixed-count loops (#627) ([#944](https://github.com/X-GIS/X-GIS/pull/944)) `869f856`
- **shader-dsl:** df64 flavor auto-recommendation + probe device-loss isolation ([#933](https://github.com/X-GIS/X-GIS/pull/933)) `cd1d808`
- **shader-dsl:** integer-domain df64 flavor — fast-math-immune EFT primitives ([#932](https://github.com/X-GIS/X-GIS/pull/932)) `989258e`
- **shader-dsl:** fma intrinsic + df64 Two-Product-FMA probe (Apple Metal cross-term fold) ([#924](https://github.com/X-GIS/X-GIS/pull/924)) `1cf5e56`
- **site:** fp32-threshold sweep on fp64 examples + WebGL2/WebGPU toggle + df64-multiply verdict blog ([#921](https://github.com/X-GIS/X-GIS/pull/921)) `63de9a2`
- **shader-dsl:** bitcastF32 + mul-family battery probe (Apple fast-math) ([#920](https://github.com/X-GIS/X-GIS/pull/920)) `9d58f91`
- **shader-dsl:** multi-statement inlining + emit-plugin blog + concepts/shipping site rework ([#882](https://github.com/X-GIS/X-GIS/pull/882)) `16a5bb6`
- **shader-dsl:** inline() emit plugin — call-graph flattening ([#880](https://github.com/X-GIS/X-GIS/pull/880)) `9a8b87e`
- **shader-dsl:** production emit options — { minify, mangle, renames } ([#866](https://github.com/X-GIS/X-GIS/pull/866)) `65a88d2`
- **shader-dsl:** 10 new fp64 examples — fractals, cartographic precision, cancellation ([#865](https://github.com/X-GIS/X-GIS/pull/865)) `33ad96d`
- **shader-dsl:** dynamic iteration budget for fp64 Mandelbrot; unify f32/f64 twins ([#862](https://github.com/X-GIS/X-GIS/pull/862)) `0ce0b4d`
- **shader-dsl:** vec64 componentwise builtins + fp64 example UX/stability fixes ([#855](https://github.com/X-GIS/X-GIS/pull/855)) `b553204`
- **shader-dsl:** fp64 (emulated double precision) with unchanged authoring syntax ([#850](https://github.com/X-GIS/X-GIS/pull/850)) `a71f6be`
- **shader-dsl,site:** interactive controls — transport chrome + pointer uniform ([#852](https://github.com/X-GIS/X-GIS/pull/852)) `c7c3803`
- **shader-dsl:** close out the DX retrospective — #837/#838/#841/#842/#844/#845/#846 ([#851](https://github.com/X-GIS/X-GIS/pull/851)) `abfe446`
- **shader-dsl:** portable mod() intrinsic + authoring-error context ([#849](https://github.com/X-GIS/X-GIS/pull/849)) `12bad72`
- **shader-dsl:** 10 ShaderToy-classic examples + engine README ([#836](https://github.com/X-GIS/X-GIS/pull/836)) `7be5dde`
- **shader-dsl:** #763 Phase X part 2 — the API additions (X1/X2/X3/X14) ([#771](https://github.com/X-GIS/X-GIS/pull/771)) `94ab639`
- **shader-dsl:** #740 R9 — scalar×vec broadcast + inferred, elem-typed swizzles ([#751](https://github.com/X-GIS/X-GIS/pull/751)) `be8dad1`
- **shader-dsl:** #740 R6 — struct/IO handles as fn params, .of() input re-assertions retired ([#747](https://github.com/X-GIS/X-GIS/pull/747)) `ef8e847`
- **shader-dsl:** #740 R1 migration — entries-only module assembly + name-keyed collection dedup + GLSL prototypes ([#745](https://github.com/X-GIS/X-GIS/pull/745)) `60279f2`
- **shader-dsl:** #740 R1 — module() transitive fn collection + key-named funcs ([#744](https://github.com/X-GIS/X-GIS/pull/744)) `554c09d`
- **shader-dsl:** #740 R7 — call-signature CORE lint rule + typed object-call ergonomics ([#741](https://github.com/X-GIS/X-GIS/pull/741)) `c4bd974`
- **engine:** content-blind @xgis/engine extraction — P1 + P2 + P3 Steps 1-5 ([#714](https://github.com/X-GIS/X-GIS/pull/714)) `f30653a`

#### fix

- **types:** forced-cast debt audit — remove dead casts, fix type seams, add shrink-only cast ratchet ([#1039](https://github.com/X-GIS/X-GIS/pull/1039)) `1416496`
- **shader-dsl:** renormalize df64_mul between cross terms (Apple collapse) ([#919](https://github.com/X-GIS/X-GIS/pull/919)) `9d8a26a`
- **shader-dsl:** guard df64_mul cross terms against distributive fast-math ([#917](https://github.com/X-GIS/X-GIS/pull/917)) `327caac`
- **shader-dsl:** renorm raw df64 operands across all cancelling ops (loran + audit) ([#916](https://github.com/X-GIS/X-GIS/pull/916)) `5010f01`
- **shader-dsl:** renorm raw df64 operands before sub/div (Apple collapse) ([#915](https://github.com/X-GIS/X-GIS/pull/915)) `05edc21`
- **shader-dsl:** don't inject the _fp64 guard for comparison-only df64 modules ([#904](https://github.com/X-GIS/X-GIS/pull/904)) `bd7b1b3`
- **shader-dsl:** launder df64 operands through the guard at EFT entry ([#901](https://github.com/X-GIS/X-GIS/pull/901)) `960e3c0`
- **shader-dsl:** scope per-stage GLSL emit to stage-reachable code ([#863](https://github.com/X-GIS/X-GIS/pull/863)) `b4fbb02`
- **shader-dsl,site:** texture-fetched fp64 guard — immune to driver uniform-value specialization ([#856](https://github.com/X-GIS/X-GIS/pull/856)) `8dc5937`
- **shader-dsl:** #763 Phase X part 1 — the type-surface DX sweep (12 items) ([#770](https://github.com/X-GIS/X-GIS/pull/770)) `1ccbde3`
- **shader-dsl:** #763 Phase P — optimizer/emit invariants made true ([#769](https://github.com/X-GIS/X-GIS/pull/769)) `247abcc`
- **shader-dsl:** #763 Phase D — dual-instance hardening (R1's neighbors) ([#768](https://github.com/X-GIS/X-GIS/pull/768)) `a2421fe`
- **shader-dsl:** #763 Phase O — the CPU oracle is a backend too ([#767](https://github.com/X-GIS/X-GIS/pull/767)) `1c620c4`
- **shader-dsl:** #763 Phase S — one stageOf() predicate for every stage/entry decision ([#766](https://github.com/X-GIS/X-GIS/pull/766)) `8396395`
- **shader-dsl:** #763 Phase G — readonly invariant propagation + GLSL CI gate ([#764](https://github.com/X-GIS/X-GIS/pull/764)) `a7d7bac`
- **shader-dsl:** #755 — object-form fn calls accept ReadonlyNode args ([#756](https://github.com/X-GIS/X-GIS/pull/756)) `f8a9970`

#### perf

- **map,shader-dsl,rhi:** one lowering per pipeline, a shader-language capability, and the hillshade emit off the main thread ([#1473](https://github.com/X-GIS/X-GIS/pull/1473)) `d2286c7`
- **map,shader-dsl:** cut hillshade first-draw shader cost ~3.3x, stop emitting the shader language each device discards ([#1405](https://github.com/X-GIS/X-GIS/pull/1405)) `bab5fe8`
- **shader-dsl:** bind a CSE temp where it is used, not at the function top ([#1387](https://github.com/X-GIS/X-GIS/pull/1387)) `b09e2f5`
- **shader-dsl:** make the optimizer ~7.7× cheaper on the merged multi-projection shaders ([#1186](https://github.com/X-GIS/X-GIS/pull/1186)) `0c47dfb`
- Wave 2 — shader-dsl CPU js-codegen (#1162) + tile-selection per-margin LRU (#1153) ([#1166](https://github.com/X-GIS/X-GIS/pull/1166)) `7d0f31f`

#### refactor

- **shader-dsl:** lint Wave 3 — migrate 38 no-deprecated callFn sites + engine colormap (#1055) ([#1135](https://github.com/X-GIS/X-GIS/pull/1135)) `3a8caf1`
- **shader-dsl:** production emit as Vite/Webpack-style plugins ([#877](https://github.com/X-GIS/X-GIS/pull/877)) `425a8ae`
- **shader-dsl:** shared fullscreen boilerplate + MRT gate coverage ([#848](https://github.com/X-GIS/X-GIS/pull/848)) `8070cfc`
- **shader-dsl:** #740 R6c — retire the remaining authoring-path .of() bridges ([#753](https://github.com/X-GIS/X-GIS/pull/753)) `c28eab1`
- **shader-dsl:** #740 R3 — structured IO/stage attrs; backends stop re-parsing spelling strings ([#750](https://github.com/X-GIS/X-GIS/pull/750)) `93d5eae`
- **shader-dsl:** #740 R5 — single-exit is a style rule, with a written deviation policy ([#749](https://github.com/X-GIS/X-GIS/pull/749)) `90fc6ab`
- **shader-dsl:** #740 R2b — dev tooling moves to @xgis/shader-dsl/dev ([#748](https://github.com/X-GIS/X-GIS/pull/748)) `700bb23`
- **shader-dsl:** #740 hygiene — drop 5 dead barrel exports, rename emitFuncsCsed → emitFuncs ([#742](https://github.com/X-GIS/X-GIS/pull/742)) `d69c0b1`

#### docs

- **shaders:** fix drifted struct-size comments — 256/192 → 272, reflect-derived ([#1034](https://github.com/X-GIS/X-GIS/pull/1034)) `943c0d8`
- **shader-dsl:** refresh examples + site prose to post-#740 idioms ([#754](https://github.com/X-GIS/X-GIS/pull/754)) `30bb85d`

#### test

- **shader-dsl:** lock the integer df64 flavor's pass/emit contract (#934) ([#955](https://github.com/X-GIS/X-GIS/pull/955)) `651b018`
- **shader-dsl:** seeded property-based df64 tests under real f32 rounding ([#909](https://github.com/X-GIS/X-GIS/pull/909)) `113500e`
- **shader-dsl:** #763 Phase V — verification fabric (V1-V6) + S4 stray site ([#772](https://github.com/X-GIS/X-GIS/pull/772)) `5aeb808`

#### chore

- **lint,format:** re-run the mechanical burn-down on current main (#1055) ([#1217](https://github.com/X-GIS/X-GIS/pull/1217)) `3ca6d28`

#### style

- adopt repo-wide Prettier baseline (prettier --write .) ([#812](https://github.com/X-GIS/X-GIS/pull/812)) `c780a4b`

#### revert

- Revert "fix(shader-dsl): guard df64_mul cross terms against distributive fast-math" ([#918](https://github.com/X-GIS/X-GIS/pull/918)) `bfab842`

#### other

- fp64 probe: revert launder regression + probe UI redesign ([#905](https://github.com/X-GIS/X-GIS/pull/905)) `a57ac1b`
- shader-dsl: df64 GPU conformance probe + emulated-double matrices ([#897](https://github.com/X-GIS/X-GIS/pull/897)) `f08ec18`
- docs+refactor(shader-dsl): #763 Phases A+H — arch erosion + doc/comment truth ([#773](https://github.com/X-GIS/X-GIS/pull/773)) `7611d1d`

<details>
<summary>1 pre-squash merge commit</summary>

- Merge pull request #831 from X-GIS/claude/gpu-webgl2-container-ovacvb ([#831](https://github.com/X-GIS/X-GIS/pull/831)) `fe178fc`

</details>

### 2026-06

#### feat

- **shader-dsl:** cross-statement GVN pass (#627) ([#698](https://github.com/X-GIS/X-GIS/pull/698)) `f3b45b0`
- **shader-dsl:** run the full optimizer pipeline on the emit path `05cdf62`
- **shader-dsl:** gate optimize() on a real GPU + fix cse double-apply name collision `4551efa`
- **shader-dsl:** add const/copy propagation, dead-branch elim, constexpr control folding `fe7fcf1`
- **shader-dsl:** GLSL std140 UBO + entry-IO lowering — reflection-fed multi-target (Phase 4) `2e0021b`
- **shader-dsl:** fn() return-type inference — drop the explicit ret token from 89 call sites ([#556](https://github.com/X-GIS/X-GIS/pull/556)) `43527f4`

#### fix

- **shader-dsl:** dev/CI resolution via ./src; dist entry moved to publishConfig `8eaab23`

#### refactor

- **shader-dsl:** drop the unused _b builder param from 18 fn bodies ([#557](https://github.com/X-GIS/X-GIS/pull/557)) `d6820df`
- **shader-dsl:** one neutral emit walk; backends delegate only divergent fragments ([#491](https://github.com/X-GIS/X-GIS/pull/491)) `5b598a5`
- **shader-dsl:** extract into standalone @xgis/shader-dsl workspace package (PR-C) ([#489](https://github.com/X-GIS/X-GIS/pull/489)) `af7c4f8`

#### docs

- 전체 문서 현행화 (7-workspace 구조 반영) ([#654](https://github.com/X-GIS/X-GIS/pull/654)) `a3defc0`

#### other

- GPU-free fixes: compute-gen LUT -1 sentinel (#632) + shader-dsl optimizer passes (#627) ([#685](https://github.com/X-GIS/X-GIS/pull/685)) `1cde78c`
- shader-dsl: diagnostics / error-DX overhaul ([#656](https://github.com/X-GIS/X-GIS/pull/656)) `8e4d3ed`
- shader-dsl: make mutation a type-level capability (ReadonlyNode vs Node) ([#661](https://github.com/X-GIS/X-GIS/pull/661)) `f4c4932`
- shader-dsl: agreement-surface guards + unify condition-dispatch into `when` ([#674](https://github.com/X-GIS/X-GIS/pull/674)) `71ad6f7`
- shader-dsl: exhaustive integer dispatch (enumU32 + matchEnum) ([#666](https://github.com/X-GIS/X-GIS/pull/666)) `67f0d17`
- shader-dsl: first-class validated module composition (composeModule) ([#668](https://github.com/X-GIS/X-GIS/pull/668)) `a23565d`
- shader-dsl: first-class non-scalar module constants ([#652](https://github.com/X-GIS/X-GIS/pull/652)) `8f8a3fc`
- Merge Phase 2: standalone-product (dist wiring + clean rebuild + README + examples + LICENSE) `ff013f2`
- Merge Phase 1: emitModuleWithReflection (byte-identical) — verified tsc 0, suite 0-fail, snapshots untouched `97da4ba`
- shader-dsl backend-agnostic: architecture design + S0 (writer/pass/oracle separation) ([#490](https://github.com/X-GIS/X-GIS/pull/490)) `ba51669`

<details>
<summary>84 pre-squash merge commits</summary>

- Merge pull request #630 from X-GIS/feat/shader-dsl-opt-levels-measure ([#630](https://github.com/X-GIS/X-GIS/pull/630)) `fb9a44c`
- Merge pull request #623 from X-GIS/feat/shader-dsl-more-examples ([#623](https://github.com/X-GIS/X-GIS/pull/623)) `9ff164e`
- Merge pull request #624 from X-GIS/feat/shader-dsl-local-cse ([#624](https://github.com/X-GIS/X-GIS/pull/624)) `29fff22`
- Merge pull request #622 from X-GIS/feat/glsl-backend-optimizer ([#622](https://github.com/X-GIS/X-GIS/pull/622)) `5f6bb24`
- Merge pull request #621 from X-GIS/refactor/shader-dsl-glsl-sanitize-split ([#621](https://github.com/X-GIS/X-GIS/pull/621)) `f47c65f`
- Merge pull request #620 from X-GIS/feat/shader-dsl-stdlib-builtins ([#620](https://github.com/X-GIS/X-GIS/pull/620)) `842e46b`
- Merge pull request #589 from X-GIS/chore/shaderdsl-charter-tier0 ([#589](https://github.com/X-GIS/X-GIS/pull/589)) `dbd9f22`
- Merge pull request #581 from X-GIS/feat/rhi-render-layer ([#581](https://github.com/X-GIS/X-GIS/pull/581)) `262917b`
- Merge pull request #586 from X-GIS/fix/main-render-bugs ([#586](https://github.com/X-GIS/X-GIS/pull/586)) `b4c1183`
- Merge pull request #571 from X-GIS/claude/epic-mayer-ewb9kl ([#571](https://github.com/X-GIS/X-GIS/pull/571)) `8dfde73`
- Merge pull request #570 from X-GIS/fix/shader-dsl-glsl-bare-params ([#570](https://github.com/X-GIS/X-GIS/pull/570)) `7f1e377`
- Merge pull request #569 from X-GIS/feat/shader-dsl-dogfooding ([#569](https://github.com/X-GIS/X-GIS/pull/569)) `844731b`
- Merge pull request #568 from X-GIS/feat/shader-dsl-reflection-phase0 ([#568](https://github.com/X-GIS/X-GIS/pull/568)) `b60b898`
- Merge pull request #566 from X-GIS/refactor/shader-dsl-move-shaders-to-runtime ([#566](https://github.com/X-GIS/X-GIS/pull/566)) `b8f0d83`
- Merge pull request #565 from X-GIS/refactor/shader-dsl-emit-module-driver ([#565](https://github.com/X-GIS/X-GIS/pull/565)) `579f0e7`
- Merge pull request #564 from X-GIS/refactor/shader-dsl-undeprecate-parity-accessors ([#564](https://github.com/X-GIS/X-GIS/pull/564)) `9e78529`
- Merge pull request #561 from X-GIS/claude/practical-mendel-bbvaiv ([#561](https://github.com/X-GIS/X-GIS/pull/561)) `1cac108`
- Merge pull request #562 from X-GIS/docs/deepinit-shader-dsl-package ([#562](https://github.com/X-GIS/X-GIS/pull/562)) `b5fe3ed`
- Merge pull request #560 from X-GIS/claude/practical-mendel-bbvaiv ([#560](https://github.com/X-GIS/X-GIS/pull/560)) `6357232`
- Merge pull request #559 from X-GIS/claude/practical-mendel-bbvaiv ([#559](https://github.com/X-GIS/X-GIS/pull/559)) `c8d29ae`
- Merge pull request #558 from X-GIS/docs/shader-dsl-authoring-guide ([#558](https://github.com/X-GIS/X-GIS/pull/558)) `172760a`
- Merge pull request #555 from X-GIS/refactor/shader-dsl-callfn-handles ([#555](https://github.com/X-GIS/X-GIS/pull/555)) `b7da3a8`
- Merge pull request #554 from X-GIS/refactor/shader-dsl-const-handles ([#554](https://github.com/X-GIS/X-GIS/pull/554)) `546c9b8`
- Merge pull request #553 from X-GIS/feat/shader-dsl-radians-degrees ([#553](https://github.com/X-GIS/X-GIS/pull/553)) `4de8cef`
- Merge pull request #552 from X-GIS/feat/shader-dsl-literal-lift-w2 ([#552](https://github.com/X-GIS/X-GIS/pull/552)) `84d4752`
- Merge pull request #551 from X-GIS/refactor/shader-dsl-assign-method ([#551](https://github.com/X-GIS/X-GIS/pull/551)) `8dc3615`
- Merge pull request #550 from X-GIS/feat/shader-dsl-set-method ([#550](https://github.com/X-GIS/X-GIS/pull/550)) `f705a0b`
- Merge pull request #549 from X-GIS/feat/shader-dsl-switch-builder ([#549](https://github.com/X-GIS/X-GIS/pull/549)) `b8f978b`
- Merge pull request #548 from X-GIS/feat/shader-dsl-literal-lift ([#548](https://github.com/X-GIS/X-GIS/pull/548)) `a379be4`
- Merge pull request #547 from X-GIS/refactor/shader-dsl-infer-types ([#547](https://github.com/X-GIS/X-GIS/pull/547)) `545b6ee`
- Merge pull request #546 from X-GIS/refactor/shader-dsl-strip-names ([#546](https://github.com/X-GIS/X-GIS/pull/546)) `0efe082`
- Merge pull request #545 from X-GIS/refactor/shader-dsl-unify-fn ([#545](https://github.com/X-GIS/X-GIS/pull/545)) `1692aeb`
- Merge pull request #544 from X-GIS/refactor/shader-dsl-field-getter ([#544](https://github.com/X-GIS/X-GIS/pull/544)) `2841427`
- Merge pull request #543 from X-GIS/feat/shader-dsl-var-elimination ([#543](https://github.com/X-GIS/X-GIS/pull/543)) `36039db`
- Merge pull request #542 from X-GIS/feat/shader-dsl-fold-reduce ([#542](https://github.com/X-GIS/X-GIS/pull/542)) `a35f7a4`
- Merge pull request #541 from X-GIS/refactor/shader-dsl-sot-line-polygon ([#541](https://github.com/X-GIS/X-GIS/pull/541)) `ef03f11`
- Merge pull request #540 from X-GIS/feat/shader-dsl-auto-bind-cse ([#540](https://github.com/X-GIS/X-GIS/pull/540)) `b17cdd0`
- Merge pull request #539 from X-GIS/feat/shader-dsl-fn-optional-name-typed-resource ([#539](https://github.com/X-GIS/X-GIS/pull/539)) `06fd426`
- Merge pull request #538 from X-GIS/refactor/shader-dsl-decl-merge-rest ([#538](https://github.com/X-GIS/X-GIS/pull/538)) `40c7efc`
- Merge pull request #537 from X-GIS/refactor/shader-dsl-polygon-decl-merge ([#537](https://github.com/X-GIS/X-GIS/pull/537)) `632fed9`
- Merge pull request #536 from X-GIS/refactor/shader-dsl-projection-callfn ([#536](https://github.com/X-GIS/X-GIS/pull/536)) `c0f0026`
- Merge pull request #535 from X-GIS/feat/shader-dsl-optional-binding-names ([#535](https://github.com/X-GIS/X-GIS/pull/535)) `697c891`
- Merge pull request #534 from X-GIS/feat/shader-dsl-typed-object-param ([#534](https://github.com/X-GIS/X-GIS/pull/534)) `ed22dd6`
- Merge pull request #533 from X-GIS/refactor/shader-dsl-callfn-crossfile-stable ([#533](https://github.com/X-GIS/X-GIS/pull/533)) `7e4c43b`
- Merge pull request #532 from X-GIS/refactor/shader-dsl-callfn-direct-samefile ([#532](https://github.com/X-GIS/X-GIS/pull/532)) `5a61139`
- Merge pull request #531 from X-GIS/feat/shader-dsl-fn-callable ([#531](https://github.com/X-GIS/X-GIS/pull/531)) `ef9b817`
- Merge pull request #530 from X-GIS/refactor/shader-dsl-tsl-params-first ([#530](https://github.com/X-GIS/X-GIS/pull/530)) `e8dfd11`
- Merge pull request #529 from X-GIS/refactor/shader-dsl-c2-ambient-godfiles ([#529](https://github.com/X-GIS/X-GIS/pull/529)) `c4ad4ff`
- Merge pull request #528 from X-GIS/feat/shader-dsl-swizzle-getters ([#528](https://github.com/X-GIS/X-GIS/pull/528)) `3eea2a0`
- Merge pull request #527 from X-GIS/refactor/shader-dsl-sot-storage-bindings ([#527](https://github.com/X-GIS/X-GIS/pull/527)) `0273d62`
- Merge pull request #525 from X-GIS/fix/shader-dsl-cpu-mix-broadcast ([#525](https://github.com/X-GIS/X-GIS/pull/525)) `fe7efcf`
- Merge pull request #524 from X-GIS/feat/shader-dsl-rastercolor-absorb-cpu-fixes ([#524](https://github.com/X-GIS/X-GIS/pull/524)) `0581696`
- Merge pull request #523 from X-GIS/feat/shader-dsl-ecef-absorb ([#523](https://github.com/X-GIS/X-GIS/pull/523)) `ffa2124`
- Merge pull request #522 from X-GIS/refactor/shader-dsl-sot-godfiles ([#522](https://github.com/X-GIS/X-GIS/pull/522)) `e5c8331`
- Merge pull request #521 from X-GIS/refactor/shader-dsl-sot-rollout-small ([#521](https://github.com/X-GIS/X-GIS/pull/521)) `1755c46`
- Merge pull request #520 from X-GIS/feat/shader-dsl-sot-storagebuffer ([#520](https://github.com/X-GIS/X-GIS/pull/520)) `e564419`
- Merge pull request #519 from X-GIS/refactor/shader-dsl-sot-rollout ([#519](https://github.com/X-GIS/X-GIS/pull/519)) `cbc42c8`
- Merge pull request #518 from X-GIS/feat/shader-dsl-sot-uniformstruct ([#518](https://github.com/X-GIS/X-GIS/pull/518)) `eb49eb6`
- Merge pull request #517 from X-GIS/feat/shader-dsl-sot-iostruct ([#517](https://github.com/X-GIS/X-GIS/pull/517)) `0b81383`
- Merge pull request #516 from X-GIS/fix/shader-dsl-validate-core-rules-only ([#516](https://github.com/X-GIS/X-GIS/pull/516)) `4655ad6`
- Merge pull request #515 from X-GIS/refactor/shader-dsl-c2-rollout-shaders ([#515](https://github.com/X-GIS/X-GIS/pull/515)) `fa4283b`
- Merge pull request #514 from X-GIS/feat/shader-dsl-lint-self-assign-fix ([#514](https://github.com/X-GIS/X-GIS/pull/514)) `01974dd`
- Merge pull request #513 from X-GIS/feat/shader-dsl-lint-autofix ([#513](https://github.com/X-GIS/X-GIS/pull/513)) `1007434`
- Merge pull request #512 from X-GIS/feat/shader-dsl-lint-report-unused-deviations ([#512](https://github.com/X-GIS/X-GIS/pull/512)) `8e439eb`
- Merge pull request #511 from X-GIS/feat/shader-dsl-lint-big-shaders ([#511](https://github.com/X-GIS/X-GIS/pull/511)) `0567343`
- Merge pull request #510 from X-GIS/feat/shader-dsl-static-analysis-report ([#510](https://github.com/X-GIS/X-GIS/pull/510)) `7ad3324`
- Merge pull request #509 from X-GIS/feat/shader-dsl-lint-rules-batch ([#509](https://github.com/X-GIS/X-GIS/pull/509)) `2e8fda3`
- Merge pull request #508 from X-GIS/refactor/shader-dsl-lint-rules-per-file ([#508](https://github.com/X-GIS/X-GIS/pull/508)) `a9459f7`
- Merge pull request #507 from X-GIS/feat/shader-dsl-lint-presets-formatter ([#507](https://github.com/X-GIS/X-GIS/pull/507)) `7103081`
- Merge pull request #506 from X-GIS/feat/shader-dsl-lint-rules-options ([#506](https://github.com/X-GIS/X-GIS/pull/506)) `a0e3250`
- Merge pull request #505 from X-GIS/feat/shader-dsl-lint-engine-advanced ([#505](https://github.com/X-GIS/X-GIS/pull/505)) `532a8ce`
- Merge pull request #504 from X-GIS/feat/shader-dsl-lint-engine ([#504](https://github.com/X-GIS/X-GIS/pull/504)) `b7005aa`
- Merge pull request #503 from X-GIS/feat/shader-dsl-misra-single-exit ([#503](https://github.com/X-GIS/X-GIS/pull/503)) `b8cc07b`
- Merge pull request #502 from X-GIS/fix/shader-dsl-explicit-early-return-returnif ([#502](https://github.com/X-GIS/X-GIS/pull/502)) `8d1918e`
- Merge pull request #501 from X-GIS/feat/shader-dsl-consistent-native-return ([#501](https://github.com/X-GIS/X-GIS/pull/501)) `f00d4a3`
- Merge pull request #500 from X-GIS/refactor/shader-dsl-c2-rollout-line2 ([#500](https://github.com/X-GIS/X-GIS/pull/500)) `131bb9b`
- Merge pull request #499 from X-GIS/feat/shader-dsl-define-fn ([#499](https://github.com/X-GIS/X-GIS/pull/499)) `5a5ed8a`
- Merge pull request #498 from X-GIS/feat/shader-dsl-typed-field-accessor ([#498](https://github.com/X-GIS/X-GIS/pull/498)) `7848398`
- Merge pull request #497 from X-GIS/feat/shader-dsl-native-return ([#497](https://github.com/X-GIS/X-GIS/pull/497)) `250c4b7`
- Merge pull request #496 from X-GIS/refactor/shader-dsl-c2-rollout-line ([#496](https://github.com/X-GIS/X-GIS/pull/496)) `62ed3d1`
- Merge pull request #495 from X-GIS/feat/shader-dsl-readability-helpers-canary ([#495](https://github.com/X-GIS/X-GIS/pull/495)) `c6241ef`
- Merge pull request #494 from X-GIS/feat/shader-dsl-readability-c2-ambient-builder ([#494](https://github.com/X-GIS/X-GIS/pull/494)) `2da87dd`
- Merge pull request #493 from X-GIS/fix/shader-dsl-validate-opacity-and-gpu-verify ([#493](https://github.com/X-GIS/X-GIS/pull/493)) `8e0170e`
- Merge pull request #492 from X-GIS/feat/shader-dsl-tsl-redesign ([#492](https://github.com/X-GIS/X-GIS/pull/492)) `860c1e4`

</details>
