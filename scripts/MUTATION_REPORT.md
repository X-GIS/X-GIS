# Mutation Test Report — 2026-05-22 (iter-306 update)

## Methodology insight (iter-306)

Mutation score correlates with test SPECIFICITY, not COVERAGE.

  iter-281–283 cache layer (versioned-state, bundle-cache-key,
  structural-key) → 85-100 % scores. Recent code shipped with
  TIGHT EQUALITY-checked unit tests.

  camera.ts (105 unit + 10 fuzz) → 4.7 %. Property-style tests
  (matrix finite, alt scales 32×) verify high-level invariants
  but skip specific arithmetic-byte equality. Mutation flips
  produce arithmetically-close matrices that pass the invariants.

Takeaway: equality-pinned unit tests outperform property tests
under mutation scoring. Use property-fuzz to find edges (iter-293
NaN compare); use equality pins to kill mutants.

# Mutation Test Report — 2026-05-21

Tooling: `scripts/mutate.ts` (iter-302). Zero-dep hand-rolled Stryker-lite.

## Baseline run results (iter-303)

| Target | Fuzz file | Mutants | Killed | Survived | Score |
|---|---|---:|---:|---:|---:|
| `compiler/src/tiler/geodesic.ts` | `geodesic-fuzz` | 18 | 16 | 2 | **88.9 %** |
| `runtime/src/data/eval/filter-eval.ts` | `filter-eval-fuzz` | 31 | 25 | 6 | **80.6 %** |
| `compiler/src/tiler/simplify.ts` | `simplify-fuzz` | 41 | 18 | 23 | 43.9 % |
| `compiler/src/tiler/clip.ts` | `clip-fuzz` | 150 | 45 | 105 | 30.0 % |
| `compiler/src/tokens/colors.ts` | `colors-fuzz` | 228 | 55 | 173 | 24.1 % |
| `runtime/src/core/line-segment-build.ts` | `line-segment-build-fuzz` | 153 | 19 | 134 | 12.4 % |

## iter-307/308/309 plug results

| Target | Pre | Post | Δ |
|---|---:|---:|---:|
| `clip.ts` | 30.0 % | 30.7 % | +0.7 |
| `colors.ts` | 24.1 % | 40.8 % | +16.7 ⭐ |
| `evaluator.ts` (no plug; baseline) | — | 13.0 % | — |
| `versioned-state.ts` | — | 100 % | — |
| `bundle-cache-key.ts` | — | 100 % | — |
| `camera.ts` | — | 4.7 % | — |
| `structural-key.ts` | 81.5 % | 85.2 % | +3.7 |

Biggest win: colors lab/lch/oklab/oklch routing tests (8 cases →
+38 mutants killed). Pattern: discriminator branches (`fn === 'lab'`
vs `fn === 'oklab'`) need outputs distinguishable across the
branches, not just non-null.

## Reading the numbers

**> 80 % score** — fuzz suite exercises the surface's branches well.
The remaining survivors are typically boundary epsilons that hand-
picked tests would also miss (floating-point `<` vs `<=` at 1e-12).

**40-60 % score** — fuzz hits the main happy paths but misses
secondary branches. Plugging requires targeted tests per surviving
mutant's `file:line` (which the report dumps verbatim).

**< 30 % score** — fuzz is sparse vs the surface size. Most of the
code is unexercised. Two patterns produce this:

  1. Large file, small fuzz (`colors.ts` 700 LOC + 34 fuzz cases).
     Each fuzz case touches one form; the other 60-80 % of forms
     never run. Plug = grow the fuzz suite OR carve the file into
     smaller modules.

  2. Internal helper paths reachable only via complex call chains
     (`line-segment-build.ts` miter / tangent / pad-ratio
     computation, only hit through specific stride 10 + heights
     map + boundary-tangent combinations).

## Methodology notes

- **The score isn't the goal** — the survivor list IS. Each
  surviving mutant points at a specific `file:line` where a
  one-character source change passes all current tests. Each line
  is a candidate bug class.

- Mutation testing is **not a test-write replacement** — it tells
  you where existing tests stop working. The fix is always to add
  a fuzz case that distinguishes the original from the mutant.

- **Run cost**: 1 test cycle per mutant. With a focused vitest
  filter (~500 ms per cycle), 100 mutants = ~50 s. Acceptable
  manual cadence; not for CI.

## Recommendations (priority by ROI)

1. **`line-segment-build` 12.4 %** — heaviest sublevel. Adding 10
   fuzz cases for the miter / tangent paths likely takes the score
   to 50 %+.

2. **`colors.ts` 24.1 %** — 173 survivors. Most are arithmetic
   sign flips inside `hsl/hwb/lab/lch/oklab/oklch` channel conversions
   that only get tested for `rgb` + `hsl` basic forms. Split the
   file by colour-space or grow the fuzz suite.

3. **`clip.ts` 30 %** — 105 survivors. Sutherland-Hodgman edge
   handling has many corners (lon/lat axis × keep-above/below).
   Fuzz suite (`clip-fuzz`) is shape-coverage focused; doesn't
   exercise per-edge orientation.

4. **`simplify.ts` 43.9 %** — recursive DP step has many
   branch-and-bound corners (locked vertices, distance comparison).
   23 survivors mostly in `dpStep`.

5. **`filter-eval` 80.6 %** and **`geodesic` 88.9 %** are
   well-pinned. Further fuzz on these has diminishing returns.

## How to run

```bash
bun scripts/mutate.ts <target-file> <vitest-filter>
```

Output ends with:
- Mutation score
- File:line list of every surviving mutant + original/mutated text

Plug each survivor by adding a test case that fails ONLY when the
mutated source is in place. Re-run; survivor disappears.

## Industry context

Industry mutation score targets:
- > 75 %  — strong test suite
- 50-75 % — acceptable
- < 50 %  — gaps; survivors are real bug candidates

X-GIS averages **47 %** across the 6 measured surfaces, range
12-89 %. Above industry "acceptable" only for two surfaces; the
other four are real gap-rich targets.
