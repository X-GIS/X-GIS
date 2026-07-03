# S1 — Structural Sustainability: The Cold Verdict

_Principal-architect reckoning, 2026-06-09. Theme: god-files, coupling, authority-inversion, dependency direction. Evidence: code reality from A1/A5/A6 (file:line, first-hand); external authority from B1 (Blender), B2 (Unreal), B3 (MapLibre — the direct peer), B5 (engineering principles). Every load-bearing claim is anchored to an A_ or B* file. Nothing asserted that the evidence does not support.*

---

## 1. COLD VERDICT — **NOT sustainable as-is. 2 / 5.**

**No.** This structure does not survive a 5-year / 3D-tiles / 4D horizon without intervention, and the reason is precise and unflattering: **the team has the correct diagnosis and a correct plan, and is not executing the part that matters.** The one genuine structural asset — an acyclic, test-defended _package_ DAG (compiler imports runtime 0 times; runtime→compiler one-directional; `@xgis/shared` a true leaf — A1 §5) — sits on top of a _module-level_ structure that is the opposite of sustainable: a 5,440-LOC renderer containing a single **2,054-line `render()` method**, a 3,431-LOC `map.ts` god-object with **126 methods / 8 responsibilities** that _grew +604 lines (+21%) during the very roadmap meant to shrink it_ (A5 §2.2), a **real bidirectional `map ↔ render-loop` import cycle** with 43 private-field reach-throughs that the redesign's own header admits is "a RELOCATION, not a decoupling" (A1 §3.1), and a #1-ranked authority-inversion that is only ~40% closed (A1 §3.2). The peer that proves this is solvable — MapLibre, the _same language, same runtime, same problem_ — stays maintainable across 100k+ LOC and a decade precisely by doing the inverse on every axis: single-owner subsystems instead of god-files (B3 §10.2), contracts-not-call-graphs at every seam (B3 §10.1), one declarative authority instead of parallel sources of truth (B3 §1). X-GIS is not failing for lack of a map; it is failing because **planning is the comfortable activity and the god-file decomposition (roadmap S20) is the uncomfortable one** (A5 §3.2), and there is **zero structural enforcement** to stop the decay (no LOC budget gate, no `projType ===` lint, no module-cycle gate — A1 §6). It is not a 1 because the package DAG, the shader-DSL authority (aligned with MapLibre's `ProgramConfiguration`, B3 §7), and the diagnosis itself are genuinely good. It is not a 3 because the load-bearing files are growing, not shrinking, and nothing blocks that.

---

## 2. ROOT CAUSES (not symptoms)

The god-files, the import cycle, and the scattered `projType === 1` literals are **symptoms**. The roots:

### R1 — No structural enforcement gate. (the master root)

There is no CI mechanism that fails a PR for growing a god-file, adding a `projType === <int>` outside the table, or reintroducing a module cycle (A1 §6; A5 §2.2 shows `map.ts` grew +604 lines _unblocked_). Without a ratchet, **every decomposition decays back** and every audit's recommendations evaporate. B2 §6 names this exact failure in Unreal itself: "the module/subsystem boundaries only hold if you _enforce_ them… UE's own discipline slips; a small lib that adds the patterns but not the enforcement gets the worst of both." Enforcement is the root because it is what converts a one-time refactor into a durable invariant.

### R2 — "Relocation reflex" instead of decoupling. State ownership was never resolved.

Both shipped "redesigns" moved code without cutting the dependency. The render-loop extraction left a **bidirectional `map.ts:27 ↔ render-loop.ts:36` import cycle** and reaches **43 distinct `host.<field>` accessors, ~20 of them private `_` internals** (A1 §3.1) — the encapsulation boundary is fiction. The root is that **no scope/lifetime taxonomy exists to answer "where does this state live?"** B2 §2 (Subsystems) and §4 (GameInstance) name this precisely: "where does this state belong? is answered by lifetime, not convenience" — X-GIS has device-scope, map-session-scope, and frame-scope state all entangled in one `XGISMap` god-object instead of three lifetime-scoped owners. Relocation cannot fix this; only assigning each concern a single owner with an explicit lifetime can.

### R3 — Parallel authorities for one truth (authority inversion, half-closed).

The #1-ranked debt: capability _predicates_ are still hand-encoded as integer-literal comparisons at the call site (`camera.ts:982,1064` open-code the cylindrical family `=== 1 || === 2 || === 6` _twice in one file_; `camera.ts:917` magic `=== 3`; `vector-tile-renderer.ts:2715` the `1..6` range) instead of deriving from the `projections-table` — A1 §3.2. The world-copy/routing slice of the flip _is_ done (13 files import the table directly), but `isCylindrical/isFlat/isOrtho` membership is not exported, so adding a projection touches ~6–10 files of real logic in a 37-file cone (A1 §4a). B3 §1 names this as MapLibre's central discipline X-GIS violates: "make the declarative spec the **sole** authority and forbid parallel sources of truth… X-GIS's recurring bugs trace to having _multiple_ authorities." B2 §5 gives the cure shape: registration-over-reference — projections register _into_ the table; core never names them.

### R4 — Over-decomposition of the _plan_ hid under-execution of the _work_.

The roadmap manufactured 21 increments and "5 authorities" where ~8 real units exist (A5 §4.1–4.2). The fine-graining is the failure mechanism, not a side-effect: "the easy 13 got done, the hard 8 didn't, and the granularity _hid_ that the project was only doing the easy ones" (A5 §4.2). Two of five "authorities" are fake (OperatorBus is a 27-line side-log, not the mutation funnel it was specified as — A5 §2.3; DirtyDomains drives exactly _one_ skip — A5 §2.3). B5 §(b) is the external indictment: "the biggest trap is over-engineering — splitting code into layers of abstractions that serve no purpose"; the cure is the **Rule of Three** — "every abstraction must point to ≥3 concrete consumers _today_ or remove a _current_ duplication-driven bug class." A 6-box authority ASCII diagram describing a system 0% built for 2 of its boxes (A5 §4.1) fails that test.

### R5 — Contract seams that erase type-safety exactly where coupling is highest.

`ShowCommand`/`LoadCommand`/`SceneCommands` are defined **twice, hand-synced by comment**, no shared type; the expression payload crosses as `{ ast: unknown }` ×7 and is double-cast `as unknown as RuntimeExpr` (A6 C1–C3). The producer _has_ the type (`render-node.ts:658-661`) — the boundary _deliberately discards_ it. This is the same disease as R3 at the package seam: a structural type hole, not laziness. B3 §10.1 ("contracts between subsystems, not call graphs… each boundary is _serializable_") and B2 §1 (public/private dependency surfaces) are the references for what a real seam looks like.

---

## 3. TARGET STATE — what "good" looks like (grounded in what the references ACTUALLY do)

The target is **not** a Blender clone. B1 is decisive and must override the roadmap's framing: the "Blender-DNA migration" name is "**largely a category error**" — X-GIS is a stateless-per-session streaming view in TypeScript over already-standardized external formats; Blender's DNA serialization, ID-library-linking, RNA introspection, COW datablocks, operator-undo, and global `bContext` "solve problems X-GIS does not have," and several are debt Blender's _own_ maintainers want to shed (B1 §2, §5). The defensible subset Blender contributes is _one idea_: **dependency-scoped invalidation** (the depsgraph _pattern_, implemented as a small fixed dirty-domain graph — B1 §3, §5). Good looks like this:

1. **Single-owner subsystems on explicit lifetime scopes** (the headline transfer, B2 §2). Three scopes that mirror Unreal's exactly: _device_ (GPU/adapter/pipeline-cache/atlas — survives style/source swaps ≈ `UEngineSubsystem`), _map-session_ (camera/projection/source-registry/tile-cache — survives `setStyle` ≈ `UGameInstance`, B2 §4), _frame_ (the existing `FrameContext` ≈ per-view). Each subsystem has mandatory `initialize(deps)` / `deinitialize()`; `map.destroy()` becomes "deinitialize every map-scoped subsystem in reverse order," not a hand-maintained list (B2 §2). This is the direct cure for the god-object + the missing-`destroy()` debt.

2. **VTR decomposed along MapLibre's proven three-way seam**, not a renamed monolith. B3 §2/§7/§11: `Bucket` (geometry→buffer, single owner) / `WorkerTile` (orchestration) / `ProgramConfiguration` (buffer→shader binding). The roadmap already named the right sub-units (GPUTileCache / TileUploadScheduler / TileBindGroupFactory / TileVisibilitySelector — A1 §2.1) — they are simply unexecuted. The 2,054-line `render()` method (A1 §2.1 item 7) is the single highest-risk surface and is what "bugs invisible from code alone" means concretely.

3. **One declarative authority, registration-over-reference.** B3 §1 + B2 §5: the `projections-table` is the _sole_ authority; `isCylindrical/isFlat/isOrtho/needsBackfaceCull` are **exported accessors**, never open-coded literals; new projections/source-types/layer-types **register into** a core registry the core never imports from (B2 §5 "the dependency arrow points feature → core, never core → feature"). This simultaneously closes R3 and unlocks AXIS β (the absent plugin/extension API — A6 §β — which is the _same wound_ as the structural one: "to add 3D-tiles today you fork the engine").

4. **Contracts, not call graphs, at every seam** (B3 §10.1, B2 §1). One shared `ShowCommand`/`LoadCommand` type both packages import (the team already did exactly this for `ShaderVariant` — A6 C-good); a validated, versioned artifact; the `map ↔ render-loop` cycle cut by passing an explicit immutable frame-state down rather than a `Pick<XGISMap>` back-reference (B1 §3 "explicit per-frame view state passed down, not a mutable global context" — and note B1 flags Blender's `bContext` as _actively harmful_, the one thing **not** to copy).

5. **Per-domain dirty flags + idle convergence** (B3 §5, the "highest-value pattern to copy exactly"): split the single `_needsRender` bit into `style/sources/placement` domains funneled through one `_update()`, fire `idle`, stop the loop. This is the _real_ form of what the roadmap calls DirtyDomains — currently write-only with one consumer (A5 §2.3).

6. **The hot path stays DOD; the control plane stays readable OOP** (B5 §(a), §cross-cutting-1). Typed-array SoA for tile/vertex/label packing (already X-GIS's reality); plain readable classes for map/style/lifecycle. **Reject a general ECS** — B5 §(a): X-GIS's core data is spatial (quadtrees/R-trees/tile cache), which is "the exact workload ECS is bad at."

7. **Every structural change behind a Strangler-Fig / Branch-by-Abstraction seam with a golden-master matrix locked first** (B5 §(c), "the highest-value transfer in this whole document"). Big-bang rewrites of the render path are _forbidden_; old and new coexist behind a flag; each commit is green and revertible; `Sprout` new behavior so the 5,440-line VTR is never edited in place.

---

## 4. RECOMMENDATIONS

### REC-1 — Ship the three enforcement gates BEFORE any further decomposition. (the keystone)

Three CI gates: (a) fail any new/grown file >800 LOC under `render/`; (b) forbid `projType === <int>` outside `projections-table.ts` (grep-lint); (c) fail on any module import cycle (`dependency-cruiser` / madge), specifically `map → render-loop → map`.

- **Rationale:** Without the ratchet every refactor decays back (A1 §6 prescribes these exact three; A5 §2.2 proves `map.ts` grew +604 _unblocked_). B2 §6 confirms via Unreal that "boundaries only hold if you enforce them." This is the one change that makes all others durable.
- **Evidence:** A1 §6, A5 §2.2, B2 §6.
- **Risk:** Low. Gates are additive; the cycle gate may need a one-time allowlist of the _current_ cycle so CI goes green, then a tracking issue to burn it down (otherwise the gate can't land until REC-3 is done — sequence (a)(b) first, (c) as warn-then-fail).
- **Blast-radius:** CI config + lint rules only; zero runtime code. Touches the dev workflow, not the product.

### REC-2 — Freeze the audit-writing; spend the next session on S19 (delete the 3 duplicated kernels). Mechanical, low-risk, closes the #1 drift bug-class.

`quantizeAxis`/`tileEcefCenterFromMerc` exist in 3 copies (VTR + synthetic-earth-backend + compiler tiler) and were never consolidated into `@xgis/shared` (A5 §2.4).

- **Rationale:** The research-to-execution ratio is inverted — three audit sessions, ~500 LOC shipped, MEMORY.md over its cap (A5 §3.3). S19 is the cheapest possible win that deletes real duplication and kills the CPU↔GPU drift root the sustainability audit ranked #1. B5 §(b) Rule of Three _blesses_ this abstraction (the shared-kernel earns it — genuine ≥3 consumers + a current bug class), unlike the speculative authorities.
- **Evidence:** A5 §2.4, A5 §3.3 (inverted ratio), B5 §(b), B1 §5 (data-oriented shared kernel is a legitimate transfer).
- **Risk:** Low-medium. Three call sites must produce byte-identical output; the existing byte-equal drift gate (US-010, per memory) is the characterization test that makes it safe.
- **Blast-radius:** 3 source files + 1 new `@xgis/shared` module + their tests. Cross-package (shared is a leaf, so the DAG stays clean — A1 §5).

### REC-3 — Cut the `map ↔ render-loop` cycle by inverting the dependency: pass an immutable frame-state down; render-loop stops importing `XGISMap`.

Replace the 43 `host.<private>` reach-throughs with an explicit `FrameInputs` struct constructed by the map and handed to the loop (Branch-by-Abstraction: introduce the struct, migrate accessors one at a time, each commit green).

- **Rationale:** This is the worst module-level coupling and the redesign's own header admits it wasn't decoupled (A1 §3.1). B1 §3 is explicit that "explicit, immutable per-frame view/camera state passed down" is _better_ than a mutable back-reference and that regressing toward Blender's `bContext` is "actively harmful." B5 §(c) Branch-by-Abstraction is the safe mechanism.
- **Evidence:** A1 §3.1, B1 §3 (Context anti-pattern), B5 §(c).
- **Risk:** Medium. 43 accessors, ~20 private; a golden-master image matrix on real-GPU must be locked first (B5 §(d)) because CI is GPU-blind (A5 §1.3 Risk #9). Migrate incrementally; never big-bang.
- **Blast-radius:** `map.ts` + `render-loop.ts` + whatever reads the frame-state. High-traffic but two-file-centered; the cycle-gate (REC-1c) then prevents regression.

### REC-4 — Share the contract type at the compiler↔runtime seam (apply the `ShaderVariant` move to `ShowCommand`/`LoadCommand`/`SceneCommands`).

One shared definition both packages import; add a `schemaVersion` stamp; `.parse()`-validate the AST where the `as unknown as` cast lives (`renderer.ts:97,101`).

- **Rationale:** Converts hand-sync drift into compile errors at every site; the team _already proved the pattern_ with `ShaderVariantInfo = import('@xgis/compiler').ShaderVariant` "to remove the drift surface entirely" (A6 C-good) — making C1 less forgivable, not more. B3 §10.1 (serializable contracts survive even a governance discontinuity) and B2 §1 (public/private dependency surfaces) are the authority.
- **Evidence:** A6 C1/C2/C3/C4, B3 §10.1, B2 §1.
- **Risk:** Low-medium. The runtime `LoadCommand` _intentionally_ omits `crs` (A6 C2) — the shared type needs a documented narrowing (`Omit`/extension), not naive unification. Get that one field right or you reintroduce the drift you're removing.
- **Blast-radius:** `emit-commands.ts`, `renderer-types.ts`, `interpreter.ts`, `render-node.ts` + every consumer of the expr cast (~the hottest contract). Cross-package; high-leverage single change for the seam.

### REC-5 — Introduce ONE map-session subsystem as the proof-of-concept for lifetime-scoped ownership; make `map.destroy()` its first client.

Extract the device-scope vs map-session-scope vs frame-scope split as a thin typed registry (no DI framework — honor zero-deps); start by moving teardown into `deinitialize()` so `destroy()` becomes compositional.

- **Rationale:** Direct cure for the god-object root (R2) and the missing-`destroy()` ship blocker. B2 §2/§4 is the headline transfer ("Subsystems… directly cures the God-object + missing-`destroy()` debts… _Highest-value item_"); B2 §7 "extract the capability into a self-registering, lifetime-scoped unit and invert the dependency." Do it as _one_ concrete extraction first (Rule of Three discipline, B5 §(b)) — not a 5-authority taxonomy up front (the A5 §4.1 over-engineering trap).
- **Evidence:** B2 §2/§4/§7, A1 §2.2 (8 responsibilities in `map.ts`), A6 §β (no extension seam), B5 §(b).
- **Risk:** Medium. State-ownership extractions are where "fix doesn't hold" lives; gate on the golden-master matrix (B5 §(d)) and Strangler-Fig the migration (B5 §(c)). Resist scope-creep into the full taxonomy.
- **Blast-radius:** Initially narrow (teardown path + one scope boundary); grows as more concerns migrate. Start small, prove the pattern, then ratchet.

### REC-6 — Collapse the "5 authorities / 21 increments" formalism to ~8 plain units and rename off "Blender-DNA."

Rewrite the roadmap header to drop "DNA/RNA" framing and the 6-box authority diagram; keep the 8 real units (table-SoT, dirty bitset, op funnel, camera-state extract, globe-drag, VTR decomp, quantize dedup, label-skip — A5 §4.2).

- **Rationale:** B1 §5 is unambiguous that the Blender-DNA name is a category error to "rename and rescope"; A5 §4 documents that the granularity _itself_ enabled shipping the easy 60% and calling it progress. A leaner plan makes "we did the easy parts and stopped" visible instead of hidden.
- **Evidence:** B1 §5, A5 §4.1/§4.2/§5.
- **Risk:** Low (doc-only) — but politically it forces the admission that S17–S20 are unstarted. That admission is the point.
- **Blast-radius:** Documentation + MEMORY.md (which is over-cap and needs pruning anyway — A5 §3.3). No code.

---

## 5. EXPLICIT UNCERTAINTIES / DISAGREEMENTS

1. **Sequencing tension between REC-1c (cycle gate) and REC-3 (cut the cycle).** The gate can't land as a hard failure until the cycle is gone, and the cycle can't be cut overnight. Resolution proposed: REC-1c lands as _warn_ with the current cycle allowlisted, flips to _fail_ when REC-3 completes. This is an ordering judgment the owner must ratify; I am asserting it, not proving it.

2. **A1 vs A5 verdict-weighting (minor, both 2/5).** A1 frames the strength as "the package DAG is genuinely sound" and the failure as non-execution + no enforcement. A5 frames the failure as the audit-loop anti-pattern (research-to-execution inverted). These are complementary, not contradictory — but if forced to pick the _single_ root, A1's "no enforcement gate" (R1) is more actionable than A5's "planning is comfortable" (a behavioral observation). I weight R1 as the keystone; a reader prioritizing A5 might put REC-2 (stop auditing) first. Both orderings are defensible.

3. **How far the MapLibre `Bucket`/three-way split transfers under WebGPU.** B3 §3 flags one real divergence: WebGPU `GPUBuffer` creation can't happen in a worker without a per-worker device, so X-GIS must keep worker=CPU-typed-array, main-thread=`writeBuffer`. The _structural_ split (Bucket/WorkerTile/ProgramConfiguration) transfers; the _threading_ of GPU resource creation does not 1:1. I have not verified X-GIS's current worker/upload split against this constraint first-hand (A-files did not cover it) — flagging as an open verification item before REC-2/REC-5 touch the upload path.

4. **B5's caution against ECS vs the 4D-city ambition.** B5 §(a) says reject a general ECS for the _map/tile core_ (spatial data = ECS's documented weakness) but leaves a _scoped_ ECS defensible "if the 4D-city scene introduces genuinely many heterogeneous dynamic objects." None of A1/A5/A6 contains evidence about the 4D scene-graph's actual object heterogeneity, so whether a future scoped ECS is warranted is **genuinely unresolved by the present evidence** — gate it on the Rule of Three (three concrete cases), not aspiration.

5. **OperatorBus: kill it or complete it?** A5 §2.3 shows it is a 27-line side-log, not the mutation funnel it was specified as. B1 §3 (command-bus half "partially transfers… keep it thin") and B2 §5 (registration) both suggest a _thin_ command/event surface is legitimate — but neither says X-GIS needs the full "only thing that mutates" funnel. I lean toward "make it a thin event/command bus aligned with MapLibre's `Evented` (B3 §4) and drop the 'mutation authority' grandeur," but this conflicts with the roadmap's stated A2 design, and the owner may have an undo/op-log requirement the audits don't surface. Disagreement flagged, not resolved.
