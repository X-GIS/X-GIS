# engine ↔ map rebalance — program plan (2026-07-27)

> **Architect-pass deliverable** (per the `author-architect-refactor` skill — **no code changes
> land with this doc**). It answers one question: _"the engine package has become emaciated —
> nearly everything lives in map; how do the code and architecture improve?"_ — with a measured
> diagnosis and a sequenced program.
>
> **Authority map (what this doc is NOT).** Phase specifications stay where they live:
> EPIC **#991** + `engine-substrate-migration-991.md` own the P0–P8 promotion specs; **#1046**
> owns the twin-frame elimination F-phases; `package-responsibilities.md` owns the package
> charters; `engine/src/dependency-direction-ratchet.test.ts` owns the edge list. This doc
> owns only (a) the program-level diagnosis, (b) the **sequencing across** those efforts,
> (c) wave-2 promotion _nominations_, (d) the map-internal decomposition track, and (e) gate
> hygiene. Duplicating the phase specs here would itself be the two-authorities trap
> (`2026-07-14-the-second-ratchet.md`).

---

## 1. Grounded current state (measured 2026-07-27, this tree)

| Fact | Evidence |
| --- | --- |
| `engine/src` = **1,999 LOC across 10 source files**; `map/src` = **76,660 LOC across 251 files** (engine ≈ 2.6% of map). | `find`/`wc` over non-test `*.ts` |
| Engine content: RHI re-export + `GPUArena`(514) `quality`(325) `Material`(249) `UniformBlock`(236) `FrameArena`(233) `UniformRing`(164) `overdraw-compose`(121) `RenderContext`(59) `log-depth`(43). | `engine/src/index.ts` |
| Map's dependency on engine-**owned** code ≈ **1,944 LOC / 9 modules** — narrow but deep: `Material`/`executeItems` in 18 files, `uniformBlock` in 11, `quality` in ~20. Most "engine" imports are actually `@xgis/rhi` types passing through the barrel (`RhiDevice` in 39 files). | import census over `map/src` |
| **#991 landed P0-enforcement + P1 + P2 only.** Net map→engine transfer ≈ **413 LOC** (`material.ts` 249 + `uniform-ring.ts` 164) against a **77-finding** audit. P3–P8 unexecuted; last EPIC activity 2026-07-13. | #991 comments; `engine/src/index.ts` |
| **Regression under the stall:** raw-WebGPU baseline **555 tokens/44 files → 575/48** (growth annotated "gap-blocked until #991 P6/P7" — which never came); backend-identity **38 → 46** (`fdcb3a1` 2026-07-14 → today, growth log in the test header). | `map/src/raw-webgpu-ratchet.test.ts:101`; `map/src/backend-identity-ratchet.test.ts:10-46` |
| **The WebGL2 twin frame is alive**: `renderFrameViaRhi` (~357 LOC in `render-loop.ts:875`) + the `render-loop.ts:242` fork. #1046 F1–F3a merged; `RHI_TWIN_MISSING` is down to `['oit','overdraw-compose']`. The twin's real-world cost is documented (#1040/#1041/#1044 — all twin-only defects). | `map/src/render/passes/pass-order.ts:39`; #1046 |
| God files: `map/src/map.ts` **5,330 LOC** (129 field-like + 178 method-like members, 98 imports from 68 modules; `_runProgram` 773 + `rebuildLayers` 594 = 26% of the file); `vector-tile-renderer.ts` **4,740** (largest LOC-ratchet ceiling). | member census; `map/src/loc-ceiling-ratchet.test.ts` |
| **No layer-direction gate exists inside `map/src`** — Gate 5 (L0–L4 spine) was dropped 2026-07-27 as vacuous-since-P3, "reviving it needs a layer charter written for today's `map/src`". | `map/src/architecture-invariants.test.ts:13-18` |
| **Two live projType authorities, already drifted**: arch-invariants Gate 4 (11 files / 27 total, ceiling semantics, comments **not** stripped) vs `projtype-confinement-ratchet.test.ts` (9 files, strict-equal both directions, comment-stripped). Gate 4's two extra entries are **comment-only matches** — the comments at `render/under-occluder-renderer.ts:203` and `shaders/dsl/raster.ts:169` that _warn against_ raw `projType === 7` are themselves counted as violations. | both test files; verified by comment-stripped recount |
| Stale meta: `engine/src/index.ts:38,45-47` still document two re-export shims (`map/src/render/material/material.ts`, `map/src/render/uniform-ring.ts`) **deleted** in the runtime dissolution (`176d494`); `docs/architecture/MODULES.md` §2–§5 self-marked STALE. | on-disk check |

## 2. Diagnosis — three forces, one stall

**2.1 Deliberate evacuation (correct — keep).** Half of the engine's thinness is the intended
outcome of the luma.gl/deck.gl carve (`engine-content-split.md`): #781 evicted geo (camera
2,485 LOC → map, projections → `@xgis/geo`), #929 C evicted even the projection _vocabulary_,
#991 P0 moved the frame-uniform schema out. Gate 6/7 lock this. The one attempt to keep geo in
the engine (#714) was evacuated (#715). **Re-filling the engine with content to fix the LOC
ratio is not on the table.**

**2.2 Stalled promotion.** The other half is that the reverse flow — #991's promotion of the
content-blind substrate _out of_ `map/src/render/**` _into_ the engine — stopped after P1/P2.
The audit says ~77 candidates; 2 moved.

**2.3 Sanctioned mean-reversion.** The Architecture Reckoning's R1 ("without a ratchet, every
decomposition reverts to the mean") is live in a subtler form: the ratchets exist, but their
baselines were legitimately **grown** under "gap-blocked until P6/P7" rationales while P6/P7
never landed. The enforcement is green; the architecture is regressing inside the allowance.

**The metric that matters.** Engine health is not engine LOC — it is **the share of map's GPU
touches that route through engine/RHI primitives**. The inverse is already mechanically
measured: the raw-WebGPU baseline (575 tokens today). **This program's definition of "the
engine actually does things" is that number reaching `{}` — at which point every frame, pass,
pipeline, upload, and readback in the product flows through engine-owned machinery,
regardless of how many lines the engine package holds.**

---

## 3. Track A — finish what is already designed (critical path)

Nothing in this track needs new design; each row names its owning authority and its
**mechanical** exit criterion. Order respects the dependency DAG in
`engine-substrate-migration-991.md` §2.

| # | Work | Owner / spec | Exit criterion (mechanical) |
| --- | --- | --- | --- |
| A0 | **Baseline growth freeze.** No raw-WebGPU / backend-identity baseline increase merges without a linked issue justifying why it cannot route through RHI today. (Policy; enforced by review + the ratchets' existing rationale-comment convention.) | this doc | baselines monotonically ↓ from 575 / 46 |
| A1 | **#1046 F3b–F6** — retype `FrameContext.encoder/…View` to `RhiCommandEncoder`/`RhiTextureView`, retype pass bodies + `ShowDrawFn`, flip `_chainRunsOnWebgl2`, port `['oit','overdraw-compose']`, **delete `renderFrameViaRhi` + the `render-loop.ts:242` fork**. This _is_ #991 P4 (G2/G3) by another name — F3b's retype list and P4's are the same sites. | #1046 (F-phases), #991 P4 | `RHI_TWIN_MISSING == []` then the constant deleted with the twin; fork block gone; backend-identity baseline ↓ toward 0; twin-parity ratchet retired |
| A2 | **#991 P5** — `RenderNode` scheduler + `FullscreenComposePass` (collapses the 4 copy-pasted compose bodies + offscreen-line composite) + `RenderToTexturePass`/`bakeToTexture` → `@xgis/engine`. This is the milestone where the engine owns the render graph — the substrate's raison d'être. | #991 P5; `render-graph-pass-scheduler.md` | **#599 drape imports `bakeToTexture` from `@xgis/engine`**; 4 compose sites call one helper; `execute` takes an engine-typed ctx (never `FrameContext`) |
| A3 | **#991 P6** — pipeline/resource **creation mechanism** → `rhi.*` (~150 sites; classes stay in map). Largest baseline rows burn here: `pipeline-factory.ts` 85, `renderer.ts` 60, `frame-renderer.ts` 47. Needs G1/G9/G11. | #991 P6 | raw-WebGPU baseline ↓ by the P6 site set; per-cluster byte-identical renders |
| A4 | **#991 P3 / P7 / P8** — independent tracks: atlas unification (`AtlasTexture`, needs G10), readback/staging/compute/timestamp (G4/G5/G7/G8, deletes the 3 `unwrapBuffer`), resident `BufferPool` (G6). | #991 P3/P7/P8 | per-phase baseline rows burn; P3: one atlas primitive, raw twins deleted |
| A5 | **P0 residue** — FrameUniform packs through `UniformBlock.of(...)` (single layout authority); finish #834 M5 so `['rhi-webgpu','engine']` leaves the dep-ratchet BASELINE. | #991 P0; #834 M5 | dep-direction BASELINE == `[]` |

**Why A1 first:** shortest remaining distance (2 passes left), removes a _user-visible defect
class_ (twin divergence), and its retype work is P4 — the structural root that unblocks both
A2 and A3. A2 before A3 because P5's `FullscreenComposePass` subsumes `compose-pipelines.ts`,
shrinking A3's surface.

## 4. Track B — wave-2 promotion nominations (audit before execution)

Subsystem classification of `map/src` found substantial **geo-import-free** machinery beyond
#991's list. These are **nominations, not phases**: each needs its own #991-style audit slice
(strip-X-GIS surface, coupling severance plan, blast radius) before any move. A nomination
earns execution only if it (a) passes the strip test, (b) names **≥2 real consumers** or
folds duplicate twins into one authority — the engine's own history warns here: `GPUArena`
(514 LOC, the largest engine module) has exactly 2 consuming files. Moving code nobody
composes is decoration.

| Candidate | LOC | Evidence of genericity | Coupling to sever |
| --- | --- | --- | --- |
| **B1 — SDF text core** (`text/sdf/*`, `text-wrap`, `text-collision`, `label-fade`, `text-renderer`) | ~5,000 | **zero `@xgis/geo` imports in all of `map/src/text/`** (verified); `text-renderer.ts` header: "this renderer never touches projection"; pure DT (Felzenszwalb–Huttenlocher), LRU atlas state, Knuth-Plass wrap, AABB collision | `LabelDef`/`TextValue` from `@xgis/compiler` confined to the `text-stage*` orchestration layer (stays in map); glyph-PBF provider seam already structural. Consume the engine `AtlasTexture` — **gated behind A4-P3** |
| **B2 — sprite machinery** (`host-atlas-packer`, atlas GPU mirrors, `icon-renderer`, `icon-collide-overlap`) | ~2,400 | shelf packer + mirrors are pure; icon renderer is screen-px→NDC | Mapbox sprite-JSON protocol (`sprite-atlas-host`) stays in map; naturally the same P3 `AtlasTexture` story |
| **B3 — small generics** | ~1,300 | `heatmap-targets` 182 + `flow-targets` 176 (two hand-rolled ping-pong target pairs → one primitive), `oit-pass` 108 (McGuire–Bavoil is a rendering technique, not a map), `event-dispatcher` 292 (hover/enter/leave semantics), `vector-drape-cache` 58 (pure LRU), `renderer-helpers` 290 (pure interp/parse) | mostly none; per-item audit |

**Anti-candidates (adjudicated — do not revisit without new evidence):** camera (#781 3b),
`FrameContext` (#929 C — carries `ProjectionToken`), frame-uniform schema (#991 P0 —
`proj_params`/`meters_per_pixel` are content), `PipelineFactory` and `GpuTileStore` classes
(style-keyed / content-aware; only their _mechanisms_ route through RHI in P6/P8),
`bucket-scheduler` (every input type is style IR), label placement.

## 5. Track C — map-internal decomposition (independent of engine growth)

Engine promotion alone leaves `map.ts` at 5,330 LOC. This track is about **map's own** shape.

**C1 — `XGISMap` facade-ization.** The measured 14 responsibilities decompose to owner
classes with narrow interfaces; `XGISMap` keeps the public API and delegates. The existing
extractions (RenderLoop, controllers) are self-described as *"RELOCATION, not a decoupling"*
— the lesson is that an extraction must move the **decision**, not just the lines. Therefore
the acceptance metric per extraction is that the host surface **shrinks** (the
`pass-hosts.ts` / `RenderLoopHost` key count goes down), not merely that `map.ts` LOC drops.
Order by size × shallowness of coupling:

1. **DiagnosticsRegistry** (~25 debug/dump/trace accessors — widest method count, shallowest coupling),
2. **CoverageTimeline** (S-100 time-series verbs: `setCoverageTime/Frame`, `playCoverageTime`, …),
3. **DeviceLifecycle** (device-lost recovery, `_releaseGpuResources`, `_teardownForReinit`),
4. **ProgramRunner/SceneCompiler** (`_runProgram` 773 + `rebuildLayers` 594 + epoch/variant plumbing — the deepest cut, last).

**C2 — layer charter for today's `map/src` (Gate 5 revival done right).** The dropped spine's
failure is documented (`docs/research/2026-06-18-runtime-package-redesign.md` review: five
blocking defects; verdict *"a strict L0 lint … could only ship warn-only with a large
baseline"*). The corrected sequence: **derive the charter FROM the real import graph** (a
charter the graph already obeys), enforce direction only then, and give the gate the #996
companion assertion (every allowlist key must still resolve). A spine the graph doesn't
satisfy is decoration; a charter without a gate reverts to the mean (R1).

**C3 — render-loop prep-phase content.** `render()`'s prep inlines `projType`/`poleLimit`/
`centerLat` Mercator math and `_resolveFillPatterns` is pure content — move both behind the
camera/content seam so `RenderLoop` trends toward a generic frame scheduler (its `_ctx`
reuse, node iteration, submit/flicker/idle bookkeeping already are).

## 6. Track D — gate hygiene (small PRs; land first)

| # | Fix | Evidence |
| --- | --- | --- |
| D1 | **One projType authority.** Fold arch-invariants Gate 4 into `projtype-confinement-ratchet.test.ts` (keep the stricter semantics: strict-equal both directions, comment-stripped, union scan; extend its scan set with `engine/src`), delete Gate 4. | the two gates disagree today (11/27 ceiling-with-comments vs 9 strict); Gate 4 counts the two *warning comments* as violations (`under-occluder-renderer.ts:203`, `raster.ts:169`) — the §12 second-ratchet trap, live |
| D2 | **Prune stale engine barrel comments** — `engine/src/index.ts:38,45-47` name two shims deleted in `176d494`. | on-disk check |
| D3 | **Remember the close-out shims**: `map/src/index.ts` re-exports of `Material`/`executeItems`/`UniformRing` are marked "drop at the EPIC close-out" — listed here so close-out (A-track DoD) actually drops them. | `map/src/index.ts:23-27,81-83` |
| D4 | **Re-ground or prune `MODULES.md` §2–§5** (self-marked STALE, still cites `runtime/src/engine/**`). | `docs/architecture/MODULES.md:71` |

## 7. Socratic self-critique — reject the weak versions before code exists

1. **"Fill the engine so the LOC ratio looks better."** Rejected. LOC parity is not a goal;
   the #714→#715 eviction is the precedent for what content-in-engine costs. The bar is
   strip-X-GIS + real consumers (§4). The success metric is §2's routing share, not lines.
2. **"Move `text/` wholesale — it has no geo imports."** Rejected. The `text-stage*`
   orchestration layer is `LabelDef`/style-coupled and stays; only the SDF core qualifies,
   with compiler types severed via injected structural interfaces, and only after its own
   audit slice. Nomination ≠ phase.
3. **"Introduce a new middle package (`scene/`, `runtime2/`) between engine and map."**
   Rejected. The runtime dissolution (`176d494`, same day as this doc) is the precedent: a
   layer that owns no decision degenerates into a re-export barrel plus orphaned tests.
   Grow `@xgis/engine`; do not mint siblings.
4. **"Re-erect the strict L0–L4 spine now — map needs internal layers."** Rejected as
   sequenced. The 2026-06-18 review's defect C3 stands: a spine the import graph doesn't
   satisfy ships warn-only and enforces nothing. Charter-from-graph first (C2), gate second.
5. **"One rebalance mega-PR."** Rejected. Every phase stays independently shippable with its
   own §8 gate — the EPIC's principle 8, and the only shape whose failure is recoverable.
6. **"Keep both projType gates — more coverage."** Rejected. Two authorities over one
   invariant drift by construction — and have (11 vs 9 entries, different semantics, two
   comment-only false positives). Merge to the stricter one (D1).
7. **"Declare A1 done when `_chainRunsOnWebgl2` flips."** Rejected. Done = the twin
   **deleted**, the fork gone, and the parity/identity baselines burned in the same commits —
   a flag flip leaves two frames to maintain and the divergence class alive.
8. **"This doc becomes the phase spec."** Rejected — it would be a third authority. Specs
   live in #991/#1046 and their plan docs; this doc sequences, nominates, and records the
   diagnosis. If a conflict appears, the issue + its plan doc win and this doc gets a
   correction, not a fork.
9. **"Skip render verification for pure relocations."** Rejected. Every phase inherits §8;
   pure relocation proves itself with **DC=0** (byte-identical), which is cheaper to prove
   than to argue.

## 8. Verification protocol (every increment — by reference)

`engine-substrate-migration-991.md` §7 applies verbatim to all tracks: `bun run build` as
typecheck authority (watch TS6133 on re-export/import swaps) → vitest (**whole-repo** when
code moves between packages — the red-test-in-the-package-I-didn't-touch lesson) → §5 render
gates (directional pixel-diff, **DC=0 for pure relocations**, 16-split full-res reads, both
backends where the frame is touched) → zero-alloc check on hot-path moves → **both ratchets
green with their baseline rows burned in the same commit**. Heavy jobs serialized (§7);
author↔review separation (§10).

## 9. Sequencing summary and definition of done

```
D1+D2 (hygiene, ~1 PR each)
  → A1 (#1046 F3b–F6 ≡ P4)  → A2 (P5 render graph)  → A3 (P6 create*→RHI)
  → A4 (P3 ∥ P7 ∥ P8)       → A5 (P0 residue)       → close-out (#991)
C1 (map facade) proceeds in parallel from the start — it touches map.ts, not the render path.
C2 (layer charter) after C1's first extractions settle the shape it must describe.
B  (wave-2 audits) after A4-P3 lands the atlas primitive they consume.
```

**Program definition of done (all mechanical):**

- `map/src/raw-webgpu-ratchet.test.ts` BASELINE == `{}` (from 575/48) — map never touches
  native WebGPU; every GPU operation routes through engine/RHI.
- `renderFrameViaRhi` + the `render-loop.ts:242` fork deleted; backend-identity BASELINE == 0;
  one pass-chain executes on every backend.
- dep-direction ratchet BASELINE == `[]` (the `['rhi-webgpu','engine']` edge burned).
- `@xgis/engine` exports the real surface: `Material`/`executeItems`, `UniformBlock`,
  `UniformRing`, `FrameArena`, `GPUArena`, `RenderNode` scheduler, `FullscreenComposePass`,
  `RenderToTexturePass`/`bakeToTexture`, `AtlasTexture`, `readbackTexture`, `BufferPool` —
  each passing strip-X-GIS, each with ≥2 composing consumers or a folded twin.
- **#599 imports `bakeToTexture` from `@xgis/engine`** (the substrate did its job).
- One projType gate; `map/src/index.ts` close-out shims dropped; engine barrel comments
  current.
- A layer charter for `map/src` exists, matches the real import graph, and is enforced with a
  #996-proof gate.
- `map.ts` below its current ratchet ceiling with the `RenderLoopHost`/pass-host key count
  measurably reduced (the decoupling metric, not the LOC metric).

## 10. Non-goals

- No geo/content back into the engine (Gates 6/7 stand; #781 is settled).
- No `FrameContext` relocation (carries `ProjectionToken`; #929 C is settled).
- No new middle package (runtime-dissolution precedent).
- No behavior change anywhere in the program — the bar is byte-identical rendering per
  increment; API shape may change (generalization), output may not.
- No publishing changes — `@xgis/map` remains the one published package (`176d494`).

---

_Grounded against the tree at `claude/engine-module-architecture-bbtb3p` (head `31f3f47`),
2026-07-27. Measurements: LOC via non-test `wc -l`; ratchet baselines read from their test
files; #991/#1046 state from the issues' comment threads (bodies noted stale per CLAUDE.md
§12). Companion docs: `engine-substrate-migration-991.md` (P0–P8 specs),
`engine-content-split.md` (the original carve), `package-responsibilities.md` (charters),
`render-graph-pass-scheduler.md` (P5 design)._
