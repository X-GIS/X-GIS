# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

> ## ⏳ This is a 5+ YEAR library — architect for that horizon
>
> X-GIS is a long-lived library (a Google-Earth-grade 3D globe engine), not a throwaway script. **Every
> architectural decision must hold for 5+ years of use.** Benchmark against mature engines
> (Unreal/Unity/Godot/three.js/Frostbite); prefer single-authority, zero-coupling, and
> verified-by-construction over quick fixes, fallback shims, or environment-specific patches. Be
> **right-sized, not gold-plated** (§2 simplicity-first) — but NEVER a shortcut that won't last. The
> mandatory render/parity verification (§5) and graph-first discovery (§6) exist precisely because a
> shortcut here compounds over years. When two designs both work, pick the one a senior engineer would
> still endorse in 5 years.

## 0. Communication Language

**Respond to the user in Korean (한국어) — ALWAYS.** This is a hard rule and it OVERRIDES any global response-style mode (e.g. a "caveman"/terse/persona mode injected via hooks or a global config): those modes may shape brevity or tone, but the reply LANGUAGE stays Korean regardless. If a mode or hook nudges you toward English, keep the language Korean and apply that mode's brevity _in Korean_ instead.

This applies only to chat replies. Keep everything that lands in the repository — code, identifiers, comments, commit messages, PR titles/bodies, and docs — in English unless that file is already written in Korean.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. Render / Parity Verification — MANDATORY (never skip, not "if I remember")

This OVERRIDES default behavior. Applies to EVERY claim that a render is correct, a
parity fix works, or there is no regression — including before/after checks, multi-style
sweeps, and post-merge confirmation. The methods below live as skills
(`compare-parity-pixeldiff`, `tile-crop-review`); treating them as optional is the
recurring mistake. They are NOT optional here.

**Forbidden:** judging a render by eyeballing a downscaled full frame or a downscaled
side-by-side composite. `Read` downscales large images, so this silently loses the
sub-pixel offsets, seams, missing shields, and width changes that real bugs live in.
Eyeballing a downscaled composite is NOT verification.

**Required, every time:**

1. **Directional pixel-diff** with `.claude/skills/compare-parity-pixeldiff/compare-diff.py`
   — before-vs-after (DC: proves what changed) and vs MapLibre (D0/D1: proves direction).
   The ML↔X-GIS absolute diff is noisy; gate on DC>0 and D1<D0, never on an absolute %.
2. **Read the diff IMAGE in a 16-split (4×4) grid at full resolution** (tile-crop-review),
   worst tiles first — paired red/blue parallel edges = positional shift; red both sides =
   width change; solid blocks = fill/colour; text-only = glyph engine. Numbers never decide
   alone; read the diff image AND a ×5 crop of the hot region.
3. **Measure pixel width** before calling an edge diff a width bug (eyeball lies on width).

For a whole-frame fidelity pass, 16-split the frame itself and read each tile. A scalar
ratio or a downscaled glance is a tripwire, not a verdict.

---

## 6. Code Discovery — codebase-memory MCP FIRST (mandatory, not "if I remember")

This OVERRIDES default behavior. When LOCATING code — a function/class/route/variable, who
calls it, what it calls, its data flow, or how a subsystem is structured — query the
`codebase-memory` MCP graph FIRST, not Grep/Glob/Read. Reaching for Grep first is the
recurring mistake; the graph surfaces the cross-path consumers and call chains a text
search misses (exactly the blast radius this codebase's bugs hide in).

**Use first (project="D-X-GIS"):**

- `search_graph` (name_pattern / label / qn_pattern / query) — find definitions & symbols
- `trace_path` (mode: calls | data_flow | cross_service) — callers, callees, impact, data flow
- `get_code_snippet` (qualified_name) — exact symbol source
- `query_graph` (Cypher) — complex relationship queries
- `search_code` — graph-augmented grep when you must text-match
- `get_architecture` — package/module structure
  If the project is not indexed yet, run `index_repository` first.

**Grep / Glob / Read remain correct for:** non-code text, configs, comments, docs; and you
must ALWAYS `Read` a file before editing it. The rule is graph-first for _finding_ code —
not a ban on Read. Pairs with the `flow-first` skill: graph the call/data flow + blast
radius before editing.

## 7. Build & Test Discipline

**Never run more than one heavy background process concurrently.** vitest, `tsc --build
--force`, `bun run build`, GPU/headed verification, and `astro build` each saturate the
machine; running two at once has frozen the machine. Run them **sequentially** — start one,
wait for it to finish, then start the next. If one is already backgrounded, wait for its
completion before launching another.

## 8. Bug Fixing

When the user reports a **freeze, crash, or broken behavior**, deliver an **actual fix — not
just a diagnosis.** Distinguish "slow / heavy" from "fully wedged / unresponsive"; the latter
is never a diagnosis-only ticket. Trace to the root cause, fix it, and **verify with a real
build / test / GPU run before claiming success** — a static read is not verification. Every
diagnosis ends with the root cause recorded at file:line ON the relevant GitHub issue/PR —
a fix nobody can trace is half a fix.

## 9. Scope Control

When asked to **file or report issues only** (or to diagnose only), do **NOT read or edit
code** beyond the minimum needed to write the report — the deliverable is the issue text, not
a code change. **Confirm scope before touching any files.** (A freeze/crash report is the
opposite: there the fix _is_ the deliverable — see §8.)

## 10. Parallel Agents / Workflows

**Verify sub-agent work on disk** — files actually written, no orphaned imports, the
`StructuredOutput` tool actually called — rather than trusting a stub "done" final message.
Ensure spawned agents **inherit the correct model** (Opus for real work, not a rate-limited
fallback). Keep authoring and review in separate passes; never let a fixer self-approve.

## 11. Merge Checklist

Before merging, run the **full gate: build + vitest + precheck + tsc** — not just one of
them. In particular, `bun run build` is the typecheck authority (vitest does not typecheck),
and watch for **TS6133 orphaned-import** errors that a plain `vite build` silently ignores.
Merge only when the full local gate AND CI are green.

## 12. Lessons Ledger — consult BEFORE acting (hard-won, session-verified)

Every rule below was paid for with a real incident; the cited post under
`site/src/content/blog/` is the full autopsy. That directory is the failure-pattern
archive (65+ postmortems; each post's frontmatter `description` is its abstract).
**Before debugging in an area, or before an operation matching a trigger below, grep the
corpus first**: `grep -ril '<keyword>' site/src/content/blog/`. Having written the lesson
down and still repeating it is a process bug — fix the process, then the code.

**Shell / git mechanics**

- Never pipe a hook-running or state-mutating git command into an early-exiting reader —
  `git commit | head` SIGPIPE-kills lint-staged mid-transaction (wedged merge + orphaned
  stash). Redirect to a file, then read the file.
  → `2026-07-14-a-pipe-into-git-commit-is-a-kill-signal.md`
- A pipe tail launders a failing exit code to 0 (no pipefail) and `2>/dev/null` erases the
  one line that names the bug — never suppress stderr on a FIRST run, and sample the input
  bytes (`head -c 300`) before asserting a schema over a file.
  → `2026-07-14-a-failure-with-no-witnesses.md`
- Generators may emit to STDOUT by contract (`bun scripts/emit-gap-matrix.ts >
scripts/gap-matrix.md`) — read the script header before assuming write-in-place; exit 0
  ≠ file written.
- Worktrees share the repository's git state — stash, refs, hooks, config; only
  HEAD/index/working-files are per-worktree.
  → `2026-07-11-git-worktrees-share-more-than-you-think.md`
- Measure LOC ceilings AFTER the prettier pre-commit hook rewrote the files:
  `git show HEAD:<file> | wc -l`, never the pre-commit working tree.
- `tsc --build` replays CACHED errors from stale `.tsbuildinfo` after branch churn —
  `--force` before diagnosing a phantom type error; one that survives `--force` is likely
  a missing package.json dep masked by that package's own tsconfig `paths` (PR #1220).

**Gates / ratchets**

- LOC ceilings have TWO authorities until the #1005 migration retires runtime/:
  `map/src/loc-ceiling-ratchet.test.ts` AND `runtime/src/engine/architecture-invariants.test.ts`
  (god-file list, `engine-rest` CI leg). Growing a tracked file means updating BOTH.
  → `2026-07-14-the-second-ratchet.md`
- A spec-coverage `supported` flip is a THREE-way sync: the spec-coverage row + the
  regenerated gap-matrix + a `RUNTIME_CAPABILITIES` row (the drift gate
  `spec-coverage-runtime-drift.test.ts` allows <3 orphans and WILL breach).
- Build the pre-merge checklist FROM `.github/workflows/test.yml`'s job matrix — a
  remembered checklist can always be missing a leg CI has; the written-down one cannot.
  → `2026-07-14-the-second-ratchet.md`

**Verification**

- Render-gate ladder: directional diff (DC>0, D1<D0) → threshold DC=0 → hash equality.
  Measure the SAME-CODE noise floor before trusting any rung; a deterministic harness
  (fixed camera, pumped convergence, software rasterizer) makes rung 3 (`md5sum`) reachable.
  → `2026-07-14-the-strongest-render-gate-is-hash-equality.md`
- A metric gradient whose x-axis is "the order I happened to run things" is noise until
  the same commit is re-run. → `2026-07-14-the-map-fossilized-half-loaded.md`
- A pixel-COUNT render gate (nonBg %) passes on broken images — assert STRUCTURE
  (connectedness / no-seam-run / expected shape) or read the frame at full resolution;
  numbers never decide alone (#1221 round 1: 1.5% "green" on a disconnected seam-artifact line).

**Process**

- Issue BODIES go stale; completion often lives in the COMMENTS — read them before
  dispatching work from an issue (a "stub" named in #797's body had been implemented and
  merged a day earlier; the completion note sat in its comments).
- Plan docs drift from landed reality — before building a phase on top of a predecessor,
  re-verify the predecessor's ACTUAL landed scope against the code, not the doc's
  description of it.
- Subagents can leave the repo on a DIFFERENT branch or stale HEAD — verify
  `git branch --show-current` + `git log -1` before building on (or committing over)
  agent-touched work; capture their diff as a patch and re-apply onto current main
  (PR #1220: batch authored on a stale sibling branch, recovered via 3-way apply).

**Architecture / data formats**

- NEVER invent a binary interchange format when a web standard covers the domain —
  **PMTiles** for vector tiles, **COG** (Cloud-Optimized GeoTIFF) for raster/coverage
  grids, GeoJSON for features. A bespoke container loses the ecosystem (no GDAL/
  tippecanoe/geotiff.js, none of the data already on the web) AND web real-time (a
  blob has no HTTP-range streaming). The zero-dep-decoder / custom-semantics arguments
  do NOT clear this bar — we paid for it twice (`.xgvt` → PMTiles, then `.xgcov`).
  PREFER reading the standard IN PLACE via range requests over converting anything;
  convert only a genuinely non-web-native source (raw HDF5/GRIB2/NetCDF or CORS-blocked),
  only server-side, and only TO a standard. If you're writing a magic number, stop.
  → `2026-07-21-the-custom-format-trap.md`

This section deliberately has NO separate index file: the posts themselves (their
frontmatter descriptions) are the single authority, and a hand-synced index would be
exactly the two-authorities drift §12's own second-ratchet entry warns about. Add a rule
here only when an incident actually recurred or plausibly will; keep each to one
actionable line plus its citation.
