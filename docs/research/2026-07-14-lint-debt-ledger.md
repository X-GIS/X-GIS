# Lint-debt ledger — full-repo triage (2026-07-14)

Tracking issue: #1055.

## Status update — Waves 1+2 landed (2026-07-14, branch `claude/1055-lint-wave1-2`)

Fresh `bun run lint` headline after Wave 1 (dormant-package mechanical cleanup) and
Wave 2 (project-service parsing gaps closed):

| metric                                | ledger baseline | post Wave 1+2 |
| ------------------------------------- | --------------: | ------------: |
| Problems                              |             736 |           720 |
| Errors                                |             132 |           112 |
| Warnings                              |             604 |           608 |
| — stale `eslint-disable`              |             520 |           525 |
| Parsing errors (project-service gaps) |              20 |         **0** |

Notes on the deltas (all re-measured on `origin/main` @ `56dfad34`, which had drifted
from the ledger's `0a672199` baseline):

- **Wave 1** — `pipeline` 4→0 warnings (stale `no-console` disables removed);
  `scripts` 1→0 warnings (unused `RUNTIME_CAPABILITIES` import removed). The two
  judgment-class singles stay by design: `blueprint` 1 error (`no-unused-expressions`
  in the ratchet-tracked `editor.ts` — needs an if/else rewrite) and `engine` 1 error
  (`no-deprecated` `colormap` positional call — Wave 3 API-migration class).
- **Wave 2** — all 20 Appendix-A files now parse and lint 0 errors, via
  `allowDefaultProject` globs in `eslint.config.js`. Main's drift had ALSO re-broken
  the Wave 0 `vitest.config.ts` fix (97 matched files > the 96 cap → "Too many files"
  parsing error), so the cap was raised 96→160 (117 files match today). `docs`,
  `vitest.config.ts`, `compiler` −1, `runtime` −3, `playground` −15 parsing errors.
- Warnings rose 604→608 net: −4 pipeline, −1 scripts, −3 main-drift, **+12 newly
  visible** stale disables in `playground/render-verify/{evaluator,matrix-oracles}.ts`
  that only surfaced once those files parse — playground residue for Wave 5.
- Error floor is now genuinely rule-debt: 112 = `no-deprecated` 71 + `no-undef` 17 +
  misc; no parsing errors remain, unblocking the gate-policy ratchet (item 3 below).

## Status update — Wave 5 landed (2026-07-14, branch `claude/1055-lint-wave5`)

Playground was quiescent, so the biggest single mechanical win ran. Fresh repo-root
`bun run lint` headline after Wave 5 (measured on this branch, based on `origin/main`
@ `85bbb57`):

| metric                   | post Wave 1+2 | post Wave 5 |
| ------------------------ | ------------: | ----------: |
| Problems                 |           720 |     **258** |
| Errors                   |           112 |      **94** |
| Warnings                 |           608 |     **164** |
| — stale `eslint-disable` |           525 |      **82** |
| Parsing errors           |             0 |           0 |

Playground alone: **24 err / 483 warn → 6 err / 39 warn**.

What landed:

- **`eslint playground --fix`** — removed **443** unused `eslint-disable` directives
  (stale `no-console` suppressions, mostly in `e2e/_*.spec.ts`) plus 2
  behaviour-neutral autofixes (1 `prefer-const`, 1 `no-regex-spaces`). The prettier
  pre-commit hook then reflowed the whitespace-only lines the directive removal left
  (post-hook: 112 files changed, 323 insertions / 446 deletions). No test semantics
  were hand-edited; the `__pixel-match*__` / snapshot data dirs and `.snap` files
  (eslint-ignored, non-code) were untouched.
- **`no-undef` (17) → 0** via a Node/Bun globals block in `eslint.config.js` scoped
  to `**/*.{js,mjs,cjs}` (a `nodeScriptGlobals` map: process/console/Buffer/Bun/…).
  All 17 were in `playground/_dc0-diff.mjs` (the DC=0 relocation differ), **not** the
  render-verify `.ts` files the ledger estimated — those parse fine and carry no
  `no-undef` (typescript-eslint disables the rule for typed `.ts`; ESLint keeps it
  only for plain js/mjs/cjs, which is why the offender is a `.mjs` script).

Corrections to the Wave 5 residue estimate (the ledger listed the pre-Wave-2
`0a672199` figures; re-measured here on current main):

- **15 parse-gaps → 0 (verified).** Wave 2 already covered every playground file in
  Appendix A; a fresh lint shows 0 parsing errors repo-wide. The "39 errors" the
  ledger attributed to Wave 5 was the pre-Wave-2 figure; post-Wave-2 the playground
  error count was 24, of which Wave 5 clears 18 (17 `no-undef` + 1 autofixed
  `no-regex-spaces`).
- **`no-require-imports` (est. 3) → 0 in playground.** The 2 repo-wide sites are in
  `compiler/src/__tests__/` (`compiler` scope), not playground — nothing to do here.
- **`react-hooks` (est. 2) → 0 in playground.** Both repo-wide sites are in
  `site/src/components/react/` (`site` scope), not playground — nothing to do here.

Wave 5 residue (playground: 6 errors + 39 warnings) — all deferred by class:

- 3 `no-useless-escape` in `playground/src/monaco-xgis.ts` (L123/124/242) —
  regex-escape judgment, not part of the mechanical sweep.
- 2 `no-deprecated`: `e2e/_absorbed-fn-parity.spec.ts:L188` (`emitFuncsCsed` →
  `emitFuncs`) and `src/xgis-inspector.ts:L223` (`document.execCommand` → Clipboard
  API) — the deferred API-migration class.
- 1 `no-unused-expressions` in `e2e/_artifact-cap.spec.ts:L35` — judgment.
- 30 `no-unused-vars` warnings (unused spec imports/vars) — manual, not autofixable.
- 9 stale `eslint-disable` warnings in `src/xgis-inspector.ts` — deliberately **not**
  cleared: that file also holds the `execCommand` `no-deprecated` error above, so
  staging it would fail the pre-commit `lint-staged` `eslint --fix` gate (which
  errors on the pre-existing deprecation). They ride along with the deprecation fix
  in a later wave. (This is why 443, not 452, disables were cleared.)

Gates: `bun run build` (full monorepo, playground `vite build` included) exits 0 with
no `TS6133`/`TS` errors; `tsc -p playground/tsconfig.json --noEmit` exits 0. The e2e
specs' type surface is the typed-lint (eslint project service — the e2e `tsconfig` is
a noEmit resolution surface only; Playwright transpiles specs at run time), green on
all 111 touched files via the pre-commit hook. No playground vitest suite exists (only
`dev` / `build` / `test:e2e`); the browser e2e specs are not run here.

## Status update — Wave 3 landed (2026-07-14, branch `claude/1055-lint-wave3`)

The `shader-dsl` deprecation migration (the last `no-deprecated` error class outside
`data`/`site`). Fresh repo-root `bun run lint`, rebased on `origin/main` post-Wave-5:

| metric                   | post Wave 5 | post Wave 3 |
| ------------------------ | ----------: | ----------: |
| Problems                 |         258 |     **218** |
| Errors                   |          94 |      **55** |
| Warnings                 |         164 |     **163** |
| Parsing errors           |           0 |           0 |

Errors 94 → 55 (**−39**): the 38 `@typescript-eslint/no-deprecated` `callFn` sites in
the shader-dsl test corpus migrated to the `FnHandle` object-param call form /
`externFn`, plus the 1 `engine` `colormap` positional-call migration. Behaviour-neutral
by construction — the migration only changes the CALL FORM, never assertions; the full
shader-dsl suite (86 files / 548 tests) and `tsc --build shader-dsl` stay green, so
emit parity is preserved (a moved snapshot would have meant a semantics change — none
did). `bun run build` exits 0. Remaining 55 errors are the `data` (`no-deprecated` ×22
+ `prefer-const`) and `site` (`react-hooks` / `no-deprecated`) classes = Wave 4.

## Method

- Command: `bun run lint` (= `eslint .`), captured once at the repo root with the
  `json` formatter and aggregated per package / per rule.
- Baseline: `origin/main` @ `0a672199`, plus this PR's commit 1 (the `vitest.config.ts`
  project-service fix). That commit cleared exactly one parsing error, so the issue's
  original count of **133 errors** is measured here as **132**.
- 2023 files linted. Severities come from `eslint.config.js`: among the project's own
  additions only `@typescript-eslint/no-deprecated` is an `error`; `no-unused-vars`,
  `prefer-const`, and `no-empty` are `warn`; everything else is an ESLint /
  typescript-eslint recommended default. ESLint v9 flat config also defaults
  `reportUnusedDisableDirectives` to `warn`.

## Headline

| metric                                        | count |
| --------------------------------------------- | ----: |
| Problems                                      |   736 |
| Errors                                        |   132 |
| Warnings                                      |   604 |
| Autofixable (`--fix`)                         |   529 |
| — of which stale `eslint-disable` directives  |   520 |
| Substantive residual (problems minus autofix) |   207 |

**The autofixable count is misleading on its own: 98% of it (520 / 529) is stale
`eslint-disable` directive removal**, not a code-quality fix. Those directives suppress
nothing (that is why `reportUnusedDisableDirectives` flags them), so `--fix` deleting them
is behaviour-neutral. The genuinely substantive debt is the **207 residual problems** that
survive `--fix` — 130 errors and 77 warnings.

## Per-package table

Sorted by total problems. `stale-disable` is the subset of `autofixable` that is
`unused-eslint-disable-directive`. `parse-gaps` are fatal parsing errors caused by the same
typed-lint project-service discovery gap this PR fixes for `vitest.config.ts` (counted
inside `errors`). `dev status`: **[A]** package is under active sibling development, defer;
**[R]** package has a ratchet test tracking its files; **[Q]** quiescent, safe to sweep now.

| package      | errors | warnings | autofixable | stale-disable | parse-gaps | top rules                                                               | dev status    |
| ------------ | -----: | -------: | ----------: | ------------: | ---------: | ----------------------------------------------------------------------- | ------------- |
| `playground` |     39 |      471 |         442 |           440 |         15 | unused-eslint-disable (440); no-unused-vars (30); no-undef (17)         | [Q] large     |
| `compiler`   |      9 |       70 |          28 |            25 |          1 | prefer-const (45); unused-eslint-disable (25); no-useless-escape (4)    | [A]           |
| `runtime`    |      9 |       40 |          41 |            39 |          3 | unused-eslint-disable (39); parse-gap (3); no-deprecated (2)            | [A][R]        |
| `shader-dsl` |     38 |        0 |           0 |             0 |          0 | no-deprecated (38)                                                      | [Q] (this PR) |
| `data`       |     22 |        2 |           1 |             0 |          0 | no-deprecated (22); prefer-const (2)                                    | [A]           |
| `map`        |      8 |       14 |          13 |            12 |          0 | unused-eslint-disable (12); no-deprecated (4); no-loss-of-precision (3) | [A][R]        |
| `site`       |      4 |        2 |           0 |             0 |          0 | react-hooks/exhaustive-deps (2); no-deprecated (2); no-unused-vars (2)  | [A]           |
| `pipeline`   |      0 |        4 |           4 |             4 |          0 | unused-eslint-disable (4)                                               | [Q]           |
| `blueprint`  |      1 |        0 |           0 |             0 |          0 | no-unused-expressions (1)                                               | [Q]           |
| `docs`       |      1 |        0 |           0 |             0 |          1 | parse-gap (1)                                                           | [Q]           |
| `engine`     |      1 |        0 |           0 |             0 |          0 | no-deprecated (1)                                                       | [Q]           |
| `scripts`    |      0 |        1 |           0 |             0 |          0 | no-unused-vars (1)                                                      | [Q]           |

Clean packages (0 problems): `geo`, `shared`, `rhi`, `rhi-webgpu`, `examples`, repo root.

## Global rule frequency

**Errors (132):** `no-deprecated` 71 · `parsing-error (project-service gap)` 20 ·
`no-undef` 17 · `no-useless-escape` 7 · `no-irregular-whitespace` 4 ·
`no-unused-expressions` 3 · `no-loss-of-precision` 3 · `no-require-imports` 2 ·
`no-regex-spaces` 2 · `react-hooks/exhaustive-deps` 2 · `prefer-as-const` 1.

**Warnings (604):** `unused-eslint-disable-directive` 520 · `prefer-const` 51 ·
`no-unused-vars` 33.

**Autofixable (529):** `unused-eslint-disable-directive` 520 · `prefer-const` 7 ·
`no-regex-spaces` 2.

## Key findings

1. **Stale suppression comments dominate.** 520 of 604 warnings are unused
   `eslint-disable` directives (mostly stale `no-console` disables in test files), all
   autofixable. A single per-package `eslint <pkg> --fix` clears them with no behavioural
   change and shrinks the warning count from 604 to ~84.
2. **`prefer-const` is mostly manual.** Only 7 of 51 `prefer-const` warnings carry an
   autofix; the other 44 sit in multi-declarator statements the fixer treats as unsafe and
   must be converted by hand (44 of them are in `compiler`).
3. **`no-deprecated` (71) is the real error debt.** It concentrates in `shader-dsl` (38)
   and `data` (22) test files and is overwhelmingly the deprecated `callFn` string-call
   form (#763 X16), plus `helper`, `condExpr`, `ifExpr`, `probe`. It is **not autofixable**
   — each site must be migrated to the non-deprecated call form. This is API-migration
   work, not a mechanical pass.
4. **20 parsing errors are the same class this PR fixes.** They are fatal
   project-service discovery gaps on config / script / bench / prototype files that live
   outside every package `tsconfig`'s `include` (see Appendix A). Because they are `error`
   severity on files nobody edits, they are the single biggest obstacle to promoting
   repo-wide lint to a blocking gate.

## This PR (scope of #1055 slice)

- **Commit 1** — `vitest.config.ts` added to the eslint `allowDefaultProject` list, the
  mechanism already used for `scripts/*.ts`, `playground/playwright.config.ts`, and
  `pipeline/tools/*.ts`. `bunx eslint vitest.config.ts` now exits 0.
- **shader-dsl** was chosen as the one package to auto-fix. `eslint shader-dsl --fix` is a
  **no-op**: shader-dsl has **0 autofixable** issues. Its entire debt is the 38
  non-autofixable `no-deprecated` errors above. Verified green regardless:
  `tsc --build shader-dsl` exits 0, and the shader-dsl vitest suites pass 671/671. Because
  `--fix` changed nothing, **no `style(shader-dsl)` commit was produced** — there was
  nothing to commit.

## Proposed sweep order

Ordered to avoid merge conflicts with packages under active development and to front-load
the near-zero-risk mechanical wins. One PR per package keeps each diff reviewable.

- **Wave 0 (this PR):** root `vitest.config.ts` project-service gap. Done.
  (Re-broken by main drift — the 97th default-project match hit the 96 cap — and
  re-fixed in Wave 2's cap raise.)
- **Wave 1 — quiescent, mostly mechanical (do next):** **Done (2026-07-14)** for the
  mechanical classes; the two judgment singles remain by design.
  1. `pipeline` [Q] — `eslint pipeline --fix` → 0 (4 stale disables). **Done** (4→0).
  2. `scripts` [Q] — 1 `no-unused-vars` (1 line, manual). **Done** (1→0; unused
     `RUNTIME_CAPABILITIES` import removed).
  3. `blueprint` [Q] — 1 `no-unused-expressions` (manual). **Left**: side-effecting
     ternary in the LOC-ratchet-tracked `editor.ts`; needs an if/else rewrite, not a
     mechanical pass.
  4. `engine` [Q] — 1 `no-deprecated` (manual). **Left**: `colormap` positional-call
     migration, the Wave 3 class.
- **Wave 2 — cross-cutting config, do EARLY (unblocks any gate):** cover the remaining 20
  parsing-error files (Appendix A) by extending `allowDefaultProject` globs (or adding
  nested `tsconfig`s), exactly as this PR did for `vitest.config.ts`. Pure config; turns 20
  hard errors into lintable files. This is a prerequisite for a blocking repo-wide gate.
  **Done (2026-07-14)**: all 20 files covered by globs in `eslint.config.js` and verified
  0 errors each; the match cap was raised 96→160 (117 files match; the zero-headroom cap
  had re-broken `vitest.config.ts`). Parsing errors repo-wide: 20→0.
- **Wave 3 — `shader-dsl` deprecation migration [Q]:** migrate the 38 `no-deprecated`
  call sites (`callFn` → the `FnHandle` object-param call / `externFn`) in the test files;
  re-run shader-dsl vitest + `tsc --build`. Manual, not `--fix`.
- **Wave 4 — active packages, after their current work lands (coordinate ratchets):**
  ordered by autofix leverage. 5. `runtime` [A][R] — `--fix` clears 39 stale disables; residue = 3 parse-gaps (Wave 2),
  2 `no-deprecated`, misc. Disable removal only shrinks files, so the
  `architecture-invariants` god-file check stays safe — but re-run it. 6. `map` [A][R] — `--fix` clears 12 stale disables; residue = 4 `no-deprecated`, 3
  `no-loss-of-precision`. LOC only drops, so `loc-ceiling-ratchet` stays safe — re-run it. 7. `compiler` [A] — `--fix` clears 25 stale disables + 3 `prefer-const`; residue = 42
  manual `prefer-const`, 7 `no-useless-escape`, 4 `no-irregular-whitespace`, 1 parse-gap.
  Largest manual tail. 8. `data` [A] — only 1 autofixable; manual `no-deprecated` (22) + `prefer-const` (2).
  Pair with the shader-dsl deprecation approach. 9. `site` [A] — 0 autofixable; manual `react-hooks/exhaustive-deps` (2), `no-deprecated`
  (2), `no-unused-vars` (2).
- **Wave 5 — `playground` (biggest single mechanical win, ~440 stale disables):** not
  under active sibling development but large and high-churn, so schedule as a dedicated PR
  when it is quiescent. `--fix` alone drops repo warnings 604 → ~84. Residue = 39 errors:
  15 parse-gaps (Wave 2), 17 `no-undef` (add a browser/node globals block for the
  `render-verify` / script files), 3 `no-require-imports`, 2 `react-hooks`, misc.
  **Done (2026-07-14, `claude/1055-lint-wave5`)** — 443 stale disables cleared, `no-undef`
  17→0 via the config globals block; the estimate's parse-gaps/`no-require-imports`/
  `react-hooks` were all already 0 in playground (re-measured). See the Wave 5 status
  section above for the fresh headline and the deferred residue.

## Gate-policy recommendation (issue item 4)

Recommendation only — no CI change is implemented in this PR.

1. **Keep the pre-commit `lint-staged` pass as the enforcement point.** It lints only the
   files you touch, so it already prevents _new_ debt on changed lines and stays green. Do
   not remove it.
2. **Do not make repo-wide `eslint .` a blocking CI gate yet.** It exits 1 today, and 20 of
   its 132 errors are project-service parsing gaps on files nobody edits — a blocking gate
   would fail unrelated PRs for pre-existing, untouched debt.
3. **Add a non-blocking "lint-debt ceiling" CI job now.** Run `eslint .` in report-only
   mode and fail _only if the problem count exceeds the current baseline_ (736 problems /
   132 errors). This is the same ratchet philosophy the repo already uses for
   `loc-ceiling-ratchet` and `architecture-invariants`: debt can shrink freely but never
   grow, without a big-bang cleanup.
4. **Burn the ceiling down via the sweep above,** landing Wave 2 (parse-gaps) first so the
   error floor can actually reach zero.
5. **Flip to a hard-blocking `eslint .` error gate only after** (a) all 20 parse-gaps are
   covered (else CI is red on untouched files) and (b) the error backlog is burned to zero.
   Warnings can stay non-blocking, or be capped with `--max-warnings <current>` and
   ratcheted down as the stale-disable sweep proceeds.

## Appendix A — the 20 parsing-error files (project-service gaps)

Same fix as `vitest.config.ts`: add to `allowDefaultProject` (or a nested `tsconfig`).

**Closed by Wave 2 (2026-07-14)** — all 20 files below are covered by
`allowDefaultProject` globs in `eslint.config.js` and lint with 0 errors.

```
compiler/bench-geojson-vt-encode.ts
docs/research/prototypes/shader-dsl-backend-agnostic-poc.ts
playground/capture-shader-thumbnails.mts
playground/render-verify/camera-map.ts
playground/render-verify/d3-reference.ts
playground/render-verify/evaluator.ts
playground/render-verify/fixtures.ts
playground/render-verify/matrix-oracles.ts
playground/render-verify/matrix-types.ts
playground/render-verify/matrix.manifest.ts
playground/render-verify/matrix/matrix.disc.ts
playground/render-verify/matrix/matrix.globe.ts
playground/render-verify/matrix/matrix.line.ts
playground/render-verify/matrix/matrix.merc.ts
playground/render-verify/pixelmatch-browser.ts
playground/scripts/sprite-sdf-buffer-probe.ts
playground/vite.config.ts
runtime/scripts/build-dts.ts
runtime/scripts/inspect-firenze-pmtiles.ts
runtime/vite.config.ts
```

## Appendix B — shader-dsl `no-deprecated` detail (38 errors, all in test files)

Deprecated symbol frequency: `callFn` 25 · `helper` 3 · `condExpr` 2 · `ifExpr` 2 ·
`probe` 2 · `add` 2 · `real` 1 · `inner` 1.

Files: `passes/inline-linear.test.ts` (9), `passes/auto-inline.test.ts` (8),
`passes/lint/rules/call-signature.test.ts` (4), `ir/condexpr-arms.test.ts` (2),
`ir/dual-instance-hardening.test.ts` (2), `ir/fn-call.test.ts` (2), `ir/when.test.ts` (2),
`passes/inline.test.ts` (2), `passes/lint/rules.test.ts` (2), and 5 files with 1 each
(`ir/extern-fn`, `ir/module-assembly`, `ir/struct-param`, `passes/lint/engine`,
`passes/opt/dce-fns`).
