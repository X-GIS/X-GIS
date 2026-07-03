# S6 — Migration Cost: the 5-year target, a SAFE sequence, and the cost/predictability framing the owner actually cares about

_Synthesis verdict, 2026-06-09. Theme owner: the person paying for this — who is afraid of two things at once (god-files AND speculative abstraction) and whose recurring pain is "fix doesn't hold." Every cross-reference below is grounded in an A\* (first-hand code, file:line) or B5 (external authority). Where I assert a sequencing or cost claim, the evidence ref is named. Cold, specific, no vibes._

---

## (1) COLD VERDICT

**Not sustainable as-is for a 5yr / 3D-tiles / 4D goal — but the failure is not the plan, it is the _migration method_, and that is fixable without a rewrite.** The codebase has one genuine strength (acyclic package DAG, A1 §5) and a correct, well-sourced destination already written down (the Blender-DNA roadmap, A5 Part 1; the depsgraph/draw-manager analogy is primary-cited, A5 §1.5). But the roadmap is **~45% executed and stalled at exactly the part that justified writing it** — the god-file decomposition (S20 EvaluatedTile/TileUploadService) is 0% done while the worst god-file _grew 21%_ during the roadmap's own lifetime (`map.ts` 2827→3431, A5 §2.2). The root cost problem is **not "no diagnosis" and not "missing a grand architecture" — it is that every prior attempt at structural change has been a RELOCATION, not a decoupling** (A1 §3.1 proves a live `map↔render-loop` import cycle survived the "render redesign"; A2 §1 confirms the satellite controllers are verbatim moves that reach 43–89 fields back into the god-object). That pattern is precisely what B5(c) names as the avoidable failure: big-bang/in-place edits with no characterization safety net produce "fix doesn't hold." **The axis is sustainable IF AND ONLY IF the migration method changes** from "audit then relocate" to "golden-master-first, Branch-by-Abstraction, one revertible commit per consumer, delete-old-last" (B5(c) TRANSFER VERDICT: "highest-value transfer in this whole document"). Without that method change, the god-files keep drifting because **there is zero enforcement** — no LOC budget gate, no projType-literal lint, no cycle gate (A1 §6), so each refactor decays back. The owner's money is currently buying research, not structural change (A5 §3.3: "research-to-execution ratio inverted, ~500 LOC shipped across three audit sessions").

**Sustainability score for this axis: 2 / 5.** Not a 1 (the destination is right and well-sourced, the cheap half shipped, the DAG is clean). Not a 3 (the headline decomposition is 0% done, the god-files are _bigger_, the migration method that produced "fix doesn't hold" is unchanged, and nothing enforces non-regression).

---

## (2) ROOT CAUSES (not symptoms)

The symptoms are loud and already catalogued elsewhere (5440-line `render()`, 980-line `label-pass.execute`, 4 redundant camera caches, inert dirty bitset, un-installable package). This theme is about _why migration keeps failing and costing more than it should._ Four roots:

**R1 — Relocation-disguised-as-decoupling is the house style.** Every shipped "refactor" moved code without cutting the dependency. PROVEN, not asserted: `map.ts:27 → render-loop`, `render-loop.ts:36 → map` is a bidirectional module cycle (A1 §3.1); the header _admits_ "RELOCATION, not a decoupling" (A1 §3.1, A2 §1). render passes reach `host.X` **89 times** (A2 §4); the satellite controllers borrow the god-object's state by reference and reach back (A2 §1). **Consequence for cost:** you cannot unit-test or characterize any extracted unit because it still needs the whole 3431-line `XGISMap` constructed or 43-field-mocked (A1 §3.1). So the safety net that would make the _next_ refactor cheap never gets built — each migration pays full re-discovery cost (B5(c): "legacy code is code without tests → no safety net → no safe change").

**R2 — No enforcement, so structure decays back to the mean.** The three governing docs cite VTR as 5440 / 5608 / 5298 LOC — they disagree with each other and reality because there is no CI LOC-budget gate (A1 §1). The PROJECTIONS authority flip is ~40% done and the _remaining_ capability literals (`projType === 1 || === 2 || === 6` open-coded twice in one file, A1 §3.2) keep being added because nothing lints them. **Cost consequence:** every gain is temporary. `map.ts` grew +604 lines _during_ the roadmap meant to shrink it (A5 §2.2). Without a ratchet, migration spend does not accumulate — it leaks.

**R3 — The migration plan is over-decomposed into ceremony, which _hid_ that only the easy half was being done.** A5 §4 is blunt: 5 "authorities" is taxonomy theater (the "MUTATION AUTHORITY" shipped as a 27-line side-logger that does not even mutate — A5 §2.3, A2 §2), and 21 increments manufacture ceremony where ~8 real units exist. B5(b) names this exact failure: "the biggest trap is over-engineering… every feature spawns a new interface… complexity explodes." The fine-graining let the project ship the inert 13 increments and call it progress while every god-file-decomposing increment (S17/S18/S19/S20) stayed at zero (A5 §2.5). **Cost consequence:** the plan's own granularity disguised non-execution as 45% progress.

**R4 — The one gate that could make decomposition safe cannot see the surface that most needs it.** S20 (the headline decomposition) must preserve the extrusion upload path's arena-compaction-vs-upload ordering or you get a GPU use-after-free (A5 §3.2, Risk #5). But the real-GPU matrix is **local-only and manual** (A4 §3b: "a gate that lives only on one developer's machine and is run manually is, for regression-prevention purposes, not a gate"), and even on a real GPU the matrix is _blind to extrusion_ — flat synthetic fills render 56.75% while the same geometry extruded renders 0.00% under SwiftShader (A5 §5 / A4 §3d). So the team correctly senses S20 is dangerous and CI can't catch the failure, and **retreats into audits** (A5 §3.2, INFERENCE well-supported: "producing audits is lower-risk dopamine than attempting it"). **Cost consequence:** the most valuable migration step is permanently parked behind an absent safety net, so the spend goes to re-planning instead.

**The unifying root:** migration cost is high and predictability is low because the project does the _comfortable_ half (inert substrate, camera tweaks, more research) and is structurally blocked from the _uncomfortable_ half (god-file decomposition) by the absence of the exact safety net B5(c)/B5(d) prescribe — a golden-master image matrix on a real GPU. **Fix the safety net first, and the decomposition becomes attemptable; until then, no amount of planning moves the god-files.**

---

## (3) TARGET STATE — what "good" looks like, grounded in the references

Not "Blender, ported." The destination is the _force_ behind Blender's depsgraph + draw-manager and Fowler/Feathers' migration discipline, sized to a WebGPU/TS map renderer (B5 cross-cutting synthesis §1–5). Concretely, at the 5-year mark "good" is:

- **Two zones, explicitly bounded (B5(a) Rule, B5 synthesis §1).** Zone 1 = the per-vertex/per-feature _hot path_ (tile decode → typed-array column packing → GPU buffers → draw) is DOD: typed-array SoA columns swept by passes, never arrays of `Feature` objects. This is _already X-GIS's reality_ (packed polygon/line vertices, RTC/ECEF buffers) — the target is to _name and isolate_ it, not invent it. Zone 2 = the control plane (map config, layer registry, style, lifecycle) stays readable plain-object OOP. **No ECS framework** (B5(a) TRANSFER VERDICT: X-GIS's core data is spatial = ECS's documented weak spot; a generic entity/query runtime is the speculative abstraction to avoid).

- **God-files decomposed toward named seams with concrete collaborators, NOT an interface per concern (B5(b) Rule).** The target for VTR is the units A1 §2.1 already names (GPUTileCache / TileUploadScheduler / TileBindGroupFactory / TileVisibilitySelector / WorldCopyEnumerator / FeatureDataProvider) — concrete classes, each independently constructible and golden-testable. Every abstraction must point to ≥3 concrete consumers _today_ or remove a _current_ duplication-driven bug class (B5(b) test). The PROJECTIONS table earns its abstraction (7+ projections, real bug class); a one-impl `ITileFetchStrategy` does not.

- **One mutation funnel + a _consumed_ dirty bitset (A5 §2.3, A2 §2, B5(a) data↔behavior separation).** "Good" is the OperatorBus actually being the single mutation path (today it is a side-log, A2 §2) and ≥2 of the 8 dirty domains actually gating per-frame work (today 7/8 are write-only, A2 §2). This is Blender's typed `ID_RECALC_*` → consumer skip, sized down — _not_ a 6-box authority diagram (A5 §4.1 calls the diagram "architecture-astronaut formalism").

- **A real safety net: the four-oracle matrix on a real GPU (B5(d) Rule, the load-bearing target).** (1) CPU property-based invariants in CI (forward∘inverse ≈ identity, coverage no-gaps, collision idempotent). (2) **Golden-master image MATRIX on a real-GPU lane**, perceptual-tolerance diff, spanning projection × pitch × zoom × data × surface — this is the renderer's characterization test and the gate for _every_ render-path refactor. (3) Metamorphic relations (pan-and-back ⇒ identical, world-copy wrap ⇒ identical, dual-projection-path ⇒ identical) for correctness signal without ground truth. (4) Differential vs d3-geo/MapLibre where a reference exists. The matrix exists in skeleton (A4 §3c, 45 cells, 26 known-broken) but is local-only — "good" is this matrix _wired to a GPU-enabled CI runner_ (A4 §4: "the lasting unlock").

- **The migration itself runs Strangler Fig / Branch-by-Abstraction, golden-master-first (B5(c) Rule).** "Good" means: no big-bang rewrite of any render subsystem; for each fragile area, lock the golden-master suite _before_ touching code, introduce a seam so old+new coexist behind a flag, migrate consumers one revertible commit at a time, delete old only when the golden suite is byte/perceptually identical. Use **Sprout** so the 5440-line VTR is never edited in place — new tested units are _called from_ it.

- **Installable, observable, extensible enough for 3D-tiles (A6 axes α/β/E2).** "Good" is `npm install @xgis/runtime` works (today it cannot — `workspace:*`→`private:true` chain, A6 α), a `map.on('error')` event exists (today none, A6 E2), and there is _a_ plugin/custom-layer seam so 3D-tiles can be added without forking the engine (today absent, A6 β — and A6 notes β is the _same wound_ as the evaluated-data↔draw seam S20 builds).

---

## (4) THE SAFE MIGRATION SEQUENCE — order, gates, first move, blast-radius bounding

The sequencing principle (from B5(c) + the roots above): **build the safety net before the dangerous edit; do mechanical/zero-risk deletions first to bank credibility and shrink the surface; never edit a god-file in place; one revertible commit per consumer.** Each step below names _what gates the next_ and _how it bounds blast-radius_.

### Phase 0 — THE FIRST CONCRETE MOVE: a real-GPU golden-master gate in CI (gates everything else)

**Move:** stand up a GPU-enabled CI runner (or a scheduled real-GPU lane) and wire the _existing_ matrix net (A4 §3c, `matrix.manifest.ts`, 45 cells) to it as a required check, with perceptual-tolerance diffing (B5(d) §1 mitigation, cross-GPU AA stability). Add the `expected_red` flip-alert (A4 Top-3 #1, ~1 line, already scoped as task Step 1.5) so the 26 known-broken cells signal on fix-or-regress.
**Why first:** B5(c)+B5(d) are unanimous — you cannot safely refactor a renderer without a characterization test, and for a renderer that test _must_ be a golden-master image on a real GPU (A4 §3b proves CI's 4 specs never paint a pixel; A4 §4: raster regression is mitigated only "procedurally" today). **This is the missing safety net that R4 says blocks S20.** Until it exists, every subsequent structural step is a gamble.
**Gate it provides:** every later phase's "done" = matrix stays/turns green on the real-GPU lane (A5 §1.3 Risk #9: behavior changes may NOT be claimed done on unit tests alone).
**Blast-radius:** infrastructure-only, zero source change to the engine. Cannot break rendering. Pure upside.
**Cost/predictability framing for the owner:** this is the single purchase that converts "fix doesn't hold" into "fix is gated." It is the highest-leverage dollar because it makes _all_ future migration cost _predictable_ — a refactor either keeps the matrix green or it is reverted, one commit.

### Phase 1 — Enforcement ratchet (gates non-regression; cheap)

**Move:** add three CI gates (A1 §6): (a) fail new/grown files >800 LOC in `render/`; (b) forbid `projType === <int>` outside `projections-table.ts`; (c) break/forbid the `map → render-loop → map` cycle (A1 §3.1). Lock the _current_ LOC as the ceiling — no file may grow.
**Why here:** R2 says structure decays without enforcement; A5 §2.2 proves `map.ts` grew +604 during the last roadmap. The ratchet must exist _before_ decomposition so the freed lines can't refill.
**Gate it provides:** any later commit that grows a god-file or scatters a projType literal fails CI.
**Blast-radius:** lint/CI-only; bounded to flagging, not editing. Can be staged as warn-then-error.
**Cost framing:** stops the leak. Without it, R2 guarantees migration spend evaporates.

### Phase 2 — Mechanical deletions / dedup (bank credibility, shrink surface; near-zero risk)

**Move:** execute S19 first (A5 §2.4, A5 Part 5 Q4): delete the 3 copies of `quantizeAxis`/`tileEcefCenterFromMerc` into `@xgis/shared`. Then share the contract types — one `ShowCommand`/`LoadCommand`/`SceneCommands` imported by both packages (A6 C1/C2, Top-fix #2), exactly as the team already did for `ShaderVariant` (A6: "they know the fix; it just wasn't applied to ShowCommand").
**Why here:** these close the **#1 CPU↔GPU drift bug-class** (A5 §2.4) and turn hand-sync drift into compile errors (A6 C1) with no behavior change — so they are gated by _compile + the Phase-0 matrix staying green_, the safest possible gate. They also shrink the surface S20 must touch. A5 Part 5 Q4 literally prescribes: "the next session should be forbidden from writing a new `.md` until S19 is committed."
**Blast-radius:** S19 is a delete-and-redirect-import (mechanical); shared-type is import-rewiring. Both are caught at _compile time_ across all call sites — the safest blast-radius class.
**Cost framing:** these are _banked_ wins — they cannot decay (the ratchet holds them) and they remove a recurring bug class, so they reduce future debugging cost permanently.

### Phase 3 — Break ONE real seam by Branch-by-Abstraction (the method-change proof; one subsystem)

**Move:** pick the _least-coupled_ god-file responsibility and extract it via B5(c) Branch-by-Abstraction + Sprout. Candidate: `GPUTileCache` / `TileUploadScheduler` out of VTR (A1 §2.1 items 2/3) OR the tile _scheduler_ invariants (B5(e): bounded concurrency, SSE-priority, abort-on-intent, gesture-throttle, dedup) — the latter is attractive because B5(e) says it "grows in importance under 3D-Tiles/4D" and X-GIS already has most of it (A3 §1.1 tiles are capped/queued/abortable). Do it as: (1) introduce abstraction boundary over the current supplier; (2) move clients onto it; (3) build new supplier behind the same boundary; (4) switch behind a flag; (5) delete old. **Never edit VTR in place — Sprout the new unit and call into it.**
**Why here:** this is the _proof that the method changed_ (R1). One subsystem, fully decoupled and golden-tested, establishes the template and — critically — builds the first independently-constructible unit, which is the missing safety-net primitive (R1).
**Gate it provides:** a worked Branch-by-Abstraction template + one testable seam. The _next_ decomposition is now cheaper.
**Blast-radius:** bounded to one responsibility behind a flag; rollback is flipping the flag / one revert (B5(c): "each commit stays deployable, rollback is instant"). The Phase-0 matrix gates correctness; the flag gates exposure.
**Cost framing:** this is where predictability becomes _visible_ to the owner — the first decomposition that ships without reopening another bug.

### Phase 4 — S20 (the headline) — ONLY after Phase 0+3 exist

**Move:** add `evaluated-tile.ts` + `tile-upload-service.ts` (A5 §1.2 S20), Sprout-extracting the upload path out of VTR, preserving the arena-compaction-vs-upload ordering (A5 Risk #5, GPU UAF).
**Why last:** it is the most dangerous (A5 §3.2) and its highest-risk surface (extrusion) is matrix-blind (A5 §5 / R4). It is only safe once Phase 0 includes an **extrusion cell** on the real-GPU lane (A4 §3d notes the matrix has _no_ OIT/extrusion coverage — this must be added in Phase 0 before S20 is attemptable).
**Gate it provides:** the evaluated-data↔draw seam that _also_ unlocks the 3D-tiles plugin axis (A6 β: "β and the structural axis are the same wound").
**Blast-radius:** the largest in the sequence — bounded by (a) Sprout (VTR not edited in place), (b) flag-gated coexistence, (c) the extrusion matrix cell that must stay green, (d) one-consumer-at-a-time switchover.
**Cost framing:** this is the expensive step the owner has been _paying around_ via audits. The sequence's entire point is to make it _attemptable_ rather than perpetually deferred.

### Cross-cut (sequence-anytime, independent): the 3 non-tile reliability fixes

A3 names three sharp edges orthogonal to the god-file work, each small and high-value: throttle glyph-PBF fetches through the existing PriorityQueue (A3 §1.2, the one uncapped flood path matching the owner's stated fear, and B5(e) invariant), worker-pool crash respawn + per-job timeout (A3 §3), glyph-atlas page shrink (A3 §2.2 monotonic GPU leak). And A6's `map.on('error')` + device-loss recovery (A6 E1/E2). These are **Sprout-shaped** (isolated tested units) and can land in parallel with any phase — they do not gate and are not gated by the decomposition, so schedule them whenever there's a reliability sprint.

---

### The cost/predictability framing for the owner (the thing he actually cares about)

- **Today's cost curve is the wrong shape:** spend produces research and inert substrate that decays (R2), while the expensive risk (S20) is deferred — so cost is _high and recurring_ with _low predictability_ ("fix doesn't hold," R1).
- **The sequence inverts the curve by buying the safety net first (Phase 0).** Once a refactor is gated by a real-GPU golden matrix, the cost of any structural change becomes _bounded and predictable_: it either keeps the matrix green (ship) or it doesn't (one revert). That is the literal antidote to "fix doesn't hold" (B5(c) TRANSFER VERDICT).
- **Phases 1–2 bank non-decaying wins** (ratchet + dedup) so spend _accumulates_ instead of leaking.
- **Phase 3 proves the method** on one subsystem before betting on Phase 4.
- **The owner's dual fear is respected:** god-files get decomposed (toward concrete collaborators, A1 §2.1 named units) but **no speculative abstraction is introduced** — every seam earns ≥3 consumers or kills a current bug class (B5(b) test), and the ECS/5-authority/21-increment ceremony is explicitly rejected (B5(a), A5 §4).

---

## (5) EXPLICIT UNCERTAINTIES & DISAGREEMENTS

- **Is a GPU-enabled CI runner actually procurable/affordable?** Phase 0 is load-bearing and assumes a real-GPU CI lane is obtainable. A4 §4 names it "the lasting unlock" but does not cost it. If a hosted GPU runner is not viable, the fallback is a _scheduled_ real-GPU lane on a dev box with a hard human gate before merge — weaker, but A4 §3b already calls the current manual local run "not a gate." **This is the biggest open risk to the whole sequence and should be priced first.** (Uncertainty: procurement, not technical.)

- **Phase 3 subsystem choice is a judgment call, not derived.** I argue for GPUTileCache/upload-scheduler (least-coupled, A1 §2.1) or the tile scheduler (grows under 3D-tiles, B5(e)). A reasonable person could argue for `label-pass` decomposition first (A4 Top-3 #3: 980-line method, highest recurring-bug correlation). I rank label-pass _after_ because it is more entangled (12 inline closures, projection-mirrored, A4 §2b) — a worse _first_ Branch-by-Abstraction target. Defensible either way; flagged as a real disagreement.

- **A5 vs A6 on what "Tier 1" should be.** A5 §3.3 notes the codebase has a _second_ remediation plan (the 06-08 rendering audit) re-prioritizing toward reversed-Z + RTC f64-matrix — work _not in_ the S0–S20 sequence. I have sequenced around the _original_ roadmap's S19/S20 because those close the named #1 debt; I did **not** independently evaluate whether reversed-Z/precision should preempt S20. If depth-precision is causing live correctness bugs (the open Step 2 task #8 mentions reversed-Z), it may belong before Phase 4. **Unresolved: I cannot adjudicate this from A\* alone** — it needs the rendering-audit doc, which is outside this theme's evidence set.

- **Whether the dirty-bitset/OperatorBus should be _finished_ or _deleted_.** A2 §2 and A5 §2.3 both show it as inert overhead (double-bookkeeping that gates nothing, A2 §6 risk #2). The target state (§3) assumes finishing it into a real consumed funnel. But a colder reading of B5(b) ("prefer duplication over the wrong abstraction") and the owner's anti-speculation fear could justify _deleting_ the inert scaffold entirely and re-deriving invalidation only when a _concrete_ per-domain skip is needed. I lean "finish it" because Blender's depsgraph proves the pattern earns its keep at scale (B5(a)/A5 §1.5), but "delete the inert version now, rebuild on demand" is a legitimate cheaper path I am not certain is wrong.

- **3D-tiles/4D readiness is asserted-by-absence, not measured.** A6 axes β (no plugin seam) and ε (time is paint-only, no feature time-axis) are grep-negative findings (A6 marks them INFERENCE on the absence). I have treated 3D-tiles extensibility as the same wound as S20 (per A6 β), but I have _not_ verified what a concrete 3D-tiles integration would actually require — that scoping is genuinely unknown and should be a spike, not an assumption, before Phase 4 is committed to that shape.

- **The B-file authorities are mostly blog/conference sources (B5).** B5 is unusually careful (primary sources prioritized, TRANSFER VERDICTs flag where the analogy breaks), but the SOLID-failure and DOD-in-frontend claims lean on Medium/JavaCodeGeeks posts, not peer-reviewed work. The _force_ of the principles (Rule of Three, Strangler Fig, four-oracle testing) is well-established (Fowler/Feathers/Acton are primary), but I am relying on B5's synthesis for the X-GIS-specific transfer and have not independently re-verified the weaker secondary citations.
