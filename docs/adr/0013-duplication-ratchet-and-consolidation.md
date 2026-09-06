# ADR-0013: Duplication ratchet + consolidation policy

- **Status**: Accepted
- **Date**: 2026-09-05
- **Related**: `.jscpd.json`, `scripts/dup-ratchet.ts` (+
  `scripts/dup-ratchet.test.ts`), `.github/workflows/test.yml` (`lint` job),
  `scripts/precheck.ts` (`bun run dup` / `dup:report` / `dup:shape`),
  `map/src/loc-ceiling-ratchet.test.ts`,
  `engine/src/dependency-direction-ratchet.test.ts`, CLAUDE.md §14,
  `docs/plans/2026-09-05-code-duplication-audit.md` (the measured audit + work queue)

## Context

X-GIS grew feature by feature to ~232k lines of source (~528k with tests). The owner's
concern (2026-09-05): that growth left **fitted code** — implementations shaped for one
feature and copied for the next — rather than generic foundations. Copies are also where
this repo's dominant bug archetype lives: two paths that must agree (fill/outline, CPU/GPU,
main-thread/worker) drifting apart silently (`docs/COORDINATES.md`, the debug-toolkit skill).

Measured with jscpd 5.1.2, tests excluded, `mild` mode (comments and blank lines skipped),
`.ts/.tsx` through the JavaScript tokenizer (Decision 1 explains why):

| minTokens / minLines   | clones  | duplicated lines | files at or above the floor |
| ---------------------- | ------- | ---------------- | --------------------------- |
| 50 / 5                 | 601     | 5678 (2.44%)     | 904                         |
| **70 / 5 — the gate**  | **280** | **3423 (1.47%)** | 898                         |
| 100 / 5                | 142     | 2177 (0.94%)     | 895                         |
| 70 / 5, tests included | 1940    | 28123 (5.33%)    | 2541                        |

Where it is at 70/5: intra-file 115 clones / 1460 lines, intra-directory 131 / 1797,
intra-package 22 / 280, cross-package 12 / 166. **Ninety-five percent of the duplicated
lines sit inside one file or one directory** — sibling families copied per primitive
(retained packers, retained materials, retained DSL shaders and their feat-layouts; the
source backends and the main-thread/worker MVT decode twin; paint converters; the
fullscreen compose shaders) and repetition inside god-files (`map.ts`,
`vector-tile-renderer.ts`, `renderer.ts`, `shaders/dsl/polygon.ts`). Cross-package is small
but each pair is two authorities for one fact: `invert4x4` in `geo/` and `shared/`; the
fullscreen-triangle vertex stage in `engine/`, `map/` and `rhi-webgl2/`; hex-colour parsing
in `compiler/` and `map/`. The ranked list with remedies is the audit document.

None of the existing gates sees this. LOC ceilings measure size; the dependency-direction
ratchet measures edges; knip measures reachability; ESLint has no cross-file rule. Nothing
measured repetition, so the only thing between a third copy and a fourth was a reviewer
noticing.

### The second question: the duplication that is NOT textually identical

The owner's follow-up the same day: what about code that is not a verbatim copy — the same
shape re-flowed, a function re-created under a different name, a family that should have
been one abstraction and was written N times instead? That is the larger half, and a token
detector is blind to all of it, because the sibling families here differ in exactly the
identifiers that say which primitive they serve.

The standard vocabulary (Roy & Cordy, 2007) separates it cleanly, and each row has a
different instrument and a different honest answer:

| type | what differs                                      | instrument here                                           |
| ---- | ------------------------------------------------- | --------------------------------------------------------- |
| 1    | whitespace and comments only                      | `bun run dup` — **gated**                                 |
| 2    | identifiers, literals, types                      | `bun run dup:shape` / `--type-insensitive` — report       |
| 3    | copied, then edited (statements added or removed) | partly, wherever the unedited part still clears 70 tokens |
| 4    | same behaviour, independently written             | **nothing, by choice** — Decision 5                       |

Type-2 was measured by mirroring the tree with every identifier rewritten to `_`, every
string to `"S"` and every number to `0` (TypeScript's own scanner; comments blanked to
spaces so line numbers still point at the real file), running the same `.jscpd.json` over
the mirror, and subtracting the pairs the token pass already covers. At `6c2fdfd` the 802 raw
shape pairs
decompose, and the decomposition is the honest part:

| bucket                                                       | pairs   | lines    |
| ------------------------------------------------------------ | ------- | -------- |
| self-overlaps and uniform data tables (filtered — noise)     | 475     | —        |
| extends a pair the gate already flags (same finding, bigger) | 86      | —        |
| **SHAPE-ONLY — duplication the gate cannot see**             | **241** | **3831** |
| the token pass itself, for comparison                        | 279     | 3673     |

**So the gate sees about half** — 3673 of 7504 duplicated lines, 49%. Nothing pins these
figures (the gate stores no count), so re-run `bun run dup:shape` rather than quoting them.

Two accounting traps were hit building this, both worth recording because both produced a
number that looked like a finding:

- **Subtracting by equal START LINE rather than by range overlap.** Erasing identifiers
  changes the token stream, so jscpd re-anchors a match a few lines either way and the same
  finding returns with a different start. Keyed on the start, 54 pairs / 1276 lines came back
  as "invisible to the gate" on file pairs the gate had already flagged — a quarter of the
  reported total, inflating shape-only to 294 / 5100.
- **Comparing jscpd's de-duplicated `duplicatedLines` stat against a sum of pair lines.** The
  filtered subsets can only be summed per pair, so the token side must be summed the same
  way. Mixed, it read 3380 vs 3824 → "the gate sees 40%"; in one unit it is 49%. This is
  CLAUDE.md §12's units lesson, met inside the instrument built to apply it.

The largest single cluster is a good illustration of what the "extends" bucket means and why
it is kept separate. `map/src/render/material/circle-retained-material.ts:12-82` and
`particle-retained-material.ts:14-87` are each a structural copy of
`arrow-retained-material.ts:13-89` covering the whole file below its header — three ~85-line
drapers, one shape, each copy saying "Mirrors RetainedArrowDraper" in its own comment. The
gate DOES flag that file pair, at 31 scattered lines; the shape lens re-finds it as 77 lines
in one fragment. That is not duplication the gate misses — it is duplication the gate
under-measures, which is a different claim and is why consolidation should be scoped from the
lens rather than from the gate's corner of a cluster. The audit document carries both lists.

The shape mirror's own file and line totals are not comparable to the token pass's — it
covers `.ts/.tsx` only (not `.js/.mjs`), and `mild` mode skips blank lines while a blanked
comment line becomes blank. Only pair counts and pair-summed lines are quoted, never a
percentage of tree.

### How large codebases handle it — the prior art this borrows

- **Linux.** Generic helpers have ONE home (`lib/`, `include/linux/`); a driver that grows a
  generic helper moves it there. Coccinelle semantic patches
  (`scripts/coccinelle/api/*.cocci`, `make coccicheck`) find open-coded copies of a helper
  tree-wide AND rewrite them, and the `.cocci` file stays in the tree so the next open-coded
  copy is flagged. `checkpatch.pl` is the cheap mechanical per-patch gate.
- **LLVM/Clang.** `llvm/ADT` + `llvm/Support` are the utility layer every component uses;
  per-target repetition is GENERATED from tables (TableGen) instead of copied; `clang-tidy`
  is the mechanical checker. X-GIS already has the TableGen idea in the shader DSL (ADR-0003:
  one IR emits WGSL, GLSL and the CPU oracle) and in `projections-table.ts` — the sibling
  families are exactly where it has not been applied yet.
- **rustc.** `x.py test tidy` is a fast tidy gate (file-length limits and style) that runs
  before the heavy suite; `rustc_data_structures` is the shared crate. The same ratchet
  culture as this repo's LOC ceilings.
- **Chromium.** `base/` as the utility layer, `PRESUBMIT.py` per-directory checks, `DEPS`
  include boundaries — the last is our dependency-direction ratchet.
- **The rule of three** (Fowler). Generalise at the third use, not the second: two copies
  are cheaper than a wrong abstraction.
- **The Go proverb**, as the counterweight: "a little copying is better than a little
  dependency." A copy that keeps a package boundary clean can be right — then it is a
  RECORDED decision, not an accident.

### Alternatives considered

1. jscpd's `--threshold <percent>` — rejected. A ratio hides a 200-line paste behind a
   2000-line feature landing in the same PR; CLAUDE.md §5's rule (gate on direction, never
   on an absolute %) applies to code exactly as it does to pixels.
2. ESLint `sonarjs/no-identical-functions` and friends — function-granular, single-file, no
   ratchet. Complementary at best.
3. A vitest ratchet spawning jscpd inside the sharded `test` legs — jscpd is an external
   binary like eslint and knip, which run once in the `lint` job; a per-shard spawn would
   run it eight times and shard-scope its verdict.
4. Hand-rolled token hashing in TypeScript — reimplementing a mature detector for no gain.
5. Gating tests too — deferred, see Decision 3.
6. jscpd 4 (the Node engine) — detects the case the 5.x TypeScript tokenizer misses, but it
   is the deprecated branch and has neither baseline mode; the 5.x JavaScript tokenizer gives
   the same recall on every probe.
7. The 5.x TypeScript tokenizer for the gate — rejected: deterministic blind spot, below.
8. **A COMMITTED FINGERPRINT BASELINE — implemented first, then reverted the same day, and
   the reason is the load-bearing part of this record.** `.jscpd-baseline.json` held the
   fingerprint of every clone pair; the gate diffed it and reddened on a new fingerprint or a
   stale one, `bun run dup:accept` re-recorded it, and net growth needed `--allow-growth`.
   It gives a debt number in the repo that can only shrink, which is why it was chosen. It
   does not survive this repo's merge cadence. A fingerprint covers the token stream of a
   PAIR, so any commit editing inside any of the ~280 baselined regions re-fingerprints it —
   and CI evaluates the PR's MERGE COMMIT, so a PR that changed nothing goes red the moment
   main touches a clone region. Measured, not predicted: main took 4 commits in 19 minutes
   (one of them #2540, in `map/src/shaders/dsl/polygon.ts`), and PR #2533's `lint` job failed
   on 2 new + 2 stale fingerprints 40 minutes after the baseline was recorded, none of them
   the branch's work. At that cadence every open PR pays a merge-and-re-record commit per
   burst — which each supersede its own CI run — and a gate with that tax gets bypassed
   within a week. That is the same argument Decision 3 uses to keep test duplication out of
   the gate, turned on the gate itself. `--baseline-from-ref` removes the whole class: with
   nothing stored, nothing can go stale, and the debt number moves to `dup:report`.
9. **Gating the shape lens too** — rejected. Its false positives are legitimate code: a
   uniform data table, a switch over an enum, a list of bind-group entries all shape to the
   same text without being duplication in any sense a rewrite could remove. Two filters
   (drop a region matching itself a few entries along; drop a fragment whose shaped lines are
   less than half distinct) drop 475 of 802 raw pairs — a heuristic that
   good, gated, is Alternative 8's mistake wearing different clothes: a gate that reds on
   something the author cannot reasonably remove gets bypassed. It is a lens for the human
   deciding what to consolidate, and its output is a queue, not a verdict.
10. **A Type-4 detector** (metric-vector or AST-embedding similarity, the research line
    behind Deckard and the ML clone detectors) — rejected, and this is the deliberate blind
    spot rather than an oversight. Nothing available can be validated against a known
    positive on this tree, and CLAUDE.md §12's rule cuts the other way here: an instrument
    that cannot be trusted reports ZERO, and a zero reads as "clean". A documented blind spot
    is strictly better than a detector nobody can check (#2561). Decision 5 says what stands
    in for it.

## Decision

### 1. jscpd is the detector; `.jscpd.json` is the ONE definition of a clone

70 tokens / 5 lines / `mild`; `.ts .tsx .js .mjs` all through the **JavaScript tokenizer**.
70 sits between jscpd's default (50 — noisy on TypeScript object literals and bind-group
entry lists) and Sonar's 100 (lets a copied ten-line loop through); the table above is the
sensitivity measurement to revisit against. The gate and the report both read this file,
so they cannot drift.

The tokenizer choice is this ADR's finding. jscpd 5's TypeScript tokenizer strips type
annotations — it would find near-clones that differ only in types — but it has a
**deterministic false-negative mode**: the whole, valid `parseColor`
(`map/src/render/renderer-helpers.ts:35-75`, 586 tokens) copied verbatim into a sibling
file is NOT reported against the full file, while it IS reported against the same file
truncated at line 210 or at 240–290, and it IS reported by the JavaScript tokenizer and by
jscpd 4. Whole-tree comparison at 70 tokens: 29 file-pairs the JavaScript tokenizer finds
that the TypeScript one misses even at 40 tokens; 21 pairs the TypeScript one finds through
type-insensitivity. Recall probe: 30 whole exported functions (12–80 lines, one per 11th
source file), each copied into a sibling file and run through the full gate — the
JavaScript tokenizer flagged every copy above the 70-token floor (29 of 29; the 30th was a
42-token function). An instrument for a gate must not have a known false-negative mode
(CLAUDE.md §12: validate the instrument against a known positive before believing a zero).
The TypeScript lens stays for triage — `bun run dup:report --type-insensitive` — and the
choice is revisited when upstream fixes it (repro: the two files above,
`jscpd -c .jscpd.json --format typescript --formats-exts typescript:ts`).

### 2. The gate: no PR may add a clone its base does not already have

`bun run dup` (`scripts/dup-ratchet.ts`) runs in the CI `lint` job beside eslint and knip,
and first in `precheck`. It scans the working tree and compares it against the tree of a base
ref (`jscpd --baseline-from-ref`), reddening on duplication the branch ADDS — and on a
`jscpd:ignore-start` without a reason. Nothing is stored: the comparison baseline is rebuilt
from the ref on each run, in ~4 s over 233k lines.

**What "adds" means is a per-file-pair token budget, not jscpd's per-clone `isNew` alone**
(#2570). `isNew` keys on the token-stream fingerprint of a clone PAIR, so a clone whose
extent SHRINKS is reported new — the gate then reds on the branch that REMOVED duplication.
Measured on #2560: the `raster-renderer.ts` ↔ `hillshade-renderer.ts` pair went from 5 clones
/ 588 tokens to 3 / 298, and the gate called it a regression. So the verdict is the pair's
duplicated-token TOTAL — a quantity, comparable across revisions, moving in the direction the
gate cares about — and `isNew` only narrows which clone of a grown pair the message names.
Getting the base clone set costs a second jscpd run, taken lazily: a run with nothing flagged
is already green and pays nothing.

Line-interval containment was considered and rejected: the two sides of a comparison sit in
DIFFERENT revisions of the same file, so one edit gives `590-602 ⊃ 590-599` on one side and
`854-866 ⊅ 858-867` on the other. Line numbers are not comparable across revisions.

**The base is the merge base with `origin/main`, with no fallback** — which is the exact
answer under CI, whose checkout IS the PR merged into main, so "new versus main" is precisely
"added by this PR". `resolveBaseRef` fetches `main` with an explicit refspec when the ref is
absent (an `actions/checkout` clone carries only the checked-out ref), deepens once when the
checkout is too shallow for a merge base, and THROWS when neither works: a scan without a
base marks every clone new, so a silent failure would invert the gate. Loud is the only safe
direction — the poller lesson in CLAUDE.md §12.

**The ratchet property survives the loss of the baseline file, and gets stronger.** Main can
never GAIN a clone, because every PR is gated against main's own clone set at merge time and
no `--allow-growth` escape hatch exists. What is lost is the committed debt NUMBER; that
moves to `bun run dup:report`, with the 2026-09-05 snapshot in the audit doc.

Verified by cutting the mechanism on the real tree — a whole function copied verbatim into a
sibling file (`parseColor`, the very case the TypeScript tokenizer missed) reddens the gate
naming both files at 586 tokens, removing it greens it, a bare marker reddens it, a reasoned
marker is accepted — and by `scripts/dup-ratchet.test.ts`, which walks the ladder against
the real binary and a real git ref: a base commit that already carries a clone pair reports
it NOT new; a third copy added on top IS new and names the file that added it; once the base
itself carries that third copy, nothing is new again.

### 3. Tests are reported, not gated

Roughly 88% of the duplicated lines are in `*.test.ts` / `*.spec.ts`, mostly `arrange`
blocks (the text-wiring and circle-wiring suites are the two largest clusters in the tree).
Their remedy is a shared fixture builder or deleting redundant specs — a different work item
— and a gate that fails a new spec for copying its neighbour's setup gets bypassed within a
week. `bun run dup:report --tests` keeps them visible. Promote to a gate once the source
baseline has been shrinking for a while.

### 4. The consolidation rule — the process

1. **Triage from the report.** `bun run dup:report` ranks clusters by duplicated lines
   (size × copies) and classifies every pair. intra-file → a local helper, or make the
   repetition table-driven. intra-dir → a sibling family: one generic base, or a table the
   siblings are generated from (the TableGen move). intra-package → a package-local module.
   cross-package → the LOWEST package on the dependency spine that every user may import;
   the dependency-direction ratchet decides (`shared/` for pure math and collections,
   `geo/` for geodesy, `shader-dsl/src/core/ir` for IR walkers). Never upward, never a new
   package for one helper.
2. **The rule of three, sharpened at boundaries.** Within a package the THIRD copy must
   become the helper. Across packages the SECOND copy must — or be marked as a deliberate
   twin — because a cross-package copy is two authorities for one fact.
3. **Consolidate = helper + rewrite EVERY copy in the same PR + keep the guard.** The
   copies must go together because the gate only sees what the PR ADDS — a half-done
   consolidation leaves the survivors green (Coccinelle's tree-wide rewrite is the model).
   Where a copy is easy to reintroduce, a ratchet test or an ESLint
   `no-restricted-syntax` rule naming the helper stays in the tree (the `.cocci` that stays).
   Where a DSL twin is folded, emitted shaders stay byte-identical (the existing goldens and
   hash gates).
4. **Deliberate twins are recorded where they live**: `// jscpd:ignore-start — <reason>
(#issue)` … `// jscpd:ignore-end`. The gate rejects a bare marker, and the marker is the
   ONLY way past it — there is no `--allow-growth`, by design: accepting a copy without
   saying why in the code is exactly what turned the first design into a rubber stamp.
5. **One issue per cluster** (CLAUDE.md §9.5): `file:line` of every copy, the remedy class,
   the helper's home, and the gate that proves it closed.

### 5. The shape lens is a REPORT; Type-4 gets no detector, and that is the decision

`bun run dup:shape` is the Type-2 lens: the shaped-tree pass above, minus the token pass,
minus the two noise classes. Read it BEFORE consolidating a family — the token gate shows a
corner of a cluster and the shape lens shows the cluster, and consolidating from the corner
is how a half-done extraction happens (Decision 4 step 3: every copy in the same PR, and the
gate cannot tell you which copies those are). It is never a gate, per Alternative 9.

Two properties of the subtraction are load-bearing and were both got wrong first (Context):
it is by **range overlap**, because erasing identifiers re-anchors a match and the same
finding returns at a different start line; and the pairs it removes because the gate already
covers them are **counted and reported separately** rather than silently dropped, because
"the gate under-measures this cluster" is a different claim from "the gate is blind to it"
and the retained-draper family — the biggest one — is in the first category, not the second.

For Type-4 — a helper re-invented under another name with a different shape — there is no
instrument and none is proposed. What stands in for one:

- **The report is read before authoring a sibling**, not after (CLAUDE.md §14): the third
  copy within a package, the second across a boundary.
- **The co-change signal**, when a family is suspected: files changed together across
  history. Cheap to compute (`git log --name-only --pretty=format:%H`, pair-count over
  commits) and it names pairs a text detector structurally cannot. It is also the weakest
  instrument here, and it produced a wrong headline before anyone checked it (#2561):
  - **Resolve imports with `.js` specifiers rewritten.** `shader-dsl` is the only package in
    this repo that writes them — 883 relative `.js` imports against 0 in every other package
    — so a resolver that skips that rewrite reports "no import edge" precisely where the
    interesting pair lives. `glsl.ts:70` has imported `./wgsl.js` since the GLSL backend's
    first commit; the published archetype was false for its whole life.
  - **Check the MEDIATOR before inferring a missing abstraction.** Both flagged pairs
    co-change with the file that mediates them (the RHI adapters: 8 of 8 also touch
    `rhi/src/rhi.ts`; `glsl.ts ↔ wgsl.ts`: 10 of 11 also touch another `core/` seam file).
    Implementations moving with their interface is the signature of a HEALTHY abstraction.
    Lockstep is not evidence of duplication; lockstep WITHOUT a mediator might be.
    The resolved verdicts live in #2561: the shader backends already share `Backend`,
    `core/emit.ts` and the `INTRINSICS` table, and the RHI adapters are a chartered twin whose
    separation the dependency-direction ratchet enforces.
- **Review**, which is where a re-invented helper is actually caught, informed by the two
  above rather than replaced by them.

The measurement to revisit: if the shape lens's ~240 does not fall as the queue is worked, the
queue is being worked from the token corner rather than from the cluster.

## Consequences

- (+) Mechanical, ~4 s, no build, nothing committed to keep in sync. A clone this PR adds
  cannot enter unnoticed; the queue is ranked, and each cluster names its remedy.
- (+) No stored state to go stale: the comparison set is rebuilt from the base each run, so
  there is nothing to re-record and no `dup:accept` step. That is the property the first
  design lacked (Alternative 8).
- (−) **NOT immune to base movement — this consequence claimed it was, and CI refuted the
  claim on 2026-09-06.** `isNew` is jscpd's own verdict from `--baseline-from-ref`, and it
  is sensitive to where jscpd ANCHORS a clone, not only to whether the duplication exists.
  When main gains a commit that re-anchors a region — #2563 extracted `raster-row-geom.ts`
  out of `hillshade-renderer.ts` / `raster-renderer.ts` — a branch still carrying the older
  copies of those files is reported as ADDING the pair, in files its diff never touches.
  PR #2593 (a `shader-dsl/` change, zero files under `map/`) went red on exactly that, with
  a pair that demonstrably already exists on main.
  **Root cause, and it was this gate's own code rather than jscpd's:** `resolveBaseRef` fell
  back to the STRING `origin/main` when `git merge-base` failed, and under
  `actions/checkout`'s default shallow clone it always failed. CI therefore compared the
  branch against main's TIP — a commit the branch has not merged — instead of their common
  ancestor. Same tree, same 272 clones, different base, opposite verdict: green locally
  against the merge base, six "new" clones in CI against the tip.
  **Fixed** by deleting that fallback (it now deepens the fetch once and THROWS rather than
  guessing a base) and by checking the `lint` job out with `fetch-depth: 0`, which makes the
  merge base exact. A gate that loses its base must be loud, never quietly wrong — the rule
  Decision 2 already states for a missing `origin/main`, which this fallback quietly broke.
  If the symptom is ever seen again the remedy is to merge main into the branch and re-run;
  it is never to mark the pair `jscpd:ignore`, which would record a false reason and blind
  the gate to a future real paste in those files.
- (−) **A shrinking clone read as a new one, for the same reason a moving base did** (#2570).
  Distinct from the entry above — that was the gate's own base resolution, this is jscpd's
  fingerprint identity — and a fix for one is not a fix for the other. A branch that deletes
  code from INSIDE an existing clone leaves a token stream the base's fingerprint set does
  not contain, so the surviving, SHORTER clone arrives flagged `isNew`, indistinguishable
  from a fresh paste. Worst class: a partial consolidation that shortens a clone instead of
  eliminating it reds the gate that exists to ask for it. **Fixed** by the pair token budget
  in Decision 2. Its cost is one extra jscpd scan on the would-be-red path, and its accepted
  blind spot is stated where it will be read (`scripts/dup-ratchet.ts`'s header): a new clone
  region between two files that already duplicate each other, in a branch that removes at
  least as many duplicated tokens between those same two files. Net duplication between the
  pair fell, which is not the direction this ADR blocks; the rule-of-three case is unaffected,
  because a third copy always forms a pair the base has zero tokens for.
- (+) The tokenizer finding is recorded with its reproduction instead of being rediscovered.
- (+) The gate's blind spot is MEASURED rather than assumed: `dup:shape` puts a number on
  what the token pass cannot see (3831 lines against 3673), so "the gate is green" is never
  mistaken for "there is no duplication here".
- (−) Token-level: identifier renames and reordered statements are invisible to the GATE; so
  are annotation-only differences. Both have a lens (`dup:shape`, `--type-insensitive`) and
  neither has a gate — Alternative 9.
- (−) Type-4 is not detected at all, deliberately (Alternative 10 / Decision 5). The
  substitutes are the report, the co-change signal and review; none of them is mechanical,
  so this is the class that can still compound unnoticed.
- (−) The debt number lives in `dup:report` and this ADR's table, not in a file CI diffs —
  so a slow drift downward is not celebrated anywhere. Acceptable: the gate's job is to stop
  new duplication, and the queue is what drives the number down.
- (−) The gate needs `origin/main` reachable. In a network-less environment it throws rather
  than passing; that is deliberate, but it does mean `bun run dup` is not usable offline on a
  fresh clone until `main` has been fetched once.
- (−) Two PRs in flight can each add the same copy, each green against main, and land a new
  clone between them. The committed baseline had the same hole; the next PR's gate catches
  the result.
- The thresholds and the tests decision are measurements to revisit, not constants: when
  `dup:report` shows the source clone count under ~50, consider 50/5 and gating tests.
