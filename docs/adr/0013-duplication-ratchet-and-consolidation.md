# ADR-0013: Duplication ratchet + consolidation policy

- **Status**: Accepted
- **Date**: 2026-09-05
- **Related**: `.jscpd.json`, `scripts/dup-ratchet.ts` (+
  `scripts/dup-ratchet.test.ts`), `.github/workflows/test.yml` (`lint` job),
  `scripts/precheck.ts`, `map/src/loc-ceiling-ratchet.test.ts`,
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
and first in `precheck`. It scans the working tree and compares the clone set against the
tree of a base ref (`jscpd --baseline-from-ref`), reddening on any pair absent from the base
— and on a `jscpd:ignore-start` without a reason. Nothing is stored: the comparison baseline
is rebuilt from the ref on each run, in ~4 s over 233k lines.

**The base is the merge base with `origin/main`, falling back to `origin/main` itself when
the history is shallow** — which is the exact answer under CI, whose checkout IS the PR
merged into main, so "new versus main" is precisely "added by this PR". `resolveBaseRef`
fetches `main` with an explicit refspec when the ref is absent (a `actions/checkout` clone
carries only the checked-out ref) and THROWS when it cannot resolve one: a scan without a
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

## Consequences

- (+) Mechanical, ~4 s, no build, nothing committed to keep in sync. A clone this PR adds
  cannot enter unnoticed; the queue is ranked, and each cluster names its remedy.
- (+) Immune to base movement: main can merge under an open PR all day and the gate's
  verdict does not change, because the comparison is rebuilt from the base each run. That
  is the property the first design lacked (Alternative 8).
- (+) The tokenizer finding is recorded with its reproduction instead of being rediscovered.
- (−) Token-level: identifier renames and reordered statements are invisible; so are
  annotation-only differences (visible to the `--type-insensitive` lens, not to the gate).
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
