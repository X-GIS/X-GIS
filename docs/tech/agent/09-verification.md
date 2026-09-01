# 09 — Verification: the gate ladder, fail-before, and hash-equality rendering

> Edition: **agent**. Companion: [`../dev/09-verification.md`](../dev/09-verification.md).
> Authority docs: `docs/verification/STRATEGY.md`, `MATRIX.md`,
> `docs/adr/0004-verification-gate-strategy.md`, `.github/workflows/test.yml` (1,333 lines,
> mostly rationale comments), CLAUDE.md §5/§12/§13.

X-GIS's test LOC exceeds its source LOC. This chapter is why that isn't waste: a GPU
renderer's worst bugs are invisible to type checkers, unit tests, and even green CI —
"nine commits, 3,900 green unit tests, green typecheck, fifteen green CI checks, zero
pixels drawn" (`the-feature-that-rendered-nothing`). The verification system is designed
as layered instruments, each validated against the failure class the layer below cannot
see.

## 1. The organizing constraint

*"CI = compute/compile only. Render-correctness = local, real GPU. That sentence is the
whole strategy"* (STRATEGY.md). Forced, not preferred: CI runners have no GPU. Later
**narrowed by measurement** (and the narrowing itself is a lesson): SwiftShader *does* run
both WebGL2 and WebGPU headlessly for compile/link/validate/draw correctness — an earlier
"WebGPU does not run here" claim cost real work when quoted as a reason not to verify;
what stays local-only is timing and hardware-raster fidelity. A `test.fixme()` whose
stated reason is "no real GPU here" is treated as a bug to re-check, not a fact.

## 2. The tier ladder

1. **Unit (vitest)** — never executes a shader. Split into 11 CI legs **not for
   parallelism** but because vitest's worker→main reporter RPC times out past ~110 files
   per leg ("all 2,592 tests passed and the job failed"); the playbook is split-the-leg,
   never merge back.
2. **CI render-gate under SwiftShader** — pure compute or pure compilation. Tolerances are
   **GPU-class-aware**: hardware 100 m absolute; SwiftShader `max(3000 m, |v|·2e-3)`
   (~6× above its measured software-transcendental noise). Net contract: CI catches gross
   shader-math breakage; the tight hardware gate catches subtle drift SwiftShader cannot
   see.
3. **Local real-GPU** — pixel survey vs MapLibre with two complementary thresholds per
   view: `gt128` (local sharp divergence) and `eqFloor` (global soft shift) — the second
   exists because halving every fill's alpha left `gt128` unchanged while exact-equality
   cratered 97→12 %. Label fidelity is gated on **position, not pixels** (adding correctly
   placed labels *lowers* pixel-match at every tolerance).
4. **Cross-validation against independent references** (pyproj/mercantile/shapely) —
   everything else only proves "our CPU matches our WGSL" and cannot catch **the same bug
   in both**.

A real GPU bug walks *up* the ladder: eyeball loop → characterize → local numeric gate →
reduce to compute → CI merge blocker.

## 3. The render-gate ladder (within tier 3)

Rung 1 — **directional diff** for an intentional change: `DC > 0` (before-vs-after proves
something changed) and `D1 < D0` (vs the reference proves the direction). Never gate on an
absolute percentage — the reference diff is noisy.
Rung 2 — **threshold `DC = 0`** for parity, valid only after measuring the same-code noise
floor (a 0.020 % "regression" was once resolved by running the *same code twice* and
measuring 0.023 % of harness jitter, confined to a HUD band).
Rung 3 — **hash equality**. Reachable only because determinism is *engineered into the
harness*: a pinned camera, N invalidate-pumped frames so render-on-demand converges before
capture, and a software rasterizer with no frame-to-frame nondeterminism. Three captures
(before at merge base, after at tip, after again as control) hashing identically upgrades
a parity claim to bit equality — "verification collapses from statistics to md5sum."
Remove any one leg and the noise floor lifts off zero.

Capture discipline (owner-mandated, encoded as a skill and helpers): frames come from a
chrome-hiding `captureMapFrame` (a clipped canvas-box screenshot is NOT chrome-free — an
on-canvas status line whose text is a function of missing-tile count was ~53 % of one
gate's diff); settling uses `awaitMapIdle` (transition-only event + loud timeout), never
sleeps; wall-clock-driven render inputs are pinned (`?adaptive=0` at module load — the
adaptive controller changes the *tile set* on a slower machine, and hash equality has no
tolerance to absorb it). Reading a diff means reading the **image at full resolution in a
4×4 tile split** plus a magnified crop — `Read`-style downscaling silently erases the
sub-pixel offsets real bugs live in; paired red/blue edges = positional shift, red both
sides = width change. Numbers never decide alone.

**Cross-gate agreement is cheap evidence**: two gates toggling disjoint flags produced the
same unexplained hash pair — one pair cannot be caused by two different flags, so it had
to be the harness (it was boot order). After the fix the two gates agree hash-for-hash
across four states, "which no single gate fixed to suit itself could fake."

## 4. The MATRIX: a permanent tripwire with anti-blessing coercion

A real-GPU sweep across projection × pitch × zoom × data × surface, explicitly "a
tripwire, not an exhaustive gate: a green matrix does not prove correctness; a red cell
proves something moved." Two structural safeguards worth copying: `effectiveGate(cell)`
**forces a cell soft** whenever its status is candidate/expected_red *regardless of its
declared gate* — "an unreviewed baseline or a documented bug can never block a push. That
is structural, not a matter of author discipline." And only the screenshot-diff oracle
stores a baseline PNG (the one oracle needing a human gate); math/closed-form oracles
regenerate every run so nothing goes stale. The single baseline writer refuses to
overwrite without `--force` and stamps reviewer/commit metadata.

## 5. Fail-before, tightened four times

1. **Base rule**: prove the test RED **for the right reason** (the intended assertion, not
   a compile error), then implement, then GREEN, logging the transition. Green-only tests
   prove nothing.
2. **Cut the mechanism**: a gate can be deterministic, loud, specific, and worthless — one
   asserted on triangles, and severing the exact wire it existed to watch failed
   *identically* to the wire working. Don't just check fail-before goes red; **cut the
   specific mechanism and confirm the failure message names the severed half.** Assert the
   cause before the effect (assertion order decides which half a red run accuses — a dead
   lever and an ignored live lever leave the same downstream histogram).
3. **Representative inputs**: assertions can be fine while the inputs carry no
   information — five green tests all passed whole typed arrays (`byteOffset 0`), the one
   shape where the bug is invisible; production passes subarrays. Feed at least one input
   shaped like real callers', and plant a decoy around it.
4. **Validate the instrument**: the measuring tool itself can be blind, and a blind
   instrument reports ZERO, which reads as a finding — a text-regex over CSE'd emitted
   shaders measured "0 optimization sites" 13 times out of 15 (the IR said 37, or 2,420
   inlined), and the same blind probe produced a false safety claim that reached main.
   **Validate the instrument against a known positive before believing a zero; read a
   uniform zero as a broken ruler, not a clean corpus.** The same applies to pollers: an
   unauthenticated CI poller turned an auth error into an empty check list and declared
   "all green" in under a second — never treat a missing key as an empty result; check
   that a wait actually waited.

Corollaries embedded in the gates themselves: detector-liveness assertions (the gate's own
regex must see a planted positive and ignore a planted decoy); population assertions ("a
gate that does not prove its own population is the bug it guards against, one level up" —
the spec-collection gate first asserts >300 specs exist); structural/directional
assertions over pixel counts (a pixel-count gate passed on a broken image; a
contiguous-run gate separates "a wall of stroke pixels" from "a line"); and a rule that
new gates are trusted only after **breaking the feature on purpose** and watching red
("a gate that cannot fail is decoration" — they broke instanced batching and watched
100,000 draw calls before trusting the green; the assertion is the N-independence
invariant `dc(10k) === dc(100k)`, not a pinned count).

## 6. CI wiring (the non-obvious mechanics)

- The `changes` job computes render/code/site filters in <5 s; the workflow deliberately
  has **no `paths-ignore`** — branch protection requires named contexts, and a workflow
  that never runs strands docs-only PRs on "Expected — waiting" forever; expensive jobs
  skip their **steps** instead (a skipped required check counts as pass). Job-level `if:`
  is forbidden on matrix jobs (evaluated before the matrix expands, so the required
  per-leg contexts never post).
- Render e2e is sharded 6 ways over an explicit spec list, `WORKERS=1` per shard — two
  workers in one runner **contend for a single SwiftShader rasterizer** and lose a random
  spec (three consecutive runs red on three different specs). N=6 chosen from measured
  per-shard times ("the slowest shard is the wall clock; N=6 is where the curve bends");
  residual spread deliberately not fixed by hand-grouping (a duration-keyed grouping goes
  stale silently — the path-keyed-gate failure one level up).
- **Vacuous-shard guard**: a shard matching zero tests exits 0 printing nothing, so the
  step greps for `Running [1-9]… test` and preserves the real exit code around the
  diagnostic (a trailing grep otherwise *becomes* the exit code — the mirror of pipe
  laundering: one hides a failure, the other invents one).
- **Flake accounting**: with retries, fail-then-pass exits 0 and the check-run API carries
  empty output, so flakes went unrecorded; a reporter lifts Playwright's own accounting
  into a `::warning::` annotation. It reports, it does not gate. Session rule: "a fixed
  flake is not fixed until a run SINCE the fix shows it clean."
- Aggregator contexts (`test-result`, `render-gate`) are the only required checks — stable
  names immune to leg renames (requiring leg names once blocked every PR). Both treat
  `cancelled` as **failure** (passing on it would green a required context with nothing
  having run). Push runs are never auto-cancelled (each run's filter scopes to its own
  diff, so "only the tip matters" is false of a run's *coverage*); a post-merge guard
  exists because a merge once landed 3m54s before its own red result reported, breaking
  main for 2.5 h.
- Meta-gates test the CI itself: the paths-filter's actual matching semantics (a leading
  `!` under the default quantifier means the opposite of what it reads), workflow-file
  validity (a workflow once ran 56 times with zero jobs), shard-family coverage (a missing
  leg reports green), PR-title lint (the squash title becomes the changelog subject and
  commitlint never sees it).

## 7. Bake/emit determinism gates

Byte-determinism is treated as a property to measure, then exploit: shader emission is
byte-deterministic across processes (measured, six runs), which upgrades the baked-shader
gate to hash equality with completeness and meta legs; polygon variant emission is pinned
by byte-equal snapshots with commit-ancestry checks (and a recorded shallow-clone trap
where "not an ancestor" is a clean wrong answer). The bake is never wired into the build
that gates it ("green by construction proves nothing").

## 8. The failure archive

74 postmortems under `site/src/content/blog/`, each frontmatter description an abstract;
CLAUDE.md mandates grepping the corpus **before** debugging in an area. Deliberately **no
index file** — a hand-synced index would be the exact two-authorities drift the corpus's
own "second ratchet" entry documents. Rules are added to the CLAUDE.md ledger only when an
incident recurred or plausibly will, one actionable line plus citation. Session-start
discipline (§13): everything inherited from a previous session — a green check, "that
flake was fixed", an installed node_modules — is *a claim left by someone no longer here*;
a script checks the mechanical half (branch/HEAD/dirty/deps declared-but-not-installed),
and the rest is re-reading evidence.

## 9. Transferable design rules

1. **Split verification by what each tier can honestly see** (no-GPU CI: compile +
   compute; real GPU: pixels; independent references: shared-bug immunity), and write each
   instrument's blindness statement next to it.
2. **Engineer determinism, then gate on hash equality.** Pinned camera + pumped
   convergence + software rasterizer + chrome-free capture + pinned wall-clock inputs
   makes `md5sum` a render gate; measure the same-code noise floor before trusting any
   threshold.
3. **Directional and structural assertions over absolute pixel scores**; two thresholds
   (sharp-local + soft-global) where you must score; position-based gates for content
   whose correctness isn't pixel-shaped.
4. **A baseline no human reviewed must not be able to block anyone** — coerce unreviewed
   cells to soft structurally; single baseline writer; regenerate every non-human oracle.
5. **Fail-before, then cut-the-mechanism, then representative inputs, then instrument
   validation** — in that order, for every new gate. Break the feature once on purpose.
6. **Gates need liveness and population proofs**, vacuity guards on every path-keyed
   allowlist, and their own meta-gates (CI config is code with its own bug classes).
7. **Count flakes without gating on them**, and treat "fixed" as unproven until a
   post-fix run is clean.
8. **Keep a postmortem corpus with grep-first discipline and no secondary index**; promote
   recurring lessons into a short ledger with citations.
9. **Sharding is for infrastructure limits, not speed** — know which limit (reporter RPC,
   rasterizer contention) each split serves, and guard empty shards loudly.

## 10. Code map

- Strategy: `docs/verification/STRATEGY.md`, `MATRIX.md`, `docs/adr/0004`
- CI: `.github/workflows/test.yml`, `scripts/{paths-filter-semantics,workflow-validity,
  render-shard-coverage,post-merge-guard,flaky-report}.test.ts`,
  `playground/src/e2e-specs-load.test.ts`
- Harness: `playground/e2e/helpers/visual.ts` (`captureMapFrame`, `awaitMapIdle`,
  `DEMO_CHROME_IDS`), `.claude/skills/{compare-parity-pixeldiff,tile-crop-review,
  capture-canvas}/`
- Fail-before: `.claude/skills/spec-wiring-corpus/SKILL.md`, CLAUDE.md §5/§12
- Postmortems: `site/src/content/blog/` — start with `the-second-ratchet`,
  `a-gate-that-cannot-fail-is-decoration`, `the-strongest-render-gate-is-hash-equality`,
  `what-a-software-gpu-can-verify`, `the-feature-that-rendered-nothing`,
  `every-test-passed-offset-zero`, `seven-ways-the-harness-lied-to-me`
