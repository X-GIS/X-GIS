<!--
  GENERATED FILE — do not hand-edit; every edit is lost on the next run.
  Rendered from git history by scripts/emit-changelog.ts.

  Regenerate (both steps — the generator emits prettier-clean markdown,
  and the pair is idempotent):
    bun scripts/emit-changelog.ts --path shader-dsl > shader-dsl/CHANGELOG.md
    bunx prettier --write shader-dsl/CHANGELOG.md

  Generated from: 4bf461085e22d52de4b3e924dc0371585565ad5e
  History walked: first-parent of main
  Scope: commits touching shader-dsl/
-->

# Changelog — shader-dsl

This repo ships no versioned releases and carries no git tags, so changes are grouped by month rather than by version. Each entry is one squash-merged commit on `main`; the short hash is the point in history it landed at.

### 2026-08

#### feat

- **shader-dsl:** textureSampleLevel + fragment-only lint for textureSample (#1650) ([#1652](https://github.com/X-GIS/X-GIS/pull/1652)) `4bf4610`
- **shader-dsl:** GLSL storage→data-texture emulation is default-on (#1647) ([#1648](https://github.com/X-GIS/X-GIS/pull/1648)) `a5eeaf9`

### 2026-07

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

- **BREAKING** dissolve @xgis/runtime — @xgis/map becomes the published package ([#1343](https://github.com/X-GIS/X-GIS/pull/1343)) `176d494`
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

#### other

- Revert "fix(shader-dsl): guard df64_mul cross terms against distributive fast-math" ([#918](https://github.com/X-GIS/X-GIS/pull/918)) `bfab842`
- fp64 probe: revert launder regression + probe UI redesign ([#905](https://github.com/X-GIS/X-GIS/pull/905)) `a57ac1b`
- shader-dsl: df64 GPU conformance probe + emulated-double matrices ([#897](https://github.com/X-GIS/X-GIS/pull/897)) `f08ec18`
- Merge pull request #831 from X-GIS/claude/gpu-webgl2-container-ovacvb `fe178fc`
- docs+refactor(shader-dsl): #763 Phases A+H — arch erosion + doc/comment truth ([#773](https://github.com/X-GIS/X-GIS/pull/773)) `7611d1d`

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
- Merge pull request #630 from X-GIS/feat/shader-dsl-opt-levels-measure `fb9a44c`
- Merge pull request #623 from X-GIS/feat/shader-dsl-more-examples `9ff164e`
- Merge pull request #624 from X-GIS/feat/shader-dsl-local-cse `29fff22`
- Merge pull request #622 from X-GIS/feat/glsl-backend-optimizer `5f6bb24`
- Merge pull request #621 from X-GIS/refactor/shader-dsl-glsl-sanitize-split `f47c65f`
- Merge pull request #620 from X-GIS/feat/shader-dsl-stdlib-builtins `842e46b`
- Merge pull request #589 from X-GIS/chore/shaderdsl-charter-tier0 `dbd9f22`
- Merge pull request #581 from X-GIS/feat/rhi-render-layer `262917b`
- Merge pull request #586 from X-GIS/fix/main-render-bugs `b4c1183`
- Merge pull request #571 from X-GIS/claude/epic-mayer-ewb9kl `8dfde73`
- Merge pull request #570 from X-GIS/fix/shader-dsl-glsl-bare-params `7f1e377`
- Merge pull request #569 from X-GIS/feat/shader-dsl-dogfooding `844731b`
- Merge Phase 2: standalone-product (dist wiring + clean rebuild + README + examples + LICENSE) `ff013f2`
- Merge Phase 1: emitModuleWithReflection (byte-identical) — verified tsc 0, suite 0-fail, snapshots untouched `97da4ba`
- Merge pull request #568 from X-GIS/feat/shader-dsl-reflection-phase0 `b60b898`
- Merge pull request #566 from X-GIS/refactor/shader-dsl-move-shaders-to-runtime `b8f0d83`
- Merge pull request #565 from X-GIS/refactor/shader-dsl-emit-module-driver `579f0e7`
- Merge pull request #564 from X-GIS/refactor/shader-dsl-undeprecate-parity-accessors `9e78529`
- Merge pull request #561 from X-GIS/claude/practical-mendel-bbvaiv `1cac108`
- Merge pull request #562 from X-GIS/docs/deepinit-shader-dsl-package `b5fe3ed`
- Merge pull request #560 from X-GIS/claude/practical-mendel-bbvaiv `6357232`
- Merge pull request #559 from X-GIS/claude/practical-mendel-bbvaiv `c8d29ae`
- Merge pull request #558 from X-GIS/docs/shader-dsl-authoring-guide `172760a`
- Merge pull request #555 from X-GIS/refactor/shader-dsl-callfn-handles `b7da3a8`
- Merge pull request #554 from X-GIS/refactor/shader-dsl-const-handles `546c9b8`
- Merge pull request #553 from X-GIS/feat/shader-dsl-radians-degrees `4de8cef`
- Merge pull request #552 from X-GIS/feat/shader-dsl-literal-lift-w2 `84d4752`
- Merge pull request #551 from X-GIS/refactor/shader-dsl-assign-method `8dc3615`
- Merge pull request #550 from X-GIS/feat/shader-dsl-set-method `f705a0b`
- Merge pull request #549 from X-GIS/feat/shader-dsl-switch-builder `b8f978b`
- Merge pull request #548 from X-GIS/feat/shader-dsl-literal-lift `a379be4`
- Merge pull request #547 from X-GIS/refactor/shader-dsl-infer-types `545b6ee`
- Merge pull request #546 from X-GIS/refactor/shader-dsl-strip-names `0efe082`
- Merge pull request #545 from X-GIS/refactor/shader-dsl-unify-fn `1692aeb`
- Merge pull request #544 from X-GIS/refactor/shader-dsl-field-getter `2841427`
- Merge pull request #543 from X-GIS/feat/shader-dsl-var-elimination `36039db`
- Merge pull request #542 from X-GIS/feat/shader-dsl-fold-reduce `a35f7a4`
- Merge pull request #541 from X-GIS/refactor/shader-dsl-sot-line-polygon `ef03f11`
- Merge pull request #540 from X-GIS/feat/shader-dsl-auto-bind-cse `b17cdd0`
- Merge pull request #539 from X-GIS/feat/shader-dsl-fn-optional-name-typed-resource `06fd426`
- Merge pull request #538 from X-GIS/refactor/shader-dsl-decl-merge-rest `40c7efc`
- Merge pull request #537 from X-GIS/refactor/shader-dsl-polygon-decl-merge `632fed9`
- Merge pull request #536 from X-GIS/refactor/shader-dsl-projection-callfn `c0f0026`
- Merge pull request #535 from X-GIS/feat/shader-dsl-optional-binding-names `697c891`
- Merge pull request #534 from X-GIS/feat/shader-dsl-typed-object-param `ed22dd6`
- Merge pull request #533 from X-GIS/refactor/shader-dsl-callfn-crossfile-stable `7e4c43b`
- Merge pull request #532 from X-GIS/refactor/shader-dsl-callfn-direct-samefile `5a61139`
- Merge pull request #531 from X-GIS/feat/shader-dsl-fn-callable `ef9b817`
- Merge pull request #530 from X-GIS/refactor/shader-dsl-tsl-params-first `e8dfd11`
- Merge pull request #529 from X-GIS/refactor/shader-dsl-c2-ambient-godfiles `c4ad4ff`
- Merge pull request #528 from X-GIS/feat/shader-dsl-swizzle-getters `3eea2a0`
- Merge pull request #527 from X-GIS/refactor/shader-dsl-sot-storage-bindings `0273d62`
- Merge pull request #525 from X-GIS/fix/shader-dsl-cpu-mix-broadcast `fe7efcf`
- Merge pull request #524 from X-GIS/feat/shader-dsl-rastercolor-absorb-cpu-fixes `0581696`
- Merge pull request #523 from X-GIS/feat/shader-dsl-ecef-absorb `ffa2124`
- Merge pull request #522 from X-GIS/refactor/shader-dsl-sot-godfiles `e5c8331`
- Merge pull request #521 from X-GIS/refactor/shader-dsl-sot-rollout-small `1755c46`
- Merge pull request #520 from X-GIS/feat/shader-dsl-sot-storagebuffer `e564419`
- Merge pull request #519 from X-GIS/refactor/shader-dsl-sot-rollout `cbc42c8`
- Merge pull request #518 from X-GIS/feat/shader-dsl-sot-uniformstruct `eb49eb6`
- Merge pull request #517 from X-GIS/feat/shader-dsl-sot-iostruct `0b81383`
- Merge pull request #516 from X-GIS/fix/shader-dsl-validate-core-rules-only `4655ad6`
- Merge pull request #515 from X-GIS/refactor/shader-dsl-c2-rollout-shaders `fa4283b`
- Merge pull request #514 from X-GIS/feat/shader-dsl-lint-self-assign-fix `01974dd`
- Merge pull request #513 from X-GIS/feat/shader-dsl-lint-autofix `1007434`
- Merge pull request #512 from X-GIS/feat/shader-dsl-lint-report-unused-deviations `8e439eb`
- Merge pull request #511 from X-GIS/feat/shader-dsl-lint-big-shaders `0567343`
- Merge pull request #510 from X-GIS/feat/shader-dsl-static-analysis-report `7ad3324`
- Merge pull request #509 from X-GIS/feat/shader-dsl-lint-rules-batch `2e8fda3`
- Merge pull request #508 from X-GIS/refactor/shader-dsl-lint-rules-per-file `a9459f7`
- Merge pull request #507 from X-GIS/feat/shader-dsl-lint-presets-formatter `7103081`
- Merge pull request #506 from X-GIS/feat/shader-dsl-lint-rules-options `a0e3250`
- Merge pull request #505 from X-GIS/feat/shader-dsl-lint-engine-advanced `532a8ce`
- Merge pull request #504 from X-GIS/feat/shader-dsl-lint-engine `b7005aa`
- Merge pull request #503 from X-GIS/feat/shader-dsl-misra-single-exit `b8cc07b`
- Merge pull request #502 from X-GIS/fix/shader-dsl-explicit-early-return-returnif `8d1918e`
- Merge pull request #501 from X-GIS/feat/shader-dsl-consistent-native-return `f00d4a3`
- Merge pull request #500 from X-GIS/refactor/shader-dsl-c2-rollout-line2 `131bb9b`
- Merge pull request #499 from X-GIS/feat/shader-dsl-define-fn `5a5ed8a`
- Merge pull request #498 from X-GIS/feat/shader-dsl-typed-field-accessor `7848398`
- Merge pull request #497 from X-GIS/feat/shader-dsl-native-return `250c4b7`
- Merge pull request #496 from X-GIS/refactor/shader-dsl-c2-rollout-line `62ed3d1`
- Merge pull request #495 from X-GIS/feat/shader-dsl-readability-helpers-canary `c6241ef`
- Merge pull request #494 from X-GIS/feat/shader-dsl-readability-c2-ambient-builder `2da87dd`
- Merge pull request #493 from X-GIS/fix/shader-dsl-validate-opacity-and-gpu-verify `8e0170e`
- Merge pull request #492 from X-GIS/feat/shader-dsl-tsl-redesign `860c1e4`
- shader-dsl backend-agnostic: architecture design + S0 (writer/pass/oracle separation) ([#490](https://github.com/X-GIS/X-GIS/pull/490)) `ba51669`
