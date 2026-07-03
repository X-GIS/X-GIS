# A4 — Shader/render pipeline structure + the behavioral-bug detection void

_Adversarial architecture audit, 2026-06-08. Axis: is the shader-DSL single-emit a good abstraction or another god-area; is the render-pass chain clean; and — the owner's core complaint — **can the test architecture catch "compiles and passes unit tests but does not actually work" bugs?** Every claim is file:line. FACT = verified in code; INFERENCE = labelled._

**Verdict: 3 / 5 on 5-year sustainability for this axis.** The structure is genuinely better than the rest of the codebase — the pass chain and the IR core are real, clean abstractions. But the test _architecture_ structurally **cannot** catch the bug class the owner is angry about, and one "pass" is a 1065-LOC god-method hiding behind a clean interface.

---

## 1. Is the shader-DSL single-emit a GOOD abstraction or a god-area? — MIXED, leaning GOOD

### 1a. The IR core is a real, small, layered abstraction — GOOD (evidence)

`shader-dsl/core/` is **2331 LOC total** across 16 files (FACT: `wc -l shader-dsl/core/**`), split into `ir/` (typed nodes, builder, match-expr) and `backends/` (`wgsl.ts` 196, `wgsl-lower.ts` 199, `cpu.ts` 342). No file exceeds 406 LOC. This is the _opposite_ of a god-area: one node graph, two backends (WGSL for GPU, CPU for the f64 parity mirror). The dual-backend design is the load-bearing payoff — `cpu.ts` lowers the _same_ IR the GPU runs, which is what makes `_shader-math-parity` a real cross-check rather than two hand-maintained copies (ADR-0003:80-86). This is a legitimately good decision and it is implemented, not aspirational.

### 1b. PROJECTIONS-table-as-authority is real and gated — GOOD (evidence)

The threshold-drift gate (ADR-0003:151) parses the cull `select()` / rim `smoothstep()` literals back out of the _emitted_ WGSL and asserts they equal the `PROJECTIONS` rows. ADR-0003:45-48 records the discriminating evidence: _before_ the table was authority, mutating a single cull literal in the WGSL string left the whole suite green. That is exactly the right kind of gate — it pins the emitted string to data. FACT: the gate file exists (`projection/projection-threshold-drift.test.ts`, referenced ADR-0003:151).

### 1c. The DSL is HYBRID, not single-emit — LEAKY (the ADR admits it, and the gate doesn't cover the leak)

The name "single-emit" oversells it. FACT:

- `polygon.ts` (1139 LOC) and `point.ts` (458 LOC): IR-builder, ~0 raw `@vertex`/`@fragment` markers (`grep -cE '@vertex|@fragment' point.ts` → 0).
- `line.ts` (1189 LOC): **`emitLineWgsl` returns a `[...].join` of mostly hand-written WGSL strings** (`line.ts:1105`), with 23 raw-WGSL backtick/`fn`/`@vertex` markers. ADR-0003:166-171 openly admits this: "line, point, and raster shaders still author their _surface-specific_ bodies as hand-WGSL strings that prepend the shared emitted projection block."

So "all WGSL is emitted from the DSL" (ADR-0003:10) is true only for the _shared projection block_. The surface bodies of line/raster are still hand-WGSL concatenation. That is fine as a migration state — but the **byte-drift snapshot gate that pins emit stability exists for polygon ONLY** (FACT: `__polygon-variant-snapshots__/` has 8 committed `.wgsl` fixtures; `find … -name '*snapshot*' -o -name '*variant-diff*'` returns **only** polygon). Line, point, and raster emit have **no per-commit emit-stability gate**. A refactor that silently changes the line shader's emitted string is caught only by `_wgsl-compile-gate` (compiles? yes/no) — not by "did the output change unexpectedly?". The strongest guard rail in ADR-0003 protects the one surface that least needs it (polygon is already full-IR) and skips the two that still concatenate raw strings.

### 1d. The shader files are large but not god-files — borderline (evidence)

`line.ts` 1189, `polygon.ts` 1139, `projections.ts` 441, `point.ts` 458 (FACT: `wc -l`). These are big single-responsibility files (one surface's shader each), not multi-responsibility god-objects. Acceptable. The real god-files live one layer up (§2c).

**Net on the DSL:** a good abstraction with a real IR core and a real authority gate, undersold-named as "single-emit" when it's a hybrid, and with an emit-stability gate that covers 1 of 4 surfaces. Sustainable. INFERENCE: the highest-value cheap fix here is to extend the polygon byte-drift snapshot pattern to line/point/raster.

---

## 2. Is the render-pass chain clean? — YES at the top, NO one layer down

### 2a. The chain itself is clean — GOOD (evidence)

FACT: `render-loop.ts:472-494` is a flat, linear, declarative chain:

```
backgroundPass.execute → opaquePass.execute → oitPass(.shouldRun)→execute
  → translucentPass(.shouldRun) → pointsPass(.shouldRun) → labelPass.execute
  → overdrawComposePass(.shouldRun)
```

Each pass is a stateless singleton implementing a 3-member interface (`pass.ts:23-31`: `label`, `shouldRun(scene)`, `execute(ctx, scene, host)`). No per-frame allocation, behaviour relocated byte-identically from the old inline blocks (`pass.ts:8-12`). The classifier feeding it (`bucket-scheduler.ts`, 433 LOC) is **pure, side-effect-free** (`classifyVectorTileShows`, documented NONE side effects at :15, returns `{opaque, translucent, oit}`), and is _separately tested_ precisely because two earlier refactors "shipped silent classification bugs that the smoke test couldn't catch" (`bucket-scheduler.ts:18-23`). Extracting a pure classifier so it can be fixture-tested without a GPU is the correct response to the owner's complaint. This is the best-architected part of the render path.

### 2b. `label-pass.ts` is a god-pass hiding behind the clean interface — BAD (evidence)

FACT: `label-pass.ts` is **1065 LOC** — 12× the next-largest pass (`opaque-pass.ts` 225; most passes are 32-95 LOC). Its `execute()` method runs from **line 42 to ~1024** — a single ~980-line method (FACT: `shouldRun` at :40, `execute` opens at :42, the function's `perfMarkEnd('encoder.label-dispatch')` closes at :1024). Inside it: **13 perfMark sub-phases** and **12 local helper closures** defined inline (`dispatchIcon`, `emitLabelAlongSegment`, `recordTextPosition`, projection mirrors, line-label polyline walkers). The clean `RenderPass` interface is a façade over one of the largest single functions in the codebase. This is the exact god-object pattern the pass-chain refactor claims to have eliminated — it was relocated, not decomposed. INFERENCE: this is also why label bugs recur across the memory log (CJK box-out, bearingY collapse, anchor parity, world-copy gaps) — the label path is a 980-line method with point/line/icon/dedupe/projection all interleaved, so a change to one sub-phase has no local blast radius.

### 2c. The real god-files sit under the chain — BAD (evidence)

FACT (`wc -l`): `vector-tile-renderer.ts` **5440 LOC**, `renderer.ts` **1947 LOC**, `line-renderer.ts` 27.7K, `point-renderer.ts` 36.8K bytes. The clean pass chain _delegates into_ these. So "the render-pass chain is clean" is true for the orchestration spine and false for the bodies it calls — VTR at 5440 LOC is the single largest debt in the render path (consistent with MODULES.md flagging it #1, per memory). A clean conductor in front of a 5440-LOC monolith does not make the orchestra clean.

**Net on the chain:** spine clean (5/5), classifier clean and correctly pure, but two of the things it calls (`label-pass` 1065, `vector-tile-renderer` 5440) are god-bodies. The cleanliness is real but shallow.

---

## 3. THE CORE COMPLAINT: "bugs can't be seen from code alone" — the test architecture CANNOT catch them. (3/5, structurally)

This is the load-bearing section. The owner is right, and the numbers prove it.

### 3a. QUANTIFIED test reality — what actually verifies RENDERED OUTPUT vs CPU math

FACT (greps over `runtime/src`):

| Metric                                                                                                                   | Count   | Source                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------- |
| Runtime unit tests (`*.test.ts`)                                                                                         | **262** | `find … -name '*.test.ts'`                        |
| Compiler unit tests                                                                                                      | 326     | `compiler/src`                                    |
| Blueprint unit tests                                                                                                     | 3       | `blueprint/src`                                   |
| Runtime tests that **instantiate a real GPU device** (`requestDevice`/`requestAdapter`)                                  | **1**   | `webgpu-stub.test.ts` only                        |
| Runtime tests that **read back a framebuffer / pixels** (`readPixels`/`copyTextureToBuffer`/`getImageData`/`pixelmatch`) | **1**   | `synthetic-earth-surface-world-band.test.ts` only |
| Runtime tests that call `.render()`                                                                                      | **0**   | grep `\.render(` → 0                              |
| Runtime tests that mock/stub GPU                                                                                         | 61      | —                                                 |
| Playground e2e `.spec.ts` total                                                                                          | 214     | —                                                 |
| e2e specs that **actually run in CI**                                                                                    | **4**   | `test.yml:100` (literal filename list)            |

**Reading:** of 262 runtime unit tests, **260 are pure CPU math/logic**. Exactly **one** touches a GPU device, **one** reads a pixel, **zero** drive `render()`. The entire ~591-test unit suite (262+326+3) verifies _component math on the CPU_. This is precisely the owner's diagnosis, now measured: the tests verify the math, the bugs live in the rasterized output, and the two sets do not intersect.

### 3b. Why behavioral bugs hide — the structural chain (FACT, from ADR-0004 + test.yml)

1. **CI has no GPU.** GitHub Linux runners have no GPU; the only adapter is SwiftShader (ADR-0004:24-26, `test.yml:9-10`).
2. **SwiftShader cannot raster X-GIS.** Pixel assertions false-positive (artifacts, not regressions) and the full pipeline-init times out under it (ADR-0004:30-37, `test.yml:63-72`). So CI _cannot_ run any rasterizing test even if it wanted to.
3. **Therefore CI runs exactly 4 specs, all pure-compute, all never-paint** (FACT: `test.yml:100` lists literally `_shader-math-parity _wgsl-compile-gate _vs-clip-parity _dequant-parity`). They cover: WGSL compiles, `project()` math matches CPU, VS-clip matches CPU, dequant matches CPU. **Not one of them produces or inspects a pixel.**
4. **The real-GPU matrix gate is local-only** (ADR-0004:107-119). It is _not_ wired to any CI job. It runs on a dev box, headed, by a human or the screenshot-eyeball loop. INFERENCE: a gate that lives only on one developer's machine and is run manually is, for regression-prevention purposes, **not a gate** — it is a debugging tool. ADR-0004:195-200 even concedes this: "A purely visual regression that does not touch shader math … can pass CI and reach a branch. Mitigation is procedural."

**So the answer to "why do behavioral bugs hide": every automated gate that runs without a human is pure CPU/compute. The only thing that looks at a rendered frame is a local, manual, real-GPU run. There is no automated raster regression gate anywhere in the pipeline.** This is not a coverage _gap_ that more unit tests fix — it is the architecture, and ADR-0004 argues (correctly) that it is _forced_ by the no-GPU-CI constraint.

### 3c. What the matrix gate actually covers — and its own holes (FACT)

The matrix (`matrix.manifest.ts`, 888 LOC) has **45 cells** using these oracle kinds: `black_ratio`×32, `ink_family`×23, `finite_mvp`×18, `disc_fraction`×9, `numeric_forward`×6, `screenshot_diff`×3, `frame_stability`×3, `post_change`×2, `label_onscreen`×2, `pixel_ref`×1. Observations:

- It is heavily **presence/framing tripwires** (`black_ratio`, `ink_family`, `disc_fraction` = "is there ink, is the disc roughly the right size") — explicitly _not_ exact assertions (`matrix.manifest.ts:56-61, 73-80` call them "tripwire, not an exact-fraction assertion"). These catch catastrophic failures (disc absent → 0, flood → 1), not subtle drift.
- Only **1 `pixel_ref` and 3 `screenshot_diff`** cells — actual image comparison is the rarest oracle.
- **26 of 45 cells are `expected_red`** (FACT: `grep -c expected_red` → 26) — _more than half the matrix documents known-broken behaviour_ coerced to soft (azi/stereo cap, equirect/NE deep-zoom drift, antimeridian seams, oblique polar tearing). The manifest's self-description at line 1-17 is blunt: "This is a SKELETON, not coverage."
- **The `expected_red` flip-alert is ABSENT** (FACT: `grep -rn 'EXPECTED_RED|FIXED:'` across manifest/oracles/evaluator → **zero hits**). Audit ③ §E flagged this as a one-line fix; it is on the task list (Step 1.5, still pending). Consequence: when one of those 26 known bugs gets fixed _or regresses past threshold_, the cell flips silently with no signal (`matrix-types.ts:131` `effectiveGate` coerces it to soft either way). The canonical stale-baseline failure mode is live in-tree.

### 3d. The OIT case study — the void made concrete (FACT, audit ⑦)

OIT is the sharpest example of "compiles + passes unit tests + does not work." FACT (`bucket-scheduler.ts:284`): `const isOitExtrude = false` — hardcoded off. The OIT pipeline is _created_ (`renderer.ts:971-1008`) and the pass exists, but `ClassifiedShow` carries no OIT pipeline, so the routing from a classified show to the OIT path **does not exist** (`2026-06-audit-oit-compositing.md` B1). The `oit` bucket in `bucket-scheduler.ts:352` only fills when `isOitExtrude`, which is always false → the bucket is always empty → `oit-compose-dsl.test.ts` checks emit _shape_ only, never the algebra. Result per audit ⑦: **translucent extrusions today composite via order-dependent alpha blending** — the exact non-commutative-"over" bug OIT exists to fix is currently unsolved, and **zero tests cover it** because every test that could is either shape-only or lives in the local-only matrix (which has no OIT cell — audit ③ D1, CRITICAL). This is the bug class the owner named, sitting in the tree right now, green across all 591 unit tests.

### 3e. What the architecture CAN catch — fair credit (FACT)

The CI tier is not a token gesture. It _will_ fail on: any emitted WGSL that won't compile (`_wgsl-compile-gate`), gross `project()` drift (`_shader-math-parity`, ~hundreds-of-km threshold, ADR-0004:154-158), VS-clip / dequant divergence, and — importantly — the **cross-validation tier** (`cross-validation.test.ts`) pins CPU math against _independent_ pyproj/mercantile/shapely fixtures, catching "same bug in both CPU and WGSL" that intra-repo parity cannot (ADR-0004:159-164). So the architecture reliably catches the **math/compile** bug class. It is the **raster/behavior/event/memory** class it cannot touch automatically.

---

## 4. Verdict: can the test architecture catch "compiles + passes unit tests but doesn't work"?

**For math/compile bugs: YES** (CI compute tier + cross-validation). **For rendered-output / event / memory / timing bugs: NO, by construction.** The numbers: 260/262 runtime tests are CPU-only; 4 specs run in CI and none paint a pixel; the one raster gate is local-only and manual; 26/45 matrix cells are known-broken with no flip-alert; the OIT translucency bug is live and untested today. The owner's complaint — "bugs can't be seen from code alone" — is **structurally correct and measurable**, not a vibe.

**Why 3/5 and not lower:** the strategy is the _right_ response to a real constraint (no-GPU CI), ADR-0004 is an honest, well-reasoned account of the forced split, the IR core and pass spine are genuinely good, and the gaps are _enumerated_ (audits ③/⑦ list them with file:line). A 1/5 axis would be unaware of its blind spots; this one has mapped them precisely. **Why not higher:** the mapping has not been _closed_. The cheapest, highest-signal, GPU-free fixes have sat un-done — the `expected_red` flip-alert (1 line, audit ③ §E, still task-pending), the polygon-variant compile gate extension to fixtures (~20 lines, audit ③ D3), and extending byte-drift snapshots to line/point/raster. Until a **GPU-enabled CI runner** exists (ADR-0004:190-192 names it the "lasting unlock"), the raster regression class is mitigated only "procedurally" — i.e. by human discipline, which is exactly what fails under deadline pressure and is why the same bug classes recur in the memory log.

### Top-3 concrete actions (GPU-free, by leverage)

1. **`expected_red` flip-alert** (`matrix.manifest.ts`/evaluator, ~1 line): surface when any of the 26 known-broken cells flips. Stops silent fix/regression. (Already scoped as task Step 1.5 — do it.)
2. **Extend emit-stability snapshots to line/point/raster** (mirror `__polygon-variant-snapshots__`): the byte-drift gate currently protects only the one surface that's already full-IR; the hand-WGSL-string surfaces (`line.ts:1105`) have no emit gate at all.
3. **Decompose `label-pass.execute()`** (1065 LOC, one ~980-line method, 12 inline closures): the only "pass" that is a god-method; its size correlates with the recurring label-bug history. Pull the 13 perfMark sub-phases into named, fixture-testable units the way `bucket-scheduler` was extracted.

The structural unlock (out of scope for this axis but naming it): a GPU-enabled CI runner converts the local-only matrix from a debugging tool into an actual regression gate — without it, no amount of test authoring closes the raster void.
