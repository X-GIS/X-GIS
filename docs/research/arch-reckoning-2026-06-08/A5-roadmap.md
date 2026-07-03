# A5 — The Blender-DNA Roadmap: Neutral Extraction + Why Execution Stalled

**Axis:** The existing Blender-DNA architecture roadmap (`architecture-roadmap-blender-2026-06-04.md`) — neutral extraction of the DECISION so others can challenge it, plus a diagnosis of why it has not executed.

**Sustainability verdict (5yr, this axis): 2 / 5.** The decision is intellectually coherent and the cheap half partially shipped, but the roadmap's own headline promise (god-file decomposition via EvaluatedTile/TileUploadService) is 0% done, the "5 authorities" are 1.5 of 5 real in code, and the execution record since 2026-06-05 is _audits about the plan_, not the plan. A roadmap that 3 days after authoring produces 12 new research docs and 0 of its 6 hard increments is a roadmap that has already stalled.

Method note: every code claim below is `file:line` or a `git`-verified fact. FACT = read in the tree today; INFERENCE = reasoned from evidence and labeled.

---

## Part 1 — NEUTRAL EXTRACTION (the decision, steelmanned)

This is the roadmap as it stands so others can attack it. I am not defending it here; Part 3 does the attacking.

### 1.1 The 5 authorities (the architectural spine)

Source: roadmap §0.3 and §3 (authority diagram, lines 105–157).

| #   | Authority                                           | Owns                                                                                                                                              | Module (planned)                              |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| A1  | **`projections-table.ts`** (TABLE authority)        | poleLimit / center-representation / world-band / sphere-routing / view-height — every projType-conditioned policy. "rows = DNA; accessors = RNA". | `projections-table.ts` (existing, +accessors) |
| A2  | **OperatorBus** (MUTATION authority)                | The ONLY thing that mutates authored state AND the ONLY thing that tags dirty. `applyOp(target,op):DirtyDomains`. Enables op-log/undo/test.       | `ops/operator-bus.ts` (NEW)                   |
| A3  | **DirtyDomains** (INVALIDATION authority)           | What each per-frame consumer must recompute vs reuse. 8-domain bitset {CAMERA,VIEWPORT,PROJECTION,STYLE,SOURCE,GEOMETRY,LABEL,CLOCK}.             | `state/dirty.ts` (NEW)                        |
| A4  | **EvaluatedTileGeometry** (GEOMETRY-EVAL authority) | Per-tile evaluated mesh + attribute layers; the 3 render families (fill/line/point) collapse to "same evaluated record through a family adapter". | `geometry/evaluated-tile.ts` (NEW)            |
| A5  | **shader-DSL** (SHADING authority)                  | byte-equal-gated IR→WGSL emitter — **explicitly LEFT ALONE** (the "good part").                                                                   | `shader-dsl/**` (untouched)                   |

The data-flow contract (§4, lines 160–185) is a strict one-direction pipeline:
`input(Op) → OperatorBus.applyOp → SceneState/CameraState → DirtyDomains → eval(COW/WeakMap) → EvaluatedTileGeometry → shader-DSL → GPU`, **"one direction, no back-edges."**

### 1.2 The 21 increments S0–S20 (inert vs behavior-change)

Source: roadmap §1 table (lines 22–44). The deliberate ordering principle: **inert substrate first, behavior changes last, each behavior change matrix-gated.**

**Read-only enumeration (S0–S1)** — produce ground-truth ledgers because the file-maps had stale line numbers:

- **S0** — enumerate clamp sites (grep BOTH `MERCATOR_LAT_LIMIT` const AND bare `85.051129`), produce STORAGE-vs-POSITION routing ledger.
- **S1** — audit direct `invalidate()`/`_needsRender` writers across 18+ files, produce funnel-coverage ledger.

**INERT increments (behavior byte-identical, marked `inert:true`):** S2 (table accessors), S3 (DirtyDomains write-only wrapper), S4 (OperatorBus pure indirection, tags ALL), S5 (route confirmed clamp sites — cylindrical poleLimit≡85.051129 so byte-identical), S7 (leave-list grep-guard), S8 (extract SceneState/CameraState behind same accessors), S9 (extract view-matrix.ts), S19 (extract quantize-ecef + vertex-formats, delete 3 copies). S6 inert if all-LEAVE; S15 is test-infra-only.

**BEHAVIOR-CHANGE increments (`inert:false`, each gated by a NEW matrix cell):**

- **S10** — activate centerLatDeg; sphere/natural-earth read it; relax sphere clamp to poleLimit. Gate: globe centered lat 89 renders pole at screen center.
- **S11** — zoom-anchor write reconciliation (the 8+ direct centerX/Y arithmetic sites funnel through SetCenter).
- **S12** — globe orbit drag via centerLatDeg, drop hard ±85 clamp. Gate: drag globe past 85° → pole rolls in.
- **S13** — true arcball anchor drag + `unprojectToLonLat` non-null for projType 3/4/5/7. Gate: click globe point → reported lon/lat matches.
- **S14** — DirtyDomains become granular (tag SPECIFIC domains not ALL); SOURCE-epoch bump on upload/evict.
- **S16** — label-pass `_dispatchSig` measure→skip gated by `consume(LABEL)` clean (FrameArena handle-cache variant).
- **S17** — fill-pattern + projection-resolve skip gated on CAMERA|PROJECTION clean.
- **S18** — scene-classification reuse on pure-pan.
- **S20** — add `evaluated-tile.ts` + `tile-upload-service.ts`; flip `doUploadTileAsync`/`doUploadTile` to evaluate+upload; preserve OOM net + arena UAF ordering. **This is the god-file decomposition — the headline.**

### 1.3 Matrix-gating

Source: §1 ("gating matrix cell" column), preamble (lines 3–5), Risk #9 (line 198).

The gate is `playground/render-verify/` — a **real-GPU, no-baseline, oracle-based** matrix net (frame-stability + post-change + per-family ink + disc_fraction + finite-MVP cells). The roadmap's stated leverage: this net **"already exists,"** so increments can be "aggressive" because every behavior-changing step has a specific cell that must stay/turn green. **CRITICAL constraint (Risk #9):** CI is no-GPU SwiftShader and **cannot see ink** — so none of S10–S20 may be claimed done on unit tests alone; the LOCAL real-GPU matrix is the only valid gate.

### 1.4 Human-call gates (6 deferred decisions)

Source: §6 (lines 203–212). These are flagged as genuine product/architecture judgments that could NOT be resolved from the seeds:

1. **natural_earth(2) center-storage class** — `lat-deg` (consistent with poleLimit=90) vs `mercator-y` (consistent with its pan math). Recommended `mercator-y`. **Must confirm BEFORE S10.**
2. **Arcball storage (S13)** — convert delta to lon/lat each step vs add orbit-quaternion field.
3. **Public `getCenter()` >85.05 contract** — ship uncapped (correct, possible downstream surprise) vs compat-cap the public getter.
4. **Op-log boundedness / easeTo-as-ops** — coalesce camera ops vs full ring-buffer; easeTo/flyTo real-ops vs imperative.
5. **DirtyDomains SOURCE→GEOMETRY granularity** — source push always implies GEOMETRY rebuild (safe) vs independent.
6. **azimuthal_eq(4)/stereographic(5) z0 framing** — `flatViewHeightCapM` caps only ortho(3); 4/5 unsettled.

The MEMORY index records "6 human-calls (natearth(2) center-class BEFORE S10)."

### 1.5 Rationale (the steelman)

Source: preamble + §5 risks + the two why-hard / rendering-audit research docs.

The roadmap is the synthesis of an **adversarial 4-track workflow** (4 maps → 4 designs → 4 critiques → synthesis); every track's standalone design returned `decided=false`, and the synthesis claims to RESOLVE each objection inline (stale line numbers → S0/S1 read-first; FrameArena cross-frame → handle-cache variant; quantize/ecef → 2-kernel split; zoom-anchor fan-out → dedicated S11). The intellectual grounding is genuinely strong: the two companion docs (`2026-06-runtime-architecture-why-hard.md`, `2026-06-rendering-architecture-audit.md`) tie the design to Blender's depsgraph (typed `ID_RECALC_*` tags ≈ DirtyDomains), draw-manager (evaluated-vs-draw seam ≈ EvaluatedTile), and the Frostbite render-graph coupling case study — all primary-sourced. **The diagnosis is correct: a monolithic `_needsRender` boolean structurally hides under-invalidation bugs, and fused eval+draw makes every render feature expensive.** That part is not AI hand-waving; it is well-cited (browser.engineering, Blender headers, Frostbite GDC 2017).

---

## Part 2 — WHAT ACTUALLY SHIPPED (FACT, verified in tree today)

### 2.1 The "10 NEW modules" — 4 of 10 exist, and the wrong 4

The roadmap §2 promised 10 NEW modules. Verified by glob today:

| Planned module                    | Increment      | Exists?        | LOC |
| --------------------------------- | -------------- | -------------- | --- |
| `ops/operator-bus.ts`             | S4             | ✅             | 27  |
| `ops/op-types.ts`                 | S4             | ✅             | 18  |
| `state/dirty.ts`                  | S3             | ✅             | 49  |
| `projection/view-matrix.ts`       | S9             | ✅             | 269 |
| `projection/unproject.ts`         | (S13-adjacent) | ✅             | 142 |
| `state/scene-state.ts`            | S8             | ❌ **MISSING** | —   |
| `projection/camera-state.ts`      | S8             | ❌ **MISSING** | —   |
| `geometry/evaluated-tile.ts`      | S20            | ❌ **MISSING** | —   |
| `render/tile-upload-service.ts`   | S20            | ❌ **MISSING** | —   |
| `geometry/tile-uniform-layout.ts` | S20            | ❌ **MISSING** | —   |
| `@xgis/shared/quantize-ecef.ts`   | S19            | ❌ **MISSING** | —   |

**FACT:** the 4 shipped modules total **505 LOC** (`dirty 49 + operator-bus 27 + op-types 18 + view-matrix 269 + unproject 142`). The 6 missing modules are exactly the ones that carry the _decomposition_ — SceneState/CameraState (S8), EvaluatedTile + TileUploadService (S20), quantize-ecef dedup (S19). **The substrate landed; the payload did not.**

### 2.2 The god-files GREW. They did not shrink.

This is the single most damning fact. The roadmap's purpose (§0.2) was "God-file targets: `vector-tile-renderer.ts` (~5600) → ...; `map.ts` (~2827) → ...; `camera.ts` (~2827) → ...".

| File                      | Sustainability audit (2026-05-30) | **Today (FACT, `wc -l`)** | Delta           |
| ------------------------- | --------------------------------- | ------------------------- | --------------- |
| `vector-tile-renderer.ts` | 5298                              | **5440**                  | **+142**        |
| `map.ts`                  | 2827                              | **3431**                  | **+604 (+21%)** |
| `camera.ts`               | 1051                              | **1087**                  | +36             |

**FACT:** `map.ts` grew by 604 lines — partly _because of_ this roadmap (the OperatorBus dispatch-alongside calls, dirty-tagging helpers, and globe centerLatDeg wiring were ADDED to map.ts/camera.ts, not extracted out). The roadmap that exists to shrink the god-files made the worst one 21% bigger. S19/S20 (the only increments that DELETE from VTR) never ran.

### 2.3 The "5 authorities" — only 1.5 are real

- **A1 `projections-table.ts` (TABLE):** ✅ accessors added (S2, commit `a53fa336`); `poleLimit`/`representsCenterAs` exist and are consumed (camera.ts 19 uses, camera-controller 11 uses of `centerLatDeg`). **Real (~1.0).**
- **A2 OperatorBus (MUTATION):** ⚠️ **PARTIAL/FALSE.** The roadmap defines it as `applyOp(target,op):DirtyDomains` — "the ONLY thing that mutates authored state." The actual code (`operator-bus.ts:14`) is `dispatch(op, domains): void` and the comment says verbatim **"The setter performs the actual field mutation itself (dispatch-alongside)."** FACT (map.ts:765): `setCenter(lon,lat){ this.cameraController.setCenter(lon,lat); this._ops.dispatch({kind:'SetCenter',...}, DirtyDomain.CAMERA) }`. It mutates via the controller AND logs to the bus in parallel. **It is a side-log, not a mutation authority. ~0.4.**
- **A3 DirtyDomains (INVALIDATION):** ⚠️ **mostly write-only.** `dirty.ts` exists (49 LOC), but `consume()` has exactly ONE production consumer: `consumeLabelDirty()` (map.ts:454, read by label-pass.ts:271). Everything else only `tag`s. `invalidate()` still tags `DIRTY_ALL` (map.ts:436). S14 added granular tagging at the bypass sites (commit `b6a2b82f`) but the bitset drives ONE skip. **~0.4.**
- **A4 EvaluatedTileGeometry (GEOMETRY-EVAL):** ❌ **does not exist** (no `evaluated-tile.ts`, no `tile-upload-service.ts`). **0.0.**
- **A5 shader-DSL (SHADING):** ✅ left alone, as designed. **1.0 — but this required no work; "we didn't touch the good part" is not progress.**

**Net: ~1.8 of 5 authorities are real, and the two that needed the most code (A2 mutation funnel, A4 eval seam) are the two that are fake/absent.**

### 2.4 S19 not done — the 3 copies are still 3 copies

**FACT:** `quantizeAxis`/`tileEcefCenterFromMerc` still appears in `runtime/.../vector-tile-renderer.ts`, `runtime/.../synthetic-earth-surface-backend.ts`, AND `compiler/src/tiler/vector-tiler.ts` (+ test/helper files). The S19 "delete the 3 copies, consolidate into `@xgis/shared`" is not done. The CPU↔GPU drift bug-class root that the sustainability audit ranked #1 is untouched.

### 2.5 What DID land (the honest credit)

git log (verified) shows real, well-gated work on the **cheap/inert + globe** half:

- S2 table accessors (`a53fa336`), S3 dirty wrapper (`cdc245c1`), S4 OperatorBus + 3 cold setters (`8bc3f72f`), camera+paint through bus (`71a02a66`).
- **S10–S13 globe centerLatDeg** — a genuinely useful cluster: reach-the-pole (`e4c36973`), drag rolls to pole (`b702fba1`), preserve pole-ward centre through zoom (`5edb29d5`), with matrix guards (`0a513053`). centerLatDeg is wired (camera-controller 11 / camera.ts 19 uses). This is the most substantive shipped behavior change.
- S9 view-matrix + S13 unproject extraction (`60e26402`, `134a81d9`).
- S14 granular tagging (`b6a2b82f`), S15 frame_stability + post_change oracles (`0587c2b1`, `641fc80a`), S16 label skip (`ae65eb92`) + its staleness fix (`c2ca9842`).

This is roughly **S2, S3, S4(partial), S9, S10–S13, S14, S15, S16** — ~9–10 of 21, all on the side that adds ≤300-LOC modules or touches the camera. **Zero of S17, S18, S19, S20** — every increment that decomposes a god-file or deletes duplication.

---

## Part 3 — WHY IT STALLED (the diagnosis)

### 3.1 The "started but deferred as too risky" pattern — proven by the commit timeline

**FACT (git log, date-ordered):**

- **2026-06-04** — roadmap authored.
- **2026-06-05** — one concentrated burst: ~8 increment commits (S2–S4, S9, S10–S13, S15).
- **2026-06-08** — S14 + S16 + S16-staleness (3 increment commits), then **12 `docs(research)` commits in a single day** re-auditing the architecture.

The last 25 commits are **12 docs vs 10 feat/fix**. The most recent 13 commits (2026-06-08) are: 2 feat/fix (S16 + its bugfix) and **11 research/doc commits**. The branch is named `claude/invalidation-perf-phase-*` yet `git diff --stat main...HEAD` on the actual source touches only label-pass/icon-stage/text-stage (~383 insertions) — i.e. the _only_ uncommitted-to-main source delta is S16-family. **The session pivoted from building the roadmap to auditing it.**

### 3.2 The increments stopped exactly at the risk boundary

Order the shipped increments by the roadmap's own `inert` flag and risk ranking:

- Everything that shipped is either `inert:true` (S2/S3/S4/S9), test-infra (S15), or a _localized camera change_ with a single new matrix cell (S10–S13, S16).
- **Everything that did NOT ship is either (a) a god-file decomposition (S8 SceneState/CameraState, S20 EvaluatedTile/TileUploadService) or (b) a cross-package deletion (S19 quantize-ecef).**

The roadmap's own §5 ranks 5 HIGH risks tied to the unshipped work: zoom-anchor funnel falsity (S11 — note S11 is arguably the weakest-landed of the globe set), FrameArena cross-frame retain (S16 — shipped but immediately needed a staleness hotfix `c2ca9842`, confirming the risk was real), and **poly-arena GPU UAF regression (S20)**. The session shipped up to the wall, hit the S16 staleness bug that proved the risk model right, and then **retreated into a fresh 9-track audit** rather than crossing into S20's "TileUploadService extraction must preserve a specific compaction-vs-upload ordering or you get a UAF" territory. INFERENCE (well-supported): S20 was deferred _because it is genuinely dangerous and CI can't catch the failure_ (Risk #5 + Risk #9), and producing audits is lower-risk dopamine than attempting it.

### 3.3 The audit-loop is itself the anti-pattern

This is the meta-finding the owner will care about most. The roadmap was produced by an adversarial multi-AI workflow on 2026-06-04. By 2026-06-08 a DIFFERENT 9-track audit (`2026-06-rendering-architecture-audit.md`) was produced — which **re-derives the same Blender destination** ("the invalidation work S3/S14/S16 is already Blender's depsgraph; the next leaps are relations-based invalidation... CoW... EEVEE frame graph") AND **partially re-scopes the roadmap** toward reversed-Z + RTC f64-matrix as the new "Tier 1," which are NOT in the S0–S20 sequence at all. So the codebase now has:

- One DECIDED roadmap (S0–S20) that is ~45% executed and stalled at the hard part.
- A second remediation plan that re-prioritizes toward depth/precision work the first plan deferred.
- A `MEMORY.md` that is **over its size limit** (27.3KB vs 24.4KB cap — system warning in-context) with 60+ index entries, i.e. the research output is now actively degrading the working memory it lives in.

**INFERENCE (high confidence): the project has a research-to-execution ratio inverted.** Three consecutive sessions of architecture audits (sustainability 05-30, why-hard 06-08, rendering-audit 06-08, plus 10 numbered sub-audits) have produced thousands of lines of cited analysis and ~500 LOC of shipped substrate. The roadmap is not failing for lack of a plan; it is failing because **planning is the comfortable activity and S20 is the uncomfortable one.**

---

## Part 4 — WHERE THE ROADMAP READS AS AI OVER-ENGINEERING (per task mandate)

I was asked to flag every place the prior AI session over-built or over-specified. Honestly:

1. **5 "authorities" is taxonomy theater.** Naming `OperatorBus` a "MUTATION AUTHORITY" and `DirtyDomains` an "INVALIDATION AUTHORITY" in a 6-box ASCII diagram (§3) reads like architecture-astronaut formalism. The code that resulted (A2) is a 27-line side-logger that doesn't even mutate. The grand authority diagram describes a system that **does not exist and is 0% built for 2 of its 5 boxes.** A senior engineer would have written "route setters through one funnel, add a dirty bitset" in two sentences.

2. **21 increments is over-decomposition.** S5/S6/S7 are three increments to _route lat clamps and then grep-guard that you routed them_ — much of which S0's ledger already establishes. S2 ships two accessor functions as its own gated increment. The fine-graining is defensible-on-paper (each is matrix-gated) but it manufactures 21 ceremony-bearing steps where ~8 real units exist (table-SoT, dirty bitset, op funnel, camera-state extract, globe-drag, VTR decomp, quantize dedup, label-skip). **INFERENCE:** the 21-step granularity is the AI optimizing for "a satisfying ordered list," and it correlates with the failure — the easy 13 got done, the hard 8 didn't, and the granularity _hid_ that the project was only doing the easy ones.

3. **"DNA/RNA", "Blender-DNA" framing is borrowed grandeur.** The Blender depsgraph analogy is legitimate and well-sourced, but "rows = DNA; accessors = RNA" (§3 line 110) and naming the whole effort "Blender-DNA Unification" is motivated reasoning — it lends a 4-day-old plan the authority of a shipped 20-year engine. The companion why-hard doc even admits the trajectory is "the direction S14/S16 already point" — i.e. the Blender framing is post-hoc narration over two small commits.

4. **The 6 "human-call" gates are partly manufactured deferral.** natural_earth(2) center-class (call #1) genuinely needs a decision, fine. But "op-log boundedness / easeTo-as-ops" (call #4) and "arcball quaternion vs lon/lat" (call #2) are decisions the implementer should just _make_ with a one-line default; flagging them as blocking human-calls is a way to look thorough while deferring. Note the bounded op-log was in fact just built (`MAX_LOG=256`, operator-bus.ts:10) without the "human call" — proving the gate was unnecessary.

5. **The matrix-gate leverage is partly aspirational.** The roadmap leans hard on "the matrix net already exists" to justify aggressive increments, but the rendering audit (same session, 4 days later) admits flat synthetic fills render 56.75% under SwiftShader while **the same geometry extruded renders 0.00%** — i.e. the matrix gate is blind to the extrusion path S20 must preserve. The gate the roadmap trusts to make S20 safe **cannot see S20's highest-risk surface.** The plan over-trusted its own safety net.

### What is genuinely good (one line each, with evidence)

- **The core diagnosis is correct and well-sourced** — monolithic `_needsRender` hides under-invalidation; the S16 staleness bug (`c2ca9842`) is a real instance that proved it (why-hard doc §1, primary-cited).
- **The S0/S1 read-first correction is sound engineering** — it caught that camera.ts:975/1088 are raw `85.051129` literals not the named const (Risk #1); grounding before routing is the right instinct.
- **The globe centerLatDeg cluster (S10–S13) actually shipped and is useful** — "reach the pole" is a real capability the old Mercator-Y storage blocked.

---

## Part 5 — THE RECKONING (for the challenge sessions)

The roadmap is **not wrong, it is unfinished in the way that matters**: it solved the parts that were already low-risk and inert, narrated them with Blender grandeur, and stopped at the god-file decomposition that was the entire justification for writing it. The god-files are bigger than when the plan was written.

The questions the challenge sessions should press:

1. **Is S20 (EvaluatedTile/TileUploadService) ever going to be attempted, or is it permanently parked behind "too risky for CI"?** If the matrix can't see the extrusion path, what _would_ make S20 safe to attempt — and why isn't building THAT the next increment instead of more audits?
2. **Should the 5-authority/21-increment formalism be collapsed to ~8 plain units?** The granularity demonstrably let the project ship the easy 60% and call it progress.
3. **Why is OperatorBus a side-log instead of the mutation funnel it was specified as?** Either make it the funnel (real A2) or stop calling it an authority.
4. **The research-to-execution ratio is inverted.** Three audit sessions, ~500 LOC shipped, MEMORY over its cap. The next session should be forbidden from writing a new `.md` until S19 (delete 3 copies — mechanical, low-risk, closes the #1 drift bug-class) is committed.

The plan's most honest sentence is its own Risk #9: _none of the behavior changes may be claimed done on unit tests alone._ By that standard, S20 was never even attempted — so there is nothing to claim. The roadmap didn't fail at execution; **execution barely started, then the session went back to planning.**
