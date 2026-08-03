# Language v4 research — semantic moats: reference semantics, spatial-temporal queries, cost-model compilation

_docs/research/2026-08-03-language-v4-semantic-moats.md_
_Author: language-advancement analysis session, 2026-08-03. Grounded in the repo at `main` (465d57b lineage); companion to docs/research/2026-07-13-xgis-language-vs-peers.md._

---

## 0. Position — what "v4" means relative to v2 and v3

| Wave   | Epic       | What it does                                                                                                                     | Nature                                                                                               |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| v2     | #1074      | Ergonomics, diagnostics, registry, semantics fixes **inside** the declarative model                                              | Debt paydown (7/10 closed)                                                                           |
| v3     | #1541      | Programmability **of** the model — `fn`, parameterized presets, types, stage blocks, `input`, self-hosting proof                 | Catch-up + escape hatch (peers have equivalents: Tangram blocks, deck.gl hooks, Cesium CustomShader) |
| **v4** | (this doc) | The axes **no peer can structurally follow** — reference semantics, spatial-temporal first-class queries, cost-model compilation | Moat building                                                                                        |

v3 makes the language able to _define_ things. v4 makes the language mean something no styling
language can mean: a verifiable semantics (axis 1), a query model over space and time (axis 2),
and a compiler that owns execution the way a database owns its plan (axis 3).

Everything here is research-stage: each axis ships behind a killer demo, or it does not ship.

---

## 1. Axis 1 — Reference semantics: promote the CPU oracle to the language's definitional authority

### 1.1 What exists (the seeds)

- **`@xgis/shader-dsl` CPU f64 oracle** (`shader-dsl/src/core/cpu-codegen.ts`, `core/oracle.ts`) —
  compiles the same IR module to an f64 CPU function for GPU-parity checks. The package README
  classifies this DISTINCTIVE, and it is: no peer shader path has a numeric reference twin.
- **Mapbox-spec oracle** (`compiler/src/spec/oracle.ts`) — proof the oracle pattern pays: 11
  silent-failure PRs (#94–#105) shared one shape (spec was clear, pipeline drifted, a human
  noticed on a phone); build-time conformance against `@maplibre/maplibre-gl-style-spec` closed
  that loop. `spec/zero-semantics.ts` pins per-property zero-value meaning the same way.
- **Normative grammar + corpus** (#1073): `docs/spec/xgis-language.md` (EBNF, 662 lines),
  25-valid/19-invalid conformance corpus, `scripts/xgis-validate.ts`.

### 1.2 The gap

The `.xgis` language's **evaluation** semantics are defined operationally — by whatever
`compiler/src/eval/evaluator.ts` + the GPU lowering happen to do. The grammar is normative
(#1073); the _meaning_ is not. The shader-dsl oracle covers module-level shader math, not whole
`.xgis` programs; there is no runner that answers "for this program, feature, and camera, what
**value** must every paint property have?" without a GPU.

### 1.3 What to build

1. **Spec: evaluation-semantics chapter.** Extend `docs/spec/xgis-language.md` beyond grammar:
   evaluation order, coercion rules (post-#1066 strictness), the five `PropertyShape`
   evaluation classes (`ir/property-types.ts`) as normative behavior, zero-value semantics
   folded in from `spec/zero-semantics.ts`.
2. **Reference evaluator mode.** A GPU-free runner: `.xgis` program + feature set + camera state
   → the resolved value of every paint/layout property per feature. Composed from parts that
   already exist (the evaluator, const-fold, PropertyShape interpolation, shader-dsl CPU oracle
   for stage-block math once v3 #1538 lands). This is the language's _definition_; the GPU
   pipeline becomes an _implementation_ of it.
3. **Differential harness.** For every conformance-corpus program: reference values vs values
   read back from the real pipeline (uniform captures + compute readback where cheap; §5 render
   gates remain the pixel-level backstop). CI leg is GPU-free for the reference half.
4. **Killer demo:** value-level conformance running in a GPU-less CI job — a regression reported
   as `line-width @ feature 12, zoom 9.5: expected 3.25, got 3.0 (ref: spec §4.2)` instead of a
   pixel diff.

### 1.4 Why peers cannot follow, and what it unlocks

Mapbox/MapLibre semantics live in prose + one implementation; retrofitting a reference evaluator
under a decade of implementation-defined behavior is a rewrite. X-GIS is pre-1.0 with the corpus
already in place — the cost asymmetry is the moat. Unlocks: certifiable portrayal (ECDIS,
ROADMAP Phase 7 — certification wants a defined semantics, not a renderer), server-side
rendering with a value-level contract, and the verification substrate axes 2–3 need.

---

## 2. Axis 2 — Spatial-temporal first-class semantics: from styling language to "SQL of maps"

### 2.1 What exists (the seeds)

- **Time axis, peer-unique** (measured, 2026-07-13 doc §2.3): `keyframes`, zoom×time composed
  `PropertyShape kind:'zoom-time'` — Mapbox has no time axis at all.
- **Spatial predicates, CPU-only**: `within`/`distance` builtins (`compiler/src/eval/within.ts`,
  `eval/distance.ts`) evaluate per-feature on the CPU path.
- **Geometry generators, peer-unique**: `circle/arc/polygon/linestring` construct coordinates
  in-language.
- **Compute codegen**: `compiler/src/codegen/compute-gen.ts`, `compute-plan.ts`,
  `compute-lowering.ts` — WGSL compute kernels already emit from IR for existing paths.
- **Vision already written**: DESIGN.md §5.0.2 (spatial relations as keywords), §5.0.3
  (temporal references, derivatives, windows); ROADMAP Phase 2 `stream`, Phase 4 compute.

### 2.2 The gap

Today's spatial forms are **per-feature scalar predicates** (`filter: within(...)`) evaluated on
the CPU; there are no _set-level_ relations (nearest, spatial join, aggregation), no temporal
data model (the time axis animates **style**, not **data** — no history, no windows, no
derivatives), and no way to express "ships within 5 km of the route, trailing 30 min" without
leaving the language for TS.

### 2.3 What to build — three stages, each gated on a demo

- **Stage A — set-level spatial relations on GPU.** `filter:`-position relations lowered to
  compute kernels via the existing compute codegen: `within <dist> of <layer|geometry>`,
  `inside <region>`, `nearest <n> from <point>`. Classify discipline from v3 applies: a relation
  that cannot lower is a loud diagnostic, never a silent CPU fallback on large sources.
- **Stage B — temporal data model.** Sources gain history: a ring-buffer backing for
  stream/updating sources (Phase 2 `stream` is the natural carrier), and expression forms over
  it — `.position over last 30min` (window → array/trail), `derivative(.position)` (speed),
  windowed aggregates (`max(.speed) over last 1h`). This is where the existing _style_-time axis
  and the new _data_-time axis meet one vocabulary.
- **Stage C — killer demo (the gate for A+B).** S-111 surface currents + AIS tracks: "vessels
  within 2 km of the corridor, colored by 10-min speed trend, trailing 30 min" in ~5 lines of
  `.xgis`. The domain data and portrayal presets already live in the repo
  (`playground/src/examples/libs/s111-portrayal.xgis`, Phase 6 groundwork).

### 2.4 Risks and rails

Scope explosion is the failure mode — this axis is a research program, not one epic. Rails:
ship nothing without its stage demo; every new keyword gets a reference-semantics entry (axis 1)
_before_ GPU lowering; aggregations start as a fixed vocabulary (min/max/avg/count over window),
not user-defined folds. Cross-feature state on GPU must respect the feature-state design when
#1069 lands — same storage substrate, one authority.

---

## 3. Axis 3 — Cost-model compilation: the compiler owns the schedule (Halide's lesson)

### 3.1 What exists (the seeds)

- **`classify` is a proto-planner** (`compiler/src/ir/classify.ts`): five evaluation classes
  (constant / zoom / time / zoom-time / per-feature) already decide _where_ an expression runs —
  rule-based, but the decision point exists and is respected end-to-end.
- **Variant machinery**: `codegen/shader-gen.ts` specializes per-layer WGSL on three axes
  (projection × value constants × feature data) — the mechanism for plan-driven code shape.
- **Measurement hooks**: `shader-dsl/src/core/measure.ts`; the render side already runs
  perf-gated Playwright specs.
- **The philosophy is written down**: DESIGN.md P1 (algorithm/schedule separation), P5
  (compile-time optimization), §5.0 ("X-GIS doesn't know the GPU" — SQL/React analogy);
  ROADMAP Phase 3 execution strategies (auto-instancing, batching, `@strategy` hints).

### 3.2 The gap

Every scheduling decision is a hard-coded rule: backing store (uniform vs storage vs texture) is
fixed per family, interpolation placement is fixed per class, batching is whatever the renderer
does. Rules don't scale to axis 2 — once the language expresses joins and windows, the gap
between a good and bad execution plan becomes 10×, and a rule table cannot hold it.

### 3.3 What to build

1. **`xgisc explain`.** Before any optimizer: dump the current plan per layer — evaluation class
   per property, chosen backing, variant axes, estimated buffer traffic. SQL taught this order:
   EXPLAIN preceded the clever optimizer by decades and is what makes one debuggable. Cheap
   (the facts all exist at lower time) and immediately useful.
2. **A documented cost model.** Per-decision cost terms (bytes uploaded per frame, kernel
   dispatches, varyings) driving backing choice and interp placement — replacing the rule where
   the rule and the model disagree, with the model's inputs logged so a wrong choice is
   attributable.
3. **`@strategy` escape hatch** (ROADMAP Phase 3): author-pinned decisions
   (`@strategy(backing: storage)`) that override the model and show up in `explain` as pinned.
4. **Killer demo:** one real style (OFM Bright import) where `explain` shows the plan, a model
   change moves a property from per-feature-CPU to GPU (or a backing from uniform-churn to
   storage), and the §5 perf gate measures the win on the same commit — a metric gradient with
   a controlled x-axis (Lessons Ledger: same-commit re-runs, no run-order noise).

### 3.4 Why last

The optimizer's value compounds with axis 2 (richer declarations → wider plan space) and its
safety depends on axis 1 (plan changes must be provably value-preserving against the reference
evaluator). Building it first would optimize a language that doesn't yet say much.

---

## 4. Sequencing, prerequisites, and the demo gate

```
v3 #1541 (programmability)          — in progress; prerequisite for stage blocks & self-hosting
   │
Axis 1  reference semantics         — start after v3's fn/types stabilize the surface;
   │                                   cheap, mostly assembly of existing parts
Axis 2  spatial-temporal (A → B → C) — each stage gated on its demo; needs axis 1 entries
   │                                   per new keyword; stage B rides Phase 2 streams
Axis 3  cost-model compilation       — explain first (anytime), model after axis 2 stage A
```

Uniform discipline per increment, in this order: spec section → conformance-corpus entries →
fail-before test → implementation → demo. The version pragma (#1064) gates any breaking
surface change, and external users are still zero — the same "breaks are cheap now" window
#1074 identified applies to v4's vocabulary choices.

## 5. Relationship map

- **#1074 (v2)** — open tails #1069 (feature-state; shares the GPU state substrate with axis 2
  stage B), #1070 (animation axes; the style-time half of axis 2's vocabulary), #1073 (LSP/fmt;
  derive from `LANGUAGE_SCHEMA` so v4 vocabulary propagates to tooling for free).
- **#1541 (v3)** — hard prerequisite: axis 1's reference evaluator needs `fn`/stage-block
  semantics to be _defined things_; axis 2's relations reuse v3's classify discipline.
- **ROADMAP** — axis 2 = Phase 4 (compute) pulled through the language, with Phase 6 (S-100)
  as its demo domain; axis 3 = Phase 3's execution strategies made measurable; axis 1 = the
  unstated foundation of Phase 7 (certification, server rendering).
- **DESIGN.md** — axis 3 is P1/P5 made real; axis 2 is §5.0.2/5.0.3 made real; axis 1 has no
  DESIGN section yet and should get one when it graduates from research.
