# TypeShade — Credibility of the 2026-09-07 Document Set, and Future Value

**Date** 2026-09-07 · **Tree** `/home/user/X-GIS`, branch `claude/shaderdsl-monetization-strategy-sr64wo`, HEAD `9f84db0242b458bf27f86a095f44a59c949165e9` (measured: `git log -1 --format='%H %ci'` → `2026-09-07 11:26:47 +0000`).

**Citation convention.** `[A1]`–`[A5]` = a figure relayed from one of the five credibility audits, carrying that audit's own source and fetch date (all 2026-09-07). `[V]` = the aggregated value pass (its three lenses are `E1/E2/E3`). `measured:` = a command I ran in this container during this pass. `derived:` = my arithmetic over published cells. Anything else is `(from memory)` and is marked so.

**What I re-ran myself** (measured, this pass): every in-tree count in §1.4, the four document line counts and mtimes, the six load-bearing file:line quotations, the cross-reference greps, and all 21 value composites. **What I did not re-run:** any external URL, and the naga sweep — `naga --version` → `30.0.1` is installed here (measured), but the disputed denominator (§1.5 C4) is relayed, not re-measured.

Audits: `A1` strategic-plan (500 lines), `A2` ecosystem-embedding (417), `A3` go-to-market (399), `A4` agent-era (312), `A5` site-design corpus (`01-research` 315 / `02-messaging` 311 / `04-ia-wireframe` 434 / `07-copy-deck` 285, at the scratchpad site tree). Plan lines/mtimes measured: `wc -l docs/plans/2026-09-07-typeshade-*.md`; `ls -la --time-style=+%H:%M` → GTM 10:42, AE 10:59, EE 11:26, SP 11:26.

## 0. Executive summary

| Document | Credibility /100 | One-line verdict | Do this |
|---|---|---|---|
| agent-era pre-mortem | **79** | Most trustworthy; refutes its own sponsor's headlines and moves numbers against the project | Publish its verification record (the "8 of 42" has none); make it a cited companion of SP/GTM |
| ecosystem-embedding | **77** | Excellent primary sourcing; contradicts three siblings and nobody merged the result | Propagate its "no host date exists" finding; fix the rung numbering that defines the kill switch |
| site-design corpus | **69** | Measured well, then shipped three already-killed claims into launch copy | Delete the oracle-uniqueness line everywhere; settle the three build-contract forks before any build |
| strategic-plan | **63** | Arithmetic is solid; two moat claims are refuted in-corpus and still printed | Re-word §1.3 S1; reprice §3/§7 against naga; propagate D13 into §5.2/§6.4/KR2.1 |
| go-to-market | **53** | Weakest: aimed at the host the decision log demoted, on a "dated" urgency that has no date | Re-run §1 targeting and §5 schedule after the owner's D13/naga decisions |

**Corpus credibility: 68/100 unweighted, 65/100 weighted by launch exposure** (derived). Zero fabricated numbers in ~87 sampled claims across five audits; the failure is entirely in the joins — `grep -c "agent-era"` returns **0** in both the strategic plan and the go-to-market plan (measured), so the document that corrects them is cited by neither.

**Future value: impact index 39/100 vs React (range 37–41), expected 42 (39.5–45.2)** on the ten-criterion rubric `[V]`. On a reach-weighted reading it is ~25 today, expected 16–19; on linear reach, 0.08 — where PixiJS also sits at 0.45. Realized audience today is 1–5 developers `[V]`. **Do:** (1) run the admitted-subset spike and measure first-try admission on agent-written WGSL — it is the go/no-go every lens converges on; (2) ship rung 0 (tag `0.1.0`, CI in the mirror, a resolving URL) — worth +2.7 index points on its own and blocked by no open decision; (3) decide the beachhead host once, in writing, and propagate it.

## 1. Credibility

### 1.1 Method — the rubric

Eight dimensions, 0–100 each. **Disclosure:** the five audits published *scores*, not prose definitions; the definitions and anchors below are the operative rubric **reconstructed from how each dimension was actually applied**, not quoted text. The aggregation rule *is* verbatim-checkable and reproduces: `overall` = unweighted mean of the seven sub-dimensions, ±1 (derived — EE 539/7 = 77.0 vs 77; AE 546/7 = 78.0 vs 79; SP 450/7 = 64.3 vs 63; GTM 375/7 = 53.6 vs 53; SD 490/7 = 70.0 vs 69).

| Dim | Scores | 100 | 50 | 0 |
|---|---|---|---|---|
| **Sourcing** | Does every load-bearing figure carry a citation a reader can follow? | Every figure has a URL+date, file:line or command | Half the figures cite a sibling document rather than a source | Assertion only |
| **Verification** | Do the cited sources say what the document says they say? | Quotation and source agree word for word | Directionally right, wording strengthened | Source contradicts the claim |
| **Refuted leakage** | Does a claim the corpus has already killed still appear as live? | No refuted claim survives anywhere | Refuted in one doc, live in another, flagged | Refuted claim is load-bearing and unflagged |
| **Consistency** | Do the documents agree with each other and with themselves? | No unresolved contradiction | Contradictions recorded with both positions | Siblings commit to opposite plans, unrecorded |
| **Reproducibility** | Can a third party re-derive the numbers from what is printed? | Command/URL printed, re-run matches | Re-runs match, commands partly implicit | Number cannot be reconstructed at all |
| **Recency** | Is the evidence current as of the decision date? | All fetched/measured 2026-09-07 | Mixed, staleness disclosed | Stale claims presented as current |
| **Independence** | Is any load-bearing claim checked outside the authoring model family? | Human or non-family review on record | Non-model tool witnesses (naga, npm API, real GL) carry the load | Same family, self-checked, undisclosed |

### 1.2 Per-document rubric

| Document | Sourcing | Verification | Refuted leakage | Consistency | Reprod. | Recency | Independence | **Overall** |
|---|---|---|---|---|---|---|---|---|
| agent-era pre-mortem | 92 | 83 | 80 | 55 | 96 | 85 | 55 | **79** |
| ecosystem-embedding | 93 | 81 | 100 | 35 | 72 | 93 | 65 | **77** |
| site-design corpus (4 docs) | 87 | 75 | 40 | 40 | 92 | 96 | 60 | **69** |
| strategic-plan | 88 | 62 | 40 | 25 | 85 | 95 | 55 | **63** |
| go-to-market | 72 | 53 | 25 | 12 | 92 | 76 | 45 | **53** |
| **Corpus (unweighted mean)** | 86 | 71 | 57 | 33 | 87 | 89 | 56 | **68** |

Reproducibility is the corpus's strongest dimension (87) and consistency its weakest (33) — **the numbers are right and the documents disagree about what to do with them.** `(from memory)` share reported per audit: AE 0.042, EE 0.042, SD 0.08, SP 0.21, GTM 0.25 — the two launch-facing documents lean hardest on unsourced assertion.

### 1.3 Sampled-claim ledger

87 claims sampled across five audits: **59 confirmed · 17 overstated · 9 refuted · 2 unverifiable** (derived: the four per-document tallies below sum to 87 / 59+17+9+2). Adjacent rows are merged where an audit grouped claims, so ids read e.g. `SP1–2`; the tallies count claims, not rows.

**A1 — strategic-plan (17 sampled: 9 confirmed, 3 overstated, 4 refuted, 1 unverifiable)**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| SP1–2 | Khronos: 64% adapt shaders; ~10% top cost; 53% debugging; GLSL 60/HLSL 41/SPIR-V 39/Slang 34; WGSL 14.9% (n=60) | Confirmed | khronos.org/blog/shader-ecosystem-survey-results-2026, 2026-09-07 — every figure verbatim; WGSL is absent from the blog and present in the GameDev.net summary at 14.93% = 60/402 `[A1]`. The "n=60" parenthetical is misread-prone; AE's prescribed rewording is untaken at SP:115/:495 |
| SP3 | 94% of LLM compilation errors are type-check failures | Confirmed | arXiv 2504.09246 body text, extracted and grepped: "on average 94% of compilation errors result from failing type checks" `[A1]` |
| SP4 | deck.gl extensions "**all** remain WebGL-only … GLSL shader injections" | **Overstated** | Page says "**Most** … injections, GLSL-only shader modules, **or extra render/picking passes**" — deck.gl/docs/developer-guide/webgpu, 2026-09-07 `[A1]`. Two causes dropped, one of which TypeShade cannot fix |
| SP5 | MapLibre phase 4 = "port GLSL shaders to WGSL"; backends share all non-GPU code; undated | Confirmed | maplibre.org/roadmap/…/graphics-modernization/, 2026-09-07 `[A1]` |
| SP6 | PixiJS: "both programs or the omitted renderer will not run it" | **Overstated** | The `{gl, gpu}` shape is verbatim; the consequence sentence does not exist on the cited page `[A1]`. D13 rests on it |
| SP7 | 58 DSL modules · 14,063 LOC · 878,943 bytes / 6 artifacts | Confirmed | measured (this pass): all three exact — see §1.4 |
| SP8 | Importer spread: map 125 · site 24 · compiler 19 · rhi-webgl2 6 · rhi-webgpu 3 · playground 1 | **Refuted** | Sums to 178, not 144; the cited command can emit only two buckets `[A1]`; no glob reproduces "site 24"/"playground 1" |
| SP9 | 146 shader-dsl test files | Confirmed | measured: `find shader-dsl -name '*.test.ts' \| wc -l` → 146 |
| SP10 | "146 test files run in ~52 s (DD: 1544 tests, 52 s)" — the 3 h compile-gate evidence | **Refuted** | Re-run: 148 files / 1690 tests / 54.15 s `[A1]`; welds a `find` count to a vitest run that collected a different set |
| SP11 | Zero dependencies (0/0/0) | Confirmed | measured: no dependency key of any kind in `shader-dsl/package.json`; `@xgis/shader-dsl` 0.0.1 MIT |
| SP12–13 | 8 npm download figures + versions + maplibre dep ranges; audience ≈ 0 (mirror 0 stars / 464 commits, X-GIS 3 stars, no npm download record) | Confirmed | npm + GitHub APIs and `git rev-list --count`, 2026-09-07, all exact `[A1]`. The mirror is hours old, so its 0 stars is a tautology; the load-bearing count is X-GIS's 3 |
| SP14 | "CPU f64 oracle — no comparable library ships one" (the moat) | **Refuted** | `wgsl_reflect` ships `WgslExec`, a CPU WGSL executor, 277,311 weekly `[A1][A4]`. AE §2.6 instructed a rewording **before launch**; measured (this pass): SP:41 still reads "no comparable library ships one" |
| SP15 | "Without TypeShade, X-GIS hand-writes and hand-syncs ~0.88 MB of WGSL **and** GLSL" | **Refuted** | naga 30.0.1 `--profile es300` translates 92/116 entry points (79.3%) of the same corpus `[A1]`. SP names naga 10× (measured) — never as a porting route |
| SP16 | Tailwind: docs −40% "since early 2023", revenue −80%, 75% laid off | **Overstated** | Source says "dropped by 40 percent **in two years**" (i.e. early 2024) — devclass.com, 2026-09-07 `[A1]` |
| SP17 | `reflect()` has 49 inbound callers | **Unverifiable** | codebase-memory MCP absent; grep bounds it at 40 sites / 21 files outside the package `[A1]`; measured (this pass): `shader-dsl/README.md:30` says "**13** direct callers across four packages" |

**A2 — ecosystem-embedding (20 sampled: 16 confirmed, 4 overstated, 0 refuted)**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| EE1 | 17 npm reach figures, window 2026-08-31→09-06 | Confirmed | 17/17 exact `[A2]` — the strongest reproducibility result in the set |
| EE2 | earcut is a runtime dep of maplibre-gl/pixi.js/@cesium/engine/@deck.gl/layers; three has none | Confirmed | Four ranges + the negative, exact from version manifests `[A2]` |
| EE3 | three: zero deps r100→r185; 135 migration sections; 0 entries for FunctionNode/CodeNode/wgslFn/glslFn | Confirmed | raw.githubusercontent tags + wiki grep `[A2]` |
| EE4 | 26 Agent Skills ride inside the pixi.js tarball; the custom-rendering skill teaches twin shaders | Confirmed | Tarball listing + `package/skills/pixijs-custom-rendering/SKILL.md:44-55` `[A2]` |
| EE5 | pixi-filters: 1,907 GLSL + 2,480 WGSL lines across **36** dirs, all carrying both | **Overstated** | Line counts exact; directory count is **37**, all 37 carrying both `[A2]` — understates its own case |
| EE6 | bulge-pinch guards differ (`!=` vs `&&`), dead `compareVec2` fossil below | Confirmed | `bulge-pinch.frag:34`, `.wgsl:49`, `.wgsl:56` `[A2]` — the corpus's strongest single artifact |
| EE7 | MapLibre's 71 shaders are generated, gitignored, `prepare`-wired; tarball ships `src/` | Confirmed | `find src/shaders -name '*.glsl'` → 71; `.gitignore:29`; package.json `files` `[A2]` |
| EE8 | `projectCircleRadius` exists only in the mercator prelude | Confirmed | `_projection_mercator.vertex.glsl:5` def vs `_projection_globe.vertex.glsl:36` comment `[A2]` |
| EE9 | WebGPU is phase 5 of 6 in #7640 and "phase 4" of 4 on the roadmap; #2606 is not the tracker | Confirmed | Both numberings + the quote `[A2]` |
| EE10 | `#ifndef PROJECTION_UBO` is unreleased (merged 1 day after v6.7.0, absent from CHANGELOG) | Confirmed | PR #8290 + registry publish times + CHANGELOG grep = 0 `[A2]` |
| EE11–12 | Cesium: 0 `.wgsl` vs a 319-file GLSL control; 0 of 6,285 changelog lines; #4989 open since 2017; **17** UniformTypes with SAMPLER_CUBE the only undocumented member | Confirmed | All figures exact incl. the control; `UniformType.js:122-123` `[A2]` |
| EE13–14 | deck.gl declares one uniform struct three times and they disagree (the validator compares names only); three's `CodeNode.language` has no consumer and the new `Renderer` has no `resetState()` | Confirmed | `scatterplot-layer-uniforms.ts:16/:52` vs `scatterplot-layer.wgsl.ts:16`; `shader-module-uniform-layout.ts:128`; `CodeNode.js:69/121/130`; `Renderer.js:1989` `[A2]` |
| EE15 | Babylon: `addUniform` handles no structs; `#version 300 es` hits an early-return; WGSL must omit `@group/@binding` | Confirmed | `uniformBuffer.ts:404-405`; `shaderProcessor.ts:325-331`; `webGPUWGSL.md:139` `[A2]` |
| EE16 | Emit 33.0–151.9 ms warm; `optimize` 89% of a 52.9 ms emit | **Overstated** | Re-run: 51.2–77.7 / 198–212 ms, optimize 94.1% `[A2]`. Shape reproduces (86 pass runs exact); absolutes 1.3–2.4× off; citation is a chain to a sibling, not a command |
| EE17 | Emitted shaders carry no licence term, "exactly as a Bison parser's output" | **Overstated** | SPDX text truncated before its condition; and Bison's exception exists only because Bison is GPL `[A2]`. The grant is valid; the analogy is a category error aimed at host lawyers |
| EE18 | Rung 0 premises: `@xgis/shader-dsl` 0.0.1, mirror read-only, npm `typeshade` 0.0.0, gates run only in X-GIS CI | Confirmed | measured (this pass): mirror `29c9614`, `ls -a` shows **no `.github`** — rung 0b genuinely undone |
| EE19–20 | PixiJS ~$40.3k/yr, `extractStructAndGroups` public and `generateLayoutHash` still `@internal`; MapLibre ships every ~5–6 days (~60/yr) and luma's alpha window is 1.7 months | Confirmed / **Overstated** | Funding and API tags exact; cadence is 6.76 days (54 versions/12 months) and alpha→GA is 44 days = 1.45 months `[A2]` — ~15–20% inflation, conclusions unaffected |

**A3 — go-to-market (14 sampled: 8 confirmed, 4 overstated, 2 refuted)**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| GTM1 | 8 npm reach proxies | Confirmed | All exact `[A3]` |
| GTM2 | 58 / 14,063 / 144 / 878,943 / 0-0-0 on the X-GIS tree | Confirmed | measured (this pass): all five exact |
| GTM3 | 135 vs 146 test files are one tree under two globs; 146 is publishable | Confirmed | measured: 135 / 146 `[A3]` — a properly adjudicated conflict |
| GTM4 | "36 examples, **each** emitting both targets" | **Refuted** | 35 of 36; `compute-reduction` is WGSL-only `[A3][A5]`. The copy deck already carries "35 of 36" |
| GTM5 | Khronos "~10% call it one of their largest engineering costs" | **Overstated** | Source: "a **significant or** one of their largest" — a disjunct dropped `[A3][A5]` |
| GTM6 | TypeGPU's WebGL2 backend is experimental, no compute/storage/bind groups | Confirmed | docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/, verbatim `[A3]` |
| GTM7 | deck.gl "all remain WebGL-only" — quoted back to deck.gl as the opening message | **Overstated** | Live page says "most"; ClipExtension already has initial WebGPU support `[A3]`. A misquote of a host's own docs, scripted to be sent to that host |
| GTM8 | S1 pain is "Highest — **dated** (roadmap phase 4)" | **Overstated** | The 1,845-character roadmap page contains zero date/quarter/year tokens and never mentions custom layers `[A3]` |
| GTM9 | An inbound exists: PixiJS #11027 "how to make GLSL porting easier" | Confirmed | Open, unanswered `[A3]` — but opened 2024-11-04, one author, one thread |
| GTM10–11 | PixiJS Open Collective $118,918.03 / $40,250.02 est. annual; Tailwind −40% / −80% / 75% laid off | Confirmed | opencollective.com/pixijs exact; the devclass URL 404s from the audit's container but the substance corroborates across several independent reports `[A3]` |
| GTM12–13 | llms.txt at 10.13% of 300,000 domains; MCP under the Linux Foundation with >10,000 servers; 94% type-check | **Overstated** / Confirmed | The llms.txt cut is the most favourable available — the corpus's own sibling carries 5.61% of the top 10k and 97%-never-read; MCP and the 94% confirm at primary `[A3][A4]`. Omission: the official MCP registry returns **count 0** for shader/wgsl/webgpu |
| GTM14 | "Beachhead is settled and cross-checked three ways: MapLibre → deck.gl → PixiJS" | **Refuted** | measured (this pass): `SP:468` D13 resolves to "**(b)** PixiJS adapter first" and states "§6.4's ranking is superseded by the deep-dive's" `[A3]` |

**A4 — agent-era pre-mortem (20 sampled: 14 confirmed, 5 overstated, 1 unverifiable)**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| AE1 | naga 30.0.1 translated 92/116 entry points; 90 compiled on real WebGL2 = 77.6% | Confirmed | Re-run end to end: corpus 40 modules / 525,029 B / 116 EPs exact; 92 translated; 24/24 refusals `Features(BUFFER_STORAGE \| DYNAMIC_ARRAY_SIZE)`; 90 OK / 2 `sampler2DMS` on ANGLE/SwiftShader `[A4]` |
| AE2 | `wgsl_reflect` ships a CPU WGSL executor, 277,311 weekly | Confirmed | npm + README verbatim `[A4]` |
| AE3 | "SP §1.3 S1 is no longer defensible as written" | **Overstated** | SP:41 does carry the `f64` qualifier (measured, this pass), and AE itself concedes wgsl_reflect models f32. The genuinely refuted sentence is the product-strategy sibling's unqualified one, which AE never names `[A4]` |
| AE4 | 355 exported symbols | **Overstated** | Live snapshot `shader-dsl/src/__api__/surface.md:13` reads **366 exports** (measured, this pass); the cite points at a historical comment, `api-surface.test.ts:37` (measured: it begins "reproduces: …") |
| AE5 | CloudAPIBench: GPT-4o 38.58% → 47.94% with doc-augmented generation | Confirmed | arxiv.org/abs/2407.09726, both numbers exact `[A4]` |
| AE6–7 | TypeGPU skill: 52,017 installs in a third-party bundle vs 1,320 self-listed (39.4×); npm `typeshade` = 0.0.0 placeholder at 07:43 UTC, typeshade.dev → 000, typeshade.github.io → 404 | Confirmed | skills.sh API (`q=typeshade` → count 0) + npm + curl, all exact `[A4]` |
| AE8 | arXiv 2504.09246 Table 2 reads 74.8/56.0 vs 9.0/4.8; the figures 75.3/52.1/4.9 appear nowhere | Confirmed | PDF downloaded and text-extracted; zero context matches for the three `[A4]` |
| AE9 | The Khronos survey contains no AI/LLM/agent question at all | Confirmed | Full-page check `[A4]` — the corpus's most consequential external correction |
| AE10 | luma.gl has shipped a double-single fp64 GLSL module for years (821,517/wk) | Confirmed | luma.gl fp64 docs verbatim `[A4]`; one sub-claim ("deprecated in v6.3") is not on the cited page |
| AE11 | 97% of llms.txt files across 137,000 domains got zero requests, May 2026 | **Overstated** | The fact is real but **misattributed**: neither cited source carries it; it is Ahrefs', uncited `[A4]`. AE calls this "the figure that decides" D9 |
| AE12–13 | 5.61% of the top 10,000 sites publish llms.txt and Google will not support it; the official MCP registry returns count 0 for shader/wgsl/webgpu | Confirmed | caseyrb.com + seranking.com; registry.modelcontextprotocol.io `[A4]` |
| AE14 | Vercel `vgpu` (49,779/wk) ships the whole candidate-defence list; no GLSL, no oracle | Confirmed | Site + README, absences checked `[A4]` |
| AE15 | GitClear over 623M changes: duplication +81%, refactoring −70%, copy/paste +41% | Confirmed | gitclear.com, all five figures exact `[A4]` |
| AE16 | CodeRabbit ~$40M ARR Apr 2026, +700% YoY, $143M Series C | **Overstated** | The cited page says $50M in July 2026, up from $25M (+100%), and details a Series B `[A4]`. Round and reviews/week are real, from an uncited source |
| AE17 | Anchor-tenant tree counts (58/14,063/144/878,943/146/108/27,727/0-0-0/1,608) | Confirmed | measured (this pass): all exact |
| AE18 | npm `text=wesl` → total 20, 19 tooling, exactly 1 shader package | **Overstated** | Total 20 exact; the split is 18/2 (`random_wgsl`, `lygia`) `[A4]` — the exact quantity R15's trigger is keyed on |
| AE19 | Four naga behaviour probes (f64 rejected; `select`→`mix` rejected by WebGL2; call named first; MRT locations) | Confirmed | All four reproduced verbatim against naga 30.0.1 + real WebGL2 `[A4]` — and all four argue *against* the project's own differentiators |
| AE20 | "8 of 42 checked claims were refuted" | **Unverifiable** | No claim list, run log or hash published; §2 tabulates 12 items of which exactly one carries the verdict "Refuted" `[A4]`. This is the sentence that licenses trust in the rest |

**A5 — site-design corpus (16 sampled: 12 confirmed, 1 overstated, 3 refuted)**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| SD1 | M1: 35 of 36 examples emit both targets; `compute-reduction` throws `UnsupportedFeatureError` | Confirmed | Emit loop re-run against pinned `29c9614`; error string byte-identical `[A5]` |
| SD2 | M5/X3: 135 and 146 are one tree under two globs; the 11 extras are the cited suites | Confirmed | measured (this pass): 135 / 146 |
| SD3 | M4/C3: the mirror manifest has no dependency field at all | Confirmed | measured: `[]` dependency keys, MIT, 0.0.1 |
| SD4 | M2/X4: the mirror ships no CI; `vendor/shader-dsl/.github` does not exist | Confirmed | measured (this pass): `ls -a` on `29c9614` lists no `.github` |
| SD5 | M2: the two compile gates cover X-GIS's own variants, not the mirror's 36 examples | Confirmed | `_wgsl-compile-gate.spec.ts:10-19`; `.github/workflows/test.yml:1375` `[A5]` |
| SD6 | M3/C1/C2: `hero.authored` is a 10-line fragment slice of a 98-line file | Confirmed | `wc -l examples/gradient-pass.ts` → 98 `[A5]`; refutes `02-messaging.md:180` "Eight lines" |
| SD7 | M6: the typed diagnostic is TS2339 at 7:47, 168 chars, `truncated: false` | Confirmed | `typedError()` re-run, byte-identical; layout 48 B / 0,16,32 `[A5]` |
| SD8 | Emit indicator: WGSL 29 lines; GLSL 18 + 16 = 34 | Confirmed | `emitModule` / `emitGlslStages` re-run `[A5]`. Note: the 34 requires `emitGlslStages`, not the `emitGlslModule` the messaging doc names |
| SD9 | "2.9 KB inlined here" — the hero payload | **Refuted** | Re-measured 2,090 B raw / 2,165 escaped = **2.1 KB**; the sibling control (metaballs 4.3 KB) reproduces exactly `[A5]`. Hand-entered: the `hero.emit` build route does not exist |
| SD10 | whowrites body: "64% … adapt shaders. About 10% call it one of their largest costs" | **Overstated** | Drops "spend at least some effort" and the "significant or" disjunct `[A5]` — inside the one block carrying the reason to buy |
| SD11 | "CPU f64 oracle — no comparable library has one" ×3 | **Refuted** | measured (this pass): `02-messaging.md:51,137,190` still carry it. Refuted by `wgsl_reflect` `[A4][A5]`; the copy deck removed it from the page as "uncheckable", never as false |
| SD12–15 | Competitive page reads: mui.com (5.8M / 93.9k / 3.0k / 19.2k, 7-word headline, 6-logo band); typegpu.com (wordmark + 18-word subline, no hero visual); tailwindcss.com (the only comparator whose hero object is code, one measured claim "<10kB CSS"); react.dev (no logo band, late prose social proof, a different CTA verb per section) | Confirmed | All four fetched 2026-09-07 against served HTML with byte offsets; every count exact, and the typegpu transcription is right even where it differs from that repo's own description `[A5]` |
| SD16 | "ecosystem-embedding.md is still absent, so SP §6.4 remains authoritative" (copy deck rev 2) | **Refuted** | measured (this pass): the file exists, 96,980 B, mtime 11:26 vs the deck's 10:59; and `SP:468` D13 retired §6.4's ranking |

### 1.4 Re-run measurements — documented vs re-run

**Matched (not itemised):** ~70 of ~90 re-runs matched exactly, including all 17+8 npm download figures in two independent passes, all GitHub/registry version and publish dates, every in-tree count below, all four naga behaviour probes, the full naga translate+compile chain (92/24, 90/2), and every quoted percentage in the Khronos, arXiv, GitClear and CloudAPIBench sources `[A1]–[A5]`.

**In-tree counts I re-ran myself this pass** — documented → re-run → match: 58 → 58 ✓ · 14,063 → 14063 ✓ · 144 → 144 ✓ · 878,943 → 878943 ✓ · 146 → 146 ✓ · 135 → 135 ✓ · 1,608 → 1608 ✓ · 0/0/0 deps → no dependency key present ✓ (commands in §5).

**Mismatches:**

| Quantity | Documented | Re-run | Match |
|---|---|---|---|
| Importer spread by package (SP) | map 125 · site 24 · compiler 19 · rhi-webgl2 6 · rhi-webgpu 3 · playground 1 (Σ178) | 19 compiler · 125 map (Σ144) under the cited command; Σ196 under any broader glob | ✗ |
| shader-dsl unit suite (SP §11.2 floor evidence) | 146 files / 1,544 tests / 52 s | 148 files / 1,690 tests / 54.15 s | ✗ |
| What the vitest filter collects | (not disclosed) | 148, incl. 2 files outside the package | ✗ |
| naga refund of the twin-shader tax (SP §3 counterfactual) | not measured; "hand-write and hand-sync both" | 92/116 = 79.3% translated `[A1]`; 90/116 = 77.6% end-to-end `[A4]` | ✗ |
| naga corpus denominator | 40 distinct modules / 525,029 B / 116 EPs `[A4]` | 28 distinct / 394,192 B / 83 EPs → 64/83 = 77.1% `[A3]`; index keys alias one content hash | **✗ conflict** |
| `reflect()` inbound callers | 49 (graph) | Not re-derivable (MCP absent); grep 40 sites / 21 files; README:30 says 13 | ✗ |
| Tailwind docs-traffic period; MCP governance citation | "since early 2023"; cited post + ">10,000 public servers" | "in two years" (= early 2024); the cited post carries neither fact, and the correct source says "10,000 active" | ✗ |
| pixi-filters shader directories | 36 | 37 (all 37 carry both arms) | ✗ |
| Emit cost (`emitPolygonWgsl` / `emitLineWgsl` / `optimize` share) | 33.0 ms / 151.9 ms / 89% | 51.2–77.7 ms / 198–212 ms / 94.1% | ✗ |
| MapLibre release cadence | every ~5–6 days, ~60/yr | 54 in 12 months = 6.76 days | ✗ |
| luma.gl 9.4 alpha→GA | 1.7 months | 44 days = 1.45 months | ✗ |
| Examples emitting both targets | 36 of 36 | 35 of 36 | ✗ |
| IA content blocks before the footer | six | seven (IA's own heading and finding X6 both say seven) | ✗ |
| Public API surface | 355 exports | 366 (`src/__api__/surface.md:13`, measured this pass) | ✗ |
| npm `text=wesl` tooling/content split | 19 / 1 | 18 / 2 | ✗ |
| Hero inlined payload | 2.9 KB | 2,165 escaped B = 2.1 KB | ✗ |
| "8 of 42 claims refuted" | 8 / 42 | No record exists; 12 tabulated items, 1 verdict "Refuted" | unverifiable |

### 1.5 Contradictions

| # | Contradiction | Where | Resolved? |
|---|---|---|---|
| C1 | **Beachhead host.** GTM/SP §5.2/§6.4/KR2.1 commit to MapLibre; EE §4 and SP D13 choose PixiJS | GTM:10 · SP:180/:259/:441 vs SP:468 · EE:261 | **Decision yes, propagation no.** D13 records both positions and instructs a GTM re-run that has not happened (measured: GTM still ranks S1 MapLibre) |
| C2 | **"Dated" pain.** SP/GTM sell a dated expiry; EE:153 states "no host date exists … I am not quoting one" | SP:259 · GTM:31 vs EE:153 | **No.** EE is correct: #7640 sits at phase 2, the roadmap carries no date |
| C3 | **Oracle uniqueness.** Refuted in AE §2.6; live at SP:41, GTM:70, messaging ×3, brief | measured this pass | **No.** Removed from the *page* as "uncheckable", never corrected as false |
| C4 | **naga absent from the competitive analysis.** SP names it 10× only as a validator; GTM names it 0× (measured); the site corpus 0× | SP/GTM/site vs AE §2.2 | **No.** If ~77% of the tax is refundable free, the Pain=5 scores behind S1 4.70 / S2 4.05 are not defensible |
| C5 | **Kill-switch rung numbering.** EE §4 rung 3 = docs/skill listing (month 6); SP rung 2 = same event (month 9); the month-12 ABANDON trigger keys on "rung 3" | EE:306 vs SP:277 | **No.** Under SP's numbering the abandon bar is materially harder |
| C6 | **Adapter adoption bar.** EE: ≥0.1% of host core within 6 months of publish; SP/GTM: ≥100 installs/wk by month 12 | EE:365 vs SP:276 · GTM:315 | **No.** 9–44× stricter, six months earlier |
| C7 | **`reflect()` callers.** 49 (SP §4.2/§6.2) vs 13 (`shader-dsl/README.md:30`, measured) | — | **No.** An evaluator reads the README first |
| C8 | **Test-file counts.** 135 / 146 / 137 / 148 / 1,544 / 1,690 in circulation | GTM:385 vs SP:371 | **Partly.** 135-vs-146 properly adjudicated; the vitest run's own counts are not |
| C9–10 | **Q1 gate** (SP §12.1 requires matrix-green in Q1; KR2.2 sets the matrix at month 4) and **investment split** (SP §10 keeps 70/25/5 and KR3.1 budgets the floor only; AE withdrew the envelope and added KR3.5) | SP:448 vs :441 · SP §10 vs AE:208/:232 | **No.** GTM recorded the Q1 divergence and dropped matrix-green; SP did not |
| C11 | **Consumer figures.** SP 58 files / 14,063 LOC vs the product-strategy sibling's 56 / 13.7k | SP:126 vs PS:29 | **No.** SP is right (measured); PS is stale and cited 20+ times |
| C12 | **Emit cost, internally.** One EE sentence quotes 33.0 ms and "a 52.9 ms emit" for the same operation | EE:84-85 | **No.** The gap is `profileEmit` instrumentation, stated nowhere |
| C13–15 | **The site's build contract has three forks.** §write's h2 ("Ten lines." vs "One function.", where IA also forbids numerals in h2); the block count and id (7/`recognise` vs 8/`whowrites`); the canvas mount count (4 vs 5) | 07:106/:83/§6 vs 04:145/:141/§0.3 | **No.** Slot ids *are* the build contract, and the fifth mount has no caption or accessible name in the document that owns every string |
| C16 | **CodeRabbit / llms.txt attributions** — figures cited to pages that do not carry them | AE §2.3, §2.7 | **No** |
| C17 | 878,943 bytes as a landing-page signal | SP §14 vs GTM:324 | **Yes** — both positions and the reason recorded |
| C18 | 135 vs 146 test files | GTM:385 | **Yes** — "one tree under two globs" |

**Score: 2 of 18 resolved.** The two that are resolved were resolved the same way — by writing both positions and the reason into one place. That is the whole remedy for the other sixteen.

### 1.6 The correlated-error limitation

Every strategy document, every adversarial verification pass inside them, all five credibility audits, all three value lenses and this aggregation were produced by agents of **one model family**, in one day. No human and no other model family has checked any figure. The audits disclose this; it is not eliminated by disclosure.

What limits the damage is that the load-bearing evidence is carried by **non-model instruments**: naga-cli 30.0.1, a real ANGLE/SwiftShader WebGL2 context, the npm downloads and registry APIs, the GitHub API, `curl` status codes, a PDF text extractor, and `find`/`grep` on this tree. Those reproduced across independent passes — including the one place where two same-family passes **disagree** (the naga denominator, C4/§1.4), which is evidence the instruments are doing real work rather than echoing. What is *not* limited: every interpretive claim — probabilities, scenario weights, what the 77% means, which host to target — is same-family judgement, and at least one framing error demonstrably survived a verification pass into an executive summary (AE3). **One reply from a MapLibre, PixiJS, deck.gl or wgpu maintainer would be worth more than a sixth agent pass.**

### 1.7 Human spot-check list — the 10 claims to verify first

| # | Claim | Exact check |
|---|---|---|
| 1 | "No comparable library ships a CPU oracle" (the moat) | `https://github.com/brendan-duncan/wgsl_reflect` — read the `WgslExec` section; then `curl -s https://api.npmjs.org/downloads/point/last-week/wgsl_reflect` |
| 2 | naga refunds ~77% of the twin-shader tax | `naga --entry-point <ep> --profile es300 <module>.wgsl out.frag` over `map/src/shaders/baked/baked-wgsl-*.generated.ts`, **reporting the entry-point count both with and without content-hash de-duplication** (that is C4) |
| 3 | MapLibre's WebGPU work is "dated" | `https://maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/` and `https://github.com/maplibre/maplibre-gl-js/issues/7640` — look for any date, and for which phase is current |
| 4 | deck.gl extensions "all remain WebGL-only" | `https://deck.gl/docs/developer-guide/webgpu` — the word is "Most", and count the causes listed |
| 5 | PixiJS "both programs or the renderer will not run it" | `https://pixijs.com/8.x/guides/migrations/v8` — find the consequence sentence, or confirm it is absent |
| 6 | "94% of LLM compilation errors are type-check failures" applies to shader authoring | `https://arxiv.org/abs/2504.09246` §5 — check the *subject* (TypeScript program synthesis), not the number |
| 7 | Khronos wording | `https://www.khronos.org/blog/shader-ecosystem-survey-results-2026` — "spend **at least some effort**" and "a **significant or** one of their largest" |
| 8 | The ~12 h/month maintenance floor | Keep one month's actual hours on TypeShade and compare; then sum GTM §8.2 (~45–75 h/mo) + AE's ~21 FTE-weeks + SP's floor, which no document does |
| 9 | `reflect()` caller count | `grep -rn "reflect(" map/src compiler/src rhi-* playground site --include=*.ts \| grep -v test` vs `sed -n '30p' shader-dsl/README.md` |
| 10 | The go/no-go for the whole pivot | Run the admitted-subset spike and report **first-try admission rate on agent-written `.wgsl`** — AE:97 concedes "the denominator is unmeasured, and measuring it is the whole point" |

Runners-up: the hero payload "2.9 KB" (`2,165` escaped bytes measured), and the API surface `355` vs `366`.

## 2. Future value

### 2.1 Criteria and scale (verbatim from the value pass; all three lenses used these weights unchanged)

| ID | Name | Wt | Definition | Scale |
|---|---|---|---|---|
| C1 | Addressable developer population | 0.20 | "Ceiling of developers who could plausibly use the subject for the job it claims — **addressable, not realized**. Preferred instrument: a survey usage share × a sized population. Fallback: npm weekly downloads ÷ a downloads-per-developer deflator, which **must be labelled an estimate**. Stars are never a population." | 10 = ≥5M; 7 = ~1M; 5 = ~100k; 3 = ~10k; 1 = ~1k |
| C2 | Problem severity × frequency | 0.10 | "How badly and how often the target population is hurt by the problem the subject removes, from population-level survey pain where one exists rather than the vendor's framing. Substitutes are priced in C3, not subtracted here." | 10 = daily blocker for all; 5 = recurring cost for a minority; 1 = nuisance |
| C3 | Substitutability and moat | 0.10 | "What the user does instead if the subject vanishes, at what switching cost, and whether the residue is a **structural** moat or a **maintenance position**." | 10 = no substitute + structural moat; 5 = substitutes exist, switching costly; 1 = commodity |
| C4 | Network effects / ecosystem leverage | 0.10 | "Whether each additional user makes the subject more valuable to the next. **Direct** = a plugin ecosystem others build in. **Indirect** = value routed through host adapters the subject does not own." | 10 = strong direct; 5 = indirect; 1 = none |
| C5 | Timing window | 0.10 | "How long the **stated reason to exist** stays true. Scored on the relevance window of the value proposition, not on business prospects (C8) and not on the maintainer's prospects (C6)." | 10 = growing, decade-long; 5 = closing in ~5 years for part of the pitch; 1 = past |
| C6 | Execution capacity | 0.10 | "People, money and governance **actually available** to ship the roadmap the subject wrote for itself — scored against that roadmap's hour cost, not stated intent." | 10 = funded team ≥10; 5 = small funded team; 2 = one unfunded maintainer; 1 = abandoned |
| C7 | Distribution reach | 0.10 | "Whether a developer **or an agent** that needs the subject finds it today: registry presence, resolving origin, docs, agent-skill registries, training-corpus presence. Measured by resolving endpoints, not planned channels." | 10 = category default everywhere; 5 = discoverable via hosts/registries; 1 = invisible |
| C8 | Monetization potential | 0.05 | "Realistic **capture by the maintaining entity**, given buyer power and the OSS free-rider norm. Scored on demonstrated revenue in comparables, not on a pricing plan." | 10 = proven multi-line business; 5 = plausible services/pro lines; 1 = none |
| C9 | AI-agent-era fit | 0.10 | "Whether value rises, holds or falls as agents write more code — on **two channels**: can the agent *find* it, and can the agent *use it correctly* (API surface vs training frequency)." | 10 = strengthens; 5 = neutral or split; 1 = erased |
| C10 | Evidence quality / proof as differentiator | 0.05 | "Whether correctness claims are backed by artifacts **a third party can run and rely on**, as distinct from internal CI, as distinct from assertion." | 10 = independently reproducible proofs outsiders rely on; 5 = internal gates; 1 = claims only |

### 2.2 Score matrix — min / **median** / max across three independent lenses

| | React | Vue | three.js | Tailwind | PixiJS | TypeGPU | **TypeShade** |
|---|---|---|---|---|---|---|---|
| C1 (.20) | 10/**10**/10 | 9/**9**/9 | 6/**6**/7.5 | 9/**10**/10 | 5/**5**/5.5 | 3/**3.5**/4 | **3/3/4** |
| C2 (.10) | 9/**9**/9 | 8/**9**/9 | 7/**8**/8 | 7/**8**/8 | 7/**7**/7 | 5/**5**/5 | **4/5/5** |
| C3 (.10) | 7/**8**/8 | 6/**6**/6 | 7/**7**/7 | 5/**6**/6 | 5/**5**/5 | 3/**3**/4 | **3/3/4** |
| C4 (.10) | 10/**10**/10 | 8/**8**/8 | 7/**8**/8 | 8/**8**/8 | 6/**6**/6 | 3/**3**/4 | **2/2/2** |
| C5 (.10) | 7/**8**/9 | 6/**7**/8 | 8/**8**/8 | 6/**6**/7 | 5/**6**/6 | 7/**8**/8 | **4/5/5** |
| C6 (.10) | 10/**10**/10 | 7/**8**/8 | 6/**6**/7 | 5/**5**/6 | 4/**4**/5 | 6/**6**/7 | **2/2/2** |
| C7 (.10) | 10/**10**/10 | 9/**9**/9 | 9/**9**/9 | 10/**10**/10 | 6/**7**/7 | 4/**5**/5 | **1/1/1** |
| C8 (.05) | 6/**7**/7 | 6/**6**/8 | 3/**3**/3 | 4/**6**/6 | 3/**3**/3 | 4/**5**/5 | **3/3/4** |
| C9 (.10) | 6/**6**/7 | 5/**6**/6 | 5/**6**/7 | 4/**5**/6 | 5/**6**/6 | 6/**6**/7 | **5/5/5** |
| C10 (.05) | 5/**5**/6 | 5/**5**/5 | 5/**6**/6 | 4/**4**/4 | 4/**4**/5 | 5/**5**/5 | **5/6/7** |
| **Composite** | 8.60/**8.65**/8.85 | 7.45/**7.65**/7.65 | 6.65/**7.00**/7.05 | 7.00/**7.30**/7.30 | 5.35/**5.45**/5.50 | 4.75/**4.80**/5.00 | **3.25/3.40/3.55** |

I recomputed all 21 composites from the published cells; **21 of 21 reproduce** (derived). Composite-of-medians vs median-of-composites agrees within 0.15 for every subject, so the pooling method is not driving the ranking.

**Unanimous, zero spread, on TypeShade: C4 = 2, C6 = 2, C7 = 1, C9 = 5.** Not one of those four is a statement about the compiler. **Largest disagreement: C10 (5/6/7)** — its only above-median criterion.

### 2.3 Impact index (React = 100) and reach on a log scale

| Subject | Median composite | **Index** | Range | Pooled reach (developers) | **log₁₀ reach** | log₁₀ range |
|---|---|---|---|---|---|---|
| React | 8.65 | **100.0** | — | ~14M | **7.15** | 7.04–7.32 |
| Vue | 7.65 | **88.4** | 86.4–88.4 | ~4.4M | **6.64** | 6.60–6.64 |
| Tailwind CSS | 7.30 | **84.4** | 79.1–84.9 | ~7.5M | **6.88** | 6.70–7.00 |
| three.js | 7.00 | **80.9** | 75.1–81.5 | ~650k | **5.81** | 5.48–6.18 |
| PixiJS | 5.45 | **63.0** | 61.6–63.6 | ~100k | **5.00** | 4.70–5.18 |
| TypeGPU | 4.80 | **55.5** | 53.7–57.8 | ~20k | **4.30** | 3.70–4.48 |
| **TypeShade (addressable)** | **3.40** | **39.3** | **36.7–41.3** | **~30k** | **4.48** | 4.00–5.00 |
| *TypeShade (realized today)* | — | — | — | **1–5** | **~0.3** | 0.0–0.7 |

Three readings of the same evidence (derived; B = composite × log₁₀ reach, normalised to React):

| Subject | A. Rubric index | B. Log-reach-weighted | C. Linear-reach-weighted |
|---|---|---|---|
| React | 100.0 | 100.0 | 100.0 |
| Tailwind | 84.4 | 81.2 | 45.2 |
| three.js | 80.9 | 65.8 | 3.8 |
| PixiJS | 63.0 | 44.1 | **0.45** |
| TypeGPU | 55.5 | 33.4 | 0.078 |
| **TypeShade (addressable)** | **39.3** | **24.6** | **0.083** |
| **TypeShade (realized)** | — | **1.6** | **0.0000056** |

### 2.4 Scenarios and expected value

| Scenario | P | Range | Index | Range | Reach |
|---|---|---|---|---|---|
| **P10 — stays an X-GIS-internal tool.** No adapter ships; SP §12.1 kill gates fire. Internal value undiminished (144 importers, measured) | **0.50** | 0.40–0.55 | **27.7** | 25.6–28.8 | 1–5 devs |
| **P50 — embedded in 1–2 hosts as a checker.** 0.1.0 tagged; playground ships; 1–2 `@typeshade/*` adapters reach a merged host docs/skills PR; the host × adapter × backend matrix published; low-thousands weekly; bus factor still 1 | **0.38** | 0.35–0.45 | **50.3** | 47.5–54.7 | 10²–10³ |
| **P90 — the standard shader checker for TypeScript.** WGSL/WESL ingestion of an admitted subset ships after the fuzzer; the divergence corpus and rendered-truth differ ship; a third-party-cited parity benchmark; 3+ hosts; ≥10k weekly; a second publisher | **0.12** | 0.10–0.15 | **75.0** | 70.6–76.3 | 2×10⁴–6×10⁴ |

**Expected impact index = 42.0** (derived: 0.50×27.7 + 0.38×50.3 + 0.12×75.0). Per-lens expected values 39.5 / 42.6 / 45.2 → **range 39.5–45.2**. On the log-reach model, expected **≈ 16–19**.

Two properties matter more than the mean. **(a) Expected (42.0) exceeds today (39.3)** because C7 = 1 is caused by facts fixable in a week — `typeshade.dev` does not resolve, the GitHub Pages origin 404s, npm holds a 0.0.0 placeholder, `skills.sh` returns count 0 `[A4]`. The +2.7 is the value of merely shipping. **(b) The rubric barely discriminates:** 27.7 → 75.0 is 2.7× across outcomes whose reach differs by four orders of magnitude. **Treat the scenario indices as ordinal.**

### 2.5 Disagreements and what settles each

| # | Disagreement | Positions | What settles it |
|---|---|---|---|
| D1 | **P(stays internal)** — drives the whole 39.5–45.2 range | 0.40 (rungs 1–2 are code-only, 12–15 eng-days/adapter, anchor tenant funds the floor) vs 0.50 (the pivot's critical path is 3–4 FTE months against a 12 h/month floor; no doc reconciles it) vs 0.55 (every external signal is zero today; bus factor 1) | (1) The admitted-subset spike's first-try admission rate on agent-written WGSL — under ~60%, P50 collapses into P10. (2) One month's actual maintenance hours vs the 12 h/month floor, and one page summing GTM's ~45–75 h/mo + AE's ~840 h + SP's floor — a sum that exists nowhere |
| D2 | **naga corpus denominator** — the only outright factual conflict between two independent re-runs | 40 modules / 116 EPs → 90/116 = 77.6% vs 28 distinct / 83 EPs → 64/83 = 77.1% (index keys alias one content hash) | One re-run reporting the count **both with and without hash de-duplication**, by a party outside this model family. Separately: nobody has re-compiled the surviving 90 on a live WebGL2 context twice — that leg is single-sourced. The *percentage* survives; the denominator is what §7's option strike is priced on |
| D3 | **C1 population method** — moves the heaviest-weighted criterion for every non-React subject | survey-share × population vs downloads ÷ a React-calibrated deflator (~11 dl/dev/wk). Diverges wherever no survey row exists: three.js 6 vs 7.5, TypeShade 3 vs 4 | A direct count of *web shader authors*. Cheap proxies already point low: `three-custom-shader-material` at 41,860/wk is **0.30%** of three.js core; `wgsl-linker` — the module channel a shader ecosystem would ride — measures **2/wk** `[V]`. One added survey question replaces all seven non-React estimates |
| D4 | **C10 for TypeShade (5/6/7)** — its only above-median criterion, and the entire claimed differentiator | 5 ("a proof nobody outside can run is not yet a differentiator") vs 6 (uniqueness claim refuted) vs 7 (highest non-React score; but it proves *consistency*, not rendered correctness, and the oracle itself carried 4 undetected semantic defects) | Publish the divergence corpus and the host × adapter × backend matrix, and see whether **one outside party runs it against their own shaders**. Binary, cheap, and the only thing in P50 that moves C10 to 8 |

### 2.6 Plain-language reading

**What 39.3 is.** A weighted average of ten judgements about *project fundamentals*. It says: as a piece of project design, TypeShade is roughly two-fifths as well-founded as React, and mid-table in a graphics-library peer set. That is defensible.

**What 39.3 is not.** (a) **Not a verdict on the code.** The three cells that sink the composite are unanimous across three lenses — distribution 1, execution capacity 2, network effects 2 — and none is about the compiler. The one criterion that *is* about artifact quality, C10, is TypeShade's best score and the highest non-React score in that column. (b) **Not a measure of world impact** — column C is, and there TypeShade is 0.083 while **PixiJS**, with 920,303 weekly downloads and 168 funders, is 0.45. A model that puts a successful decade-old graphics library at "0.45 out of 100" is describing React's scale, not PixiJS's worth. Read column C as *share of developer attention*, never as merit. (c) **Not a single forecast** — the same evidence gives 39.3 / 24.6 / 0.083. Use A to ask "is this well-founded enough to continue", B to ask "how much does this matter relative to things people have heard of", and never quote A alone in a launch or funding document. **The comparison that should carry the most weight is not React.** TypeShade at 39.3 sits below **TypeGPU at 55.5** and **PixiJS at 63.0** — the honest peer group. TypeGPU is ahead on distribution, funding and agent channel; it is *behind* on evidence quality, 5 to 6. That is the whole finding in one line: **a better-proven artifact losing to better-distributed ones, on axes that have nothing to do with the compiler.**

## 3. What would raise each number

**Credibility** (per-dimension, corpus-wide):

| Action | Dimension moved | Estimated delta | Cost |
|---|---|---|---|
| Human verification of the §1.7 top-10 | Independence 56 → ~75 | **+3 overall** | ~2 h |
| One outside-family maintainer reply (MapLibre/PixiJS/deck.gl/wgpu) on the beachhead premise | Independence, Verification | **+4 overall**, and settles C1/C2 | days of calendar, ~1 h of work |
| Delete the oracle-uniqueness sentence at SP:41, GTM:70 and messaging ×3; replace with "no substitute ships a higher-precision f64 reference" | Refuted leakage 57 → ~80 | **+3** | 15 min |
| Re-run the naga measurement with the de-duplication question explicit, and **publish the corpus and the command** | Reproducibility, Verification; settles D2 | **+2**, and reprices §3/§7 | ~1 h |
| Reprice SP §3's counterfactual and §7's option strike against the naga refund; add naga to GTM §2.2's incumbent table | Verification, Consistency | **+3** | ~2 h |
| Propagate D13 into SP §5.2/§6.4/KR2.1 and re-run GTM §1/§5 | Consistency 33 → ~55 | **+4** | ~3 h |
| One decision memo fixing: rung numbering, the adapter adoption bar, the Q1 gate, the investment split, `reflect()`'s caller count, the site's h2/blocks/mounts forks | Consistency | **+5** (largest single lever) | ~3 h |
| Publish the divergence corpus, and AE's verification record behind "8 of 42" | Verification, Independence, Sourcing; and C10 in §2 | **+3** credibility, **+1 C10** | ~1 week |

Ceiling with all of the above: **corpus ~85**. The single biggest constraint after that is Independence, which no amount of same-family work moves.

**Future value** (which move lifts which criterion, and what it unlocks):

| Move | Criterion | Delta | Scenario unlocked |
|---|---|---|---|
| Rung 0: tag 0.1.0, CI in the mirror, a resolving origin, npm publish | C7 1 → 3 | **+2.0 index** | Precondition for every scenario; blocked by no open decision |
| Ship one host adapter to a merged docs/skills PR | C7 → 4, C4 2 → 3 | **+1.5** | P50 |
| Publish the divergence corpus + host×adapter×backend matrix | C10 6 → 8, C3 3 → 4 | **+1.1** | P50; the only C10 lever that survives outsider review |
| WGSL/WESL ingestion of an admitted subset (sell the *checker*, not the language) | C1 3 → 5, C9 5 → 7, C3 → 5 | **+5.4** | **P90 — the largest single move in the model** |
| A ranked agent-skill listing (the 39.4× bundle premium `[A4]`) | C9 5 → 6, C7 → 4 | **+1.4** | P50 |
| A second publisher / any funding above bus-factor-1 | C6 2 → 4 | **+2.3** | P90 (removes the constraint every lens names) |
| Reprice the pitch off "porting" onto "checking", naming naga's 77% refund honestly | C2 5 → 6, C3 3 → 4 | **+1.1** | Protects P50 from the D2 refutation reaching a prospect first |

Note the shape: **C7 and C6 are the cheapest and the most expensive levers respectively**, and C1 — the heaviest weight — moves only via the admitted-subset spike. Everything else is worth ≤1.5 points.

## 4. Recommendation on the website build

**Do not start the site build now. Do rung 0 now, in parallel.** Reasons, in order of force:

| Blocker | Why it blocks the build specifically |
|---|---|
| Three refuted claims are still live in launch-facing copy | `02-messaging.md:51/:137/:190` (measured) carry the oracle-uniqueness line; `GTM:70` makes it the category-defining sentence. The corpus's own rule — "being caught once costs the proof positioning permanently" — applies hardest to a page whose only differentiator is proof |
| The site's build contract has three unresolved forks | §write's h2 ("Ten lines." vs "One function."), the block count and id (7/`recognise` vs 8/`whowrites`), and the mount count (4 vs 5, with no caption or accessible name for the fifth). These are not wording nits — slot ids *are* the contract, and a builder today has two documents each claiming final authority |
| The beachhead is undecided in effect | D13 chose PixiJS; GTM's whole 20-week sequence and every partner message point at MapLibre. No copy prints a host name, but the schedule the deck cites does |
| One deck fact is already stale | `07-copy-deck.md:5` (measured) rests its authority on `ecosystem-embedding.md` being absent; the file exists, 96,980 B, 27 minutes newer |
| A hand-entered number passed two verification passes | "2.9 KB" against 2.1 KB measured, on a build route (`hero.emit`) that does not exist. Any figure whose stated route is unwritten must be treated as unverified until the route exists and the assertion fires |

**What to do instead, in this order.** (1) **Rung 0 today** — tag `0.1.0` against `api-surface.test.ts`, move the two compile gates into the mirror's own CI, publish, point `typeshade.dev` at something. It is worth +2.0 index points on its own, it is the precondition for all three scenarios, and **no open decision blocks it**. (2) **A one-page decision memo** closing C1–C7 and C13–C15 (~3 h) — this alone moves consistency 33 → ~55. (3) **The admitted-subset spike** — because if first-try admission is under ~60%, the page should describe a *checker*, not a *language*, and building the current copy first means building it twice.

**Then build.** The design research (`01-research`) reproduced at 15/16 and is not the problem; the copy's *facts* are. With the memo and the corrections applied, the build is a day of work against a settled contract rather than a week of work against a moving one.

## 5. Sources

**Measured in this container, this pass** (all commands run from `/home/user/X-GIS`):
`git log -1 --format='%H %ci'` · `git branch --show-current` · `wc -l docs/plans/2026-09-07-typeshade-*.md` · `ls -la --time-style=+%H:%M docs/plans/2026-09-07-typeshade-*.md` · `sed -n '41p;468p' …strategic-plan.md` · `sed -n '70p' …go-to-market.md` · `grep -c "agent-era" …strategic-plan.md …go-to-market.md` (→ 0, 0) · `grep -c "naga" …strategic-plan.md` (→ 10) `…go-to-market.md` (→ 0) · `grep -c "94%" …` (→ 3, 1) · `find map/src/shaders/dsl -name '*.ts' ! -name '*.test.ts' | wc -l` (58) and `-exec cat {} + | wc -l` (14063) · `grep -rl "shader-dsl" map/src compiler/src --include=*.ts | wc -l` (144) · `cat map/src/shaders/baked/*.generated.ts | wc -c` (878943) · `find shader-dsl -name '*.test.ts' | wc -l` (146) and `shader-dsl/src` (135) · `wc -l shader-dsl/AUTHORING.md` (1608) · `python3` over `shader-dsl/package.json` (no dependency key; 0.0.1, MIT, `@xgis/shader-dsl`) · `sed -n '30p' shader-dsl/README.md` ("13 direct callers") · `grep -n '^## ' shader-dsl/src/__api__/surface.md` (366 exports) · `sed -n '37p' shader-dsl/src/api-surface.test.ts` · `git -C <mirror> rev-parse --short HEAD` (29c9614) and `ls -a <mirror>` (no `.github`) · `sed -n '5p' <site>/docs/design/07-copy-deck.md` · `grep -n "no comparable library" <site>/docs/design/02-messaging.md` (:51, :137, :190) · `naga --version` (30.0.1).

**External URLs, all fetched 2026-09-07 by the audits** (relayed, not re-fetched by me): khronos.org/blog/shader-ecosystem-survey-results-2026 · arxiv.org/abs/2504.09246 and /pdf/ · arxiv.org/abs/2407.09726 · deck.gl/docs/developer-guide/webgpu and /fp64 · maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/ · github.com/maplibre/maplibre-gl-js/issues/7640, PR #8290, releases/tag/v6.0.0 · pixijs.com/8.x/guides/migrations/v8 · github.com/pixijs/pixijs discussion 11027 · opencollective.com/pixijs · docs.swmansion.com/TypeGPU/ and /ecosystem/typegpu-gl/ · luma.gl/docs/api-reference/shadertools/shader-modules/fp64 · github.com/brendan-duncan/wgsl_reflect · github.com/CesiumGS/cesium/issues/4989 · gitclear.com/the_ai_code_quality_maintainability_gap · caseyrb.com/blog/state-of-llms-txt-adoption/ · seranking.com/blog/llms-txt/ · ahrefs.com/blog/llmstxt-study/ (the source AE should have cited) · sacra.com/c/coderabbit/ · devclass.com/2026/01/08/… (404 from one container; substance corroborated elsewhere) · caniuse.com/webgpu · spdx.org/licenses/Bison-exception-2.2.html · registry.modelcontextprotocol.io/v0/servers · api.npmjs.org/downloads/point/… · registry.npmjs.org/… · skills.sh/api/search · react.dev, mui.com, tailwindcss.com, vgpu.sh, slashdata.co, survey.stackoverflow.co/2025/technology.

**Repository artifacts cited by file:line:** `docs/plans/2026-09-07-typeshade-{strategic-plan,go-to-market,ecosystem-embedding,agent-era-strategy}.md` · `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` · `shader-dsl/{package.json,README.md,AUTHORING.md,CHANGELOG.md}` · `shader-dsl/src/{api-surface.test.ts,__api__/surface.md,core/ir/nodes.ts}` · `map/src/shaders/{dsl,baked}` · `playground/e2e/_{wgsl,glsl,emit-obfuscate}-*.spec.ts` · `.github/workflows/test.yml:1375` · site tree `docs/design/{00-brief,01-research,02-messaging,04-ia-wireframe,07-copy-deck}.md` · pinned mirror `vendor/shader-dsl` at `29c9614`.

**Declared `(from memory)`:** none. Every figure above carries a URL with fetch date, a file:line, a `measured:` command, or an explicit `derived:` arithmetic note. **Declared not re-run by me:** all external fetches, the naga sweep, the WebGL2 compile leg, and the emit-timing benchmarks — each is relayed with its audit label.
