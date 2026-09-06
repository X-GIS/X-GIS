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
(`compare-parity-pixeldiff`, `tile-crop-review`, and `capture-canvas` for HOW a frame is
captured and settled in the first place); treating them as optional is the
recurring mistake. They are NOT optional here.

**Forbidden:** judging a render by eyeballing a downscaled full frame or a downscaled
side-by-side composite. `Read` downscales large images, so this silently loses the
sub-pixel offsets, seams, missing shields, and width changes that real bugs live in.
Eyeballing a downscaled composite is NOT verification. Equally forbidden: capturing a
map frame with raw `locator('#map').screenshot()` / `page.screenshot()` (demo chrome
lands in the measured pixels) or settling with `waitForTimeout` sleeps — use
`captureMapFrame` / `awaitMapIdle` (e2e/helpers/visual.ts) per the `capture-canvas`
skill, owner-mandated 2026-08-25.

### "There is no GPU here" is FALSE — for BOTH backends

**WebGL2 and WebGPU both run headlessly here, on SwiftShader.** An earlier version of this
section said WebGPU did not, and that claim cost real work: it was quoted as the reason the
WGSL half of #1715 "could not be verified in this environment", by a session that had just
finished quoting the paragraph below about re-checking exactly this kind of claim.

Measured, in a GPU-less cloud container, with the bundled `headless_shell`: `_wgsl-compile-gate`
compiles every emitted variant on real **Tint**; `_emit-obfuscate-gate` **draws** and asserts
byte-identical frames; `_shader-math-parity` executes a WGSL **compute** pass; and the full map
boots on WebGPU with no `forcegl2` (console: _"WebGPU is experimental on this platform"_). The
Chromium build ships the ICD that makes it work — `libvk_swiftshader.so` and
`vk_swiftshader_icd.json` in `chrome-linux/`.

```
cd playground && XGIS_SOFTWARE_GPU=1 HEADED=0 \
  XGIS_CHROMIUM_EXECUTABLE=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | head -1) \
  ./node_modules/.bin/playwright test <spec>          # WebGL2 page: ?forcegl2=1
```

(`XGIS_CHROMIUM_EXECUTABLE` only when Playwright's pinned build differs from the
preinstalled one — never run `playwright install` here. Assert the backend in the spec so a
silent fallback cannot green it.)

**Two things make WebGPU look absent, and both are easy to hit** — which is how the wrong
claim survived. `playwright.config.ts:97-105` already sets what is needed; a hand-rolled probe
usually does not:

- **`--enable-unsafe-swiftshader` is required.** `--enable-unsafe-webgpu --use-vulkan=swiftshader`
  alone still leaves `'gpu' in navigator === false`.
- **A secure context is required.** `about:blank` has no `navigator.gpu` at all; the dev
  server's `https://localhost:3000` does. A probe that never navigates concludes the platform
  has no WebGPU.

What IS still local-GPU-only is performance and hardware-raster fidelity — SwiftShader is slow
and its rasterization is its own, so timing gates and hardware-pixel comparisons stay off this
path. Correctness of compile / link / validate / draw is not on that list.

This was paid for: the multi-region coverage work shipped a `deps.renderer` captured
before the GPU assigned it — `undefined` forever, breaking every ramp-only coverage push
and every mosaic region eviction. tsc could not see it (`!` is a promise it is assigned),
3790 unit tests could not (they inject their own deps), and 15 green CI checks did not
drive a coverage source. ONE headless WebGL2 render threw on frame one. A `test.fixme()`
whose stated reason is "no real GPU here" is now a bug to re-check, not a fact.
→ `map/src/coverage-source.test.ts`, `playground/e2e/_s111-multiregion-gate.spec.ts`

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

### 6.1 A fresh VM has NO codebase-memory — INSTALL it, do not fall back to grep

Remote/container sessions start without it every time. That absence is a 2-minute setup
step, NOT a licence to grep: doing the install once buys the whole session the
blast-radius sweep. Run this BEFORE the first code-location question.

```bash
# 1. Install. PIN 0.10.6 — `latest` (0.10.7) is DEPRECATED with a broken postinstall
#    (it fetches a GitHub release tag that does not exist). Use 0.10.8+ once published.
npm install -g codebase-memory-mcp@0.10.6        # ~7 s; pulls a ~293 MB native binary

# 2. Index THIS repo. Project name is `D-X-GIS` — every §6 call below assumes it.
codebase-memory-mcp cli index_repository \
  --repo-path "$(git rev-parse --show-toplevel)" \
  --name D-X-GIS --mode moderate                  # ~25 s; ~13.4k nodes / 53.5k edges

# 3. Register the MCP server (see the timing note below for when its tools go live).
claude mcp add codebase-memory --scope local -- codebase-memory-mcp
```

**The timing gotcha that makes this look broken:** the `mcp__codebase-memory__*` tools do
NOT appear in the turn you register them. Right after step 3, `claude mcp list` says
`Connected` while a tool search finds nothing — which reads as "the install failed" and
sends the session straight back to grep. It did not fail. **The tools go live on a
SUBSEQUENT turn** (both observed in one session: absent immediately after `mcp add`,
callable a turn later, returning real graph rows). So:

- **the turn you install in** — drive the graph through the binary's CLI, same engine, no
  restart needed;
- **every turn after** — use the `mcp__codebase-memory__*` tools directly. Do not keep
  shelling out to the CLI out of habit; check once whether the tools are there.

```bash
echo '{"project":"D-X-GIS","name_pattern":"rangeKey"}' | codebase-memory-mcp cli search_graph
codebase-memory-mcp cli <tool> --help          # flags per tool; also accepts --args-file
```

CLI notes paid for in this session (they do NOT apply to the MCP tools, only to `cli`): it
prints `level=info` / `hint:` / `warning:` lines to stdout — filter them before parsing.
`trace_path` takes `function_name` (NOT `qualified_name`) and `direction` is
`inbound` | `outbound` | `both` (NOT `in`/`out`). Install GLOBALLY, never into the repo —
the binary is ~293 MB and must never be committed.

**A graph NEGATIVE is the one answer to cross-check with grep.** It under-reported
`seededCategoryOrder`'s callers (1 of 2) on code that was already committed — not the
staleness below, just incompleteness. A "no callers" / "nothing references this" answer is
exactly the kind the graph is being trusted for, so verify it before acting; a positive
answer needs no such check.

**The index can LAG your own edits.** Indexed projects do refresh in the background, but not
instantly: `rangeLabel` returned 0 results for minutes after it was written and appeared only
after an explicit re-index (step 2). Before trusting a "no callers" / "nothing references
this" answer about code YOU just wrote, re-index — that stale negative is exactly the kind
of wrong the graph is being trusted to prevent.

### 6.2 The queries

**Use first (project="D-X-GIS"):**

- `search_graph` (name_pattern / label / qn_pattern / query) — find definitions & symbols
- `trace_path` (mode: calls | data_flow | cross_service) — callers, callees, impact, data flow
- `get_code_snippet` (qualified_name) — exact symbol source
- `query_graph` (Cypher) — complex relationship queries
- `search_code` — graph-augmented grep when you must text-match
- `get_architecture` — package/module structure
  If the project is not indexed yet, run `index_repository` (§6.1 step 2) first.

**Grep / Glob / Read remain correct for:** non-code text, configs, comments, docs; and you
must ALWAYS `Read` a file before editing it. The rule is graph-first for _finding_ code —
not a ban on Read. Pairs with the `flow-first` skill: graph the call/data flow + blast
radius before editing.

**If the `codebase-memory` MCP is not connected** (remote/container sessions lack it by
default — verify, don't assume): **install and index it (§6.1)**. Grep/Glob/Read is the
fallback only when the install itself fails — and then **say so in the reply**, so a
graph-less search is never mistaken for a graph-backed one. The rule is unreachable, not
waived — the blast-radius sweep a text search misses is then the reader's job.

## 7. Build & Test Discipline

**Parallelize by default; serialize only where it corrupts results (owner-refined
2026-08-25).** The old blanket "one heavy process at a time" over-serialized the pipeline.
The rules that remain, and WHY:

- **A TIMING MEASUREMENT owns the machine.** While a perf sweep / benchmark is running,
  do not co-run other compute — contention corrupts the measured quantity itself. This is
  instrument integrity, not ritual.
- **Do not co-run two MAXIMALLY heavy jobs** (two of: full vitest, `tsc --build --force`,
  `bun run build`, a SwiftShader render gate, `astro build`) — that combination has frozen
  the machine before. One such job + light/medium work in parallel is fine.
- Everything else runs CONCURRENTLY with a background gate: recon, design, code edits,
  docs/issue records, single-file tests, patch preparation for the next increment.
- **But never EDIT REPO SOURCES a running browser gate is serving.** The e2e gates run
  against the Vite dev server, so a save mid-run hot-reloads the page and kills the
  in-flight `page.evaluate` (`Execution context was destroyed, most likely because of a
navigation`) — a green-looking pipeline that actually measured a moving tree. Paid for
  2026-08-25: a comment-only edit during a gate's boot invalidated a 37-minute run.
  Prepare edits as patches while a browser gate is in flight; apply them after it exits.

**And NEVER idle-wait on a background gate (owner-mandated 2026-08-25).** Launch the heavy
verification `run_in_background`, then IMMEDIATELY continue the NEXT work item — including
its code, prepared as apply-ready patches when committing would widen an open PR's scope.
Ending a turn with "waiting for the gate result" delays the queued work the gate exists to
protect; the completion notification re-enters the loop and the verdict is handled then.

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

## 9.5 Long Sessions — file the ISSUE before the context is gone

**A long session silently loses detail.** Facts established early — a measured constraint, a
rejected approach and _why_, a decision the user already made — fall out of context, and the
work then re-derives them, re-proposes what was rejected, and asks again what was already
answered. The user sees the same ground covered three times. This is not a memory problem to
apologise for; it is a process problem with a fix.

**The fix: durable artifacts, written while the detail is still fresh.**

- **File a GitHub issue per work item BEFORE starting it**, not after finishing. One
  self-contained issue per shippable unit, written so someone with **zero context** can pick it
  up: the symptom, the root cause at `file:line`, what was already ruled out and by what
  evidence, the open decisions, and the verification that closes it.
  `.github/ISSUE_TEMPLATE/intent.md` is that shape as a template — the Stage-1 `intent.md`
  sections from Anthropic's AI-native SDLC loop, filed as an ISSUE rather than a committed file
  so this repo keeps ONE authority for why a work item exists (a parallel `intent/` tree would
  be the two-authorities drift §12 warns about).
- **Record a constraint the moment it is discovered**, in the issue or a `docs/plans/` note —
  especially one that took real work to find (a precision limit, a measured cost, a backend
  asymmetry). A constraint that is expensive to discover and cheap to forget WILL be rediscovered
  the expensive way.
- **Write down a rejected approach WITH its reason.** Without the reason it gets re-proposed;
  the reason is the whole value.
- **A decision the user made is a fact, not a preference to re-weigh.** Put it in the issue. Do
  not re-open it in a later turn because the supporting detail scrolled away.
- Prefer **one issue at a time, closed properly**, over several half-finished in parallel. The
  session-local task list is scratch; the issue is the record.

**These guidelines are working if:** the user is never asked the same question twice, no rejected
approach comes back, and any single issue can be resumed cold without re-reading the
conversation.

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

**Standing owner authorization (2026-08-17):** once a PR that resolves an issue has passed
the full gate above (plus §5 render verification where the diff touches rendering),
merging it to main is pre-approved by default — execute the merge (pr-merge-gauntlet)
without asking per-PR. This waives no gate and no verification; it removes only the
per-merge confirmation.

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
- A DIAGNOSTIC command appended after a verification command becomes the exit code — `bun run
build > log; grep -c "error TS" log` reports FAILURE on a clean build, because grep exits 1
  when it matches nothing. The mirror of the pipe-laundering entry above: that one hides a
  failure, this one invents one. Capture `$?` immediately, then diagnose.
- `pgrep -f <pattern>` issued from a tool call MATCHES THE CALLING SHELL — the shell's own
  command line contains the pattern. So `until ! pgrep -f 'bun run build'` never exits, and a
  `pgrep -fc vitest` status poll returns nonzero while NOTHING is running: a job that never
  started reads as "still running". Cost a full vitest sweep reported as in-flight for ~40
  minutes that had never been launched (the log file did not exist). Use a bracket pattern
  (`[v]itest`), or better, do not poll at all — launch with `run_in_background` and read the
  harness's exit code. Same family as the poller entry under Verification.
- The bracket trick does NOT save you from `pkill -f` — it only stops the pattern matching
  ITSELF, not the calling shell whose command line still contains it. `pkill -f
"[c]odebase-memory"` killed the very shell that issued it (exit 143/144), taking the
  command after it with it. Never `pkill -f` a pattern you just typed: identify the PID first
  (`ps -eo pid,etimes,comm` filtered on the COMMAND column, which never contains your
  arguments) and kill by PID, or let the harness's `run_in_background` own the lifecycle.
- `cd` PERSISTS across a compound command, so a relative path in a restore step resolves
  against the new directory — a `cd playground && … ; cp backup map/src/x.ts` silently writes
  to `playground/map/src/`, leaving the probe's edit live. Cost a reported "the fix does not
  work" that was actually the fix never being restored. Use ABSOLUTE paths in any
  edit-probe-restore cycle, and assert the restore (`grep -c` the marker) before believing the
  run that follows.
- A `git checkout <ref> -- <paths>` on the LIVE tree is the same edit-probe-restore trap
  one level worse: it moves the INDEX as well as the working files, so a later `git merge`
  can resolve against the probe's state and drop your work with NO conflict reported. Cost
  PR #1864, whose squash landed 3 new files and zero of the 434 emitter lines it existed
  for — `glsl.ts` came out byte-identical to main, which had never touched that file. Probe
  another ref in a `git worktree`, never in the tree you are about to commit; if you already
  did, `git diff <your-last-commit> HEAD -- <src>` before pushing.
- Worktrees share the repository's git state — stash, refs, hooks, config; only
  HEAD/index/working-files are per-worktree.
  → `2026-07-11-git-worktrees-share-more-than-you-think.md`
- A LONG-LIVED DEV SERVER outlives your branch switch, and its stale module graph then
  reads as a NETWORK failure. Vite serves the graph it resolved before the checkout, so a
  module that exists only on the branch you left is still requested — a `@fs/` URL for
  `sprite-atlas-need.ts` 404s, the page dies with `ERR_CONNECTION_RESET`, and three e2e runs
  were about to be classified NEEDS-LOCAL-RUN (blocked egress) even though `curl` had just
  shown the same server healthy on both `demo.html` and the fixture. What named it was
  `page.on('response', r => r.status() >= 400)`: the 404 carries the path, and the path was
  a file from the abandoned branch. Never switch branches under a running dev server — stop
  it first (by PID, never `pkill -f`), or give the other branch its own worktree and server;
  and print the failing RESPONSE URLs before blaming the environment.
- Measure LOC ceilings AFTER the prettier pre-commit hook rewrote the files:
  `git show HEAD:<file> | wc -l`, never the pre-commit working tree.
- `tsc --build` replays CACHED errors from stale `.tsbuildinfo` after branch churn —
  `--force` before diagnosing a phantom type error; one that survives `--force` is likely
  a missing package.json dep masked by that package's own tsconfig `paths` (PR #1220).
- `git add -A` stages whatever the session happened to leave lying around. A screenshot
  harness written into the repo (rather than the scratch dir) rode into a commit that way
  and needed a second commit to remove it. The tell is that the commit's file count does
  not match the change you described. **Read `git status --porcelain` and stage by PATH**
  when the working tree holds anything you did not intend to ship; keep probe scripts,
  captures and logs in the session scratch dir, never under a package.
- A UNIT read off a neighbouring transform is not the unit at your call site. `packDrawSubKey`
  divided the world-copy offset by 360 000 because `_worldOffScratchKey` emits
  `worldOffDeg * 1e3` — but that transform feeds the bundle-cache key, and both dedup call
  sites pass the raw `worldOffDeg[]`, in degrees. `Math.round(360 / 360000)` is 0, so every
  world copy folded onto one sub-key and the 2nd/3rd copies were skipped as duplicates; no
  single-world scene can see it (0 divides to 0 under either step), so every local §5 gate
  stayed green and CI's `_world-copies-projection-gate` caught it. The tests passed for the
  same reason the code was wrong: the `copy()` helper was `wc * 360_000`, the premise written
  a second time — and the packer's own docblock cited the producer's `wc * 360` one line above
  the division. Trace a unit to the PRODUCER that feeds YOUR parameter (here: the
  `renderTileKeys` argument, six calls, all `worldOffDeg`/`fallbackOffsets`), assert it at
  runtime, and make at least one test stand on the LITERAL a real caller passes rather than on
  a helper. → PR #2495

**Gates / ratchets**

- LOC ceilings now have ONE authority — `map/src/loc-ceiling-ratchet.test.ts`. The second
  (`architecture-invariants`' Gate 3) was retired when `runtime/` was dissolved; the
  surviving structural gates live in `map/src/architecture-invariants.test.ts`. The lesson
  stands: before adding a gate, check whether an existing one already owns the invariant.
  → `2026-07-14-the-second-ratchet.md`
- A gate must CONVERGE ON, and MEASURE, exactly the quantity it asserts about. Three
  violations surfaced in one day: a convergence poll keyed on ALL tiles while the assertion
  counted only `z >= 1`, so it declared victory on a z=0-only set and blamed the page
  (#2114); two parity gates hashing DOM chrome; and the same two letting a wall-clock-driven
  controller move the tile set under them. Each read as a rendering regression. → #2114, #2120
- A ratchet whose allowlist keys are FILE PATHS dies silently when the files move: two
  gates (projType branching, the layer-direction spine) sat vacuously green from the P3
  extraction until the runtime dissolution audited them. Any path-keyed gate needs a
  companion assertion that every key still resolves. → `#996`
- A WARNING OUTLIVES THE GAP IT DESCRIBES, and no gate can see it. `sources.ts` told
  authors `raster-dem` rendering was "not yet supported (Batch 4)" for as long as #777
  had been rendering it on both backends, while spec-coverage carried the row at
  `supported` — the drift gate matches row PRESENCE, not agreement between a row and a
  warning. Twice now (#2489 the row, #2520 the warning). Guard it BEHAVIOURALLY: convert
  a minimal style per `supported` row and read the warnings the author actually gets,
  with the `unsupported` rows as the CONTROL — a detector that cannot see a deferral
  reports zero, which reads as a clean corpus. Scanning converter SOURCE for deferral
  phrases is the wrong shape here: source-type names are ordinary words. → `#2520`
- A spec-coverage `supported` flip is a THREE-way sync: the spec-coverage row + the
  regenerated gap-matrix + a `RUNTIME_CAPABILITIES` row (the drift gate
  `spec-coverage-runtime-drift.test.ts` allows <3 orphans and WILL breach).
- A PR with NO CI run at all — not a red one, none, across several pushes — is almost always
  an UN-MERGEABLE PR, not a runner-pool problem: `pull_request` runs execute against
  `refs/pull/N/merge`, and when the PR conflicts with its base GitHub cannot build that ref,
  so it creates no run, no cancelled run and no status. #2330 sat like that for 34 hours across
  ~8 pushes while it was misattributed twice (a saturated queue; a 403 on manual dispatch);
  the first conflict-free push produced a run within seconds. Check `mergeable_state` before
  blaming the runners; merge the base and the run appears on the next push.
- Build the pre-merge checklist FROM `.github/workflows/test.yml`'s job matrix — a
  remembered checklist can always be missing a leg CI has; the written-down one cannot.
  → `2026-07-14-the-second-ratchet.md`
- A gate that ran BEFORE the state you commit did not gate it. #1864's `bun run build` and
  its 2133 green tests both passed on a tree that the commit then did not contain, so the
  missing export and the missing emitter reached main under a green local run. Re-run the
  typecheck AFTER the final `git add`, and read `git show --stat HEAD` against the change
  you think you made — a file count that does not match is the tell.
- Two branches raising the SAME ratchet key to the SAME number from the same base merge
  with NO conflict, and the file then takes BOTH deltas — the ceiling is now one change too
  low and the ratchet reds on main having been green on both branches. git cannot see it:
  the resolved line is byte-identical to each side. RE-MEASURE every ceiling you raised
  after the merge, never carry the number across.
- A test-only WITNESS applied at a PACKER dies the day the packer is replaced. #2151 made
  the uniform split-bind the default, so the tile anchors came from `TileUniformArena`
  instead of the legacy block the §5 skew hook wrote — the witness stopped reaching the
  shader, and the only reason anyone noticed is that it reddened first. A week later it
  would have gone GREEN with its cut arm moving nothing. Apply a witness at the SINGLE
  PRODUCER of the value it perturbs, so every packer inherits it by construction. → `#2165`
- A gate that INHERITS a global default silently changes subject when the default flips.
  `_rtc-recombine-parity-gate` is a CONSUMER of the bind path, not part of the split-bind
  feature, so #2151's pre-merge check (which covered the two gates that SET the flag, and
  were immune by construction) could not cover it. A gate must PIN the mode it measures —
  and where two modes have different semantics, assert each mode's own (the split path has
  no flag select at all, so "OFF + skew must be inert" is a premise it does not have).
  → `#2165`, and it is §12's shared-path/consumer-gates rule one increment on.
- A ratchet that counts identifiers PER FILE measures where a type is WRITTEN, not what the
  code touches — so a refactor that only RELOCATES existing debt reddens it. #2508's frame-state
  record restated the `GPURenderPassEncoder` that `render()` already unwraps: declaring it in the
  types file grew THAT file's #991 raw-WebGPU count, and typing it there through
  `typeof unwrapWebGpuPass` grew the backend-adapter count instead. Declare such a type in the
  file that already owns the seam, and DERIVE it from that seam so it follows when the seam
  moves; never raise a baseline for a move. → `#2508`
- A CACHE silently retires a "read live per frame" premise. The same gate injects its flags
  post-ready and documents why it may; `TileUniformArena` packs a slot ONCE and reuses it
  forever, so after INC-4b a flag set after boot could never reach a resident tile. When you
  move a value behind a pack-once cache, go read what the tests assumed about how often it
  is read. → `#2165`

**Verification**

- A PAGE is verified by looking at the PAGE, not at the markdown behind it. Every gate around
  the API reference was green and the pages were still wrong: an identifier heading published
  UPPERCASED (a parameter `v` rendered `V`, on a case-sensitive language's reference), the
  breadcrumb painted behind the fixed header, `Node<"f32">` shattered into four chips, and
  every page loading pre-scrolled — `voidT` opened with its own `<h1>` at y=-5 — because a
  rail's `scrollIntoView` scrolls EVERY scrollable ancestor, the document included. None of it
  is visible in the generated `.md`, and none of it can fail a build. Screenshot the built page
  and read it at full resolution (§5's tile split), then measure the DOM (`getBoundingClientRect`,
  `getComputedStyle`, `scrollY`) — the numbers name the cause the picture only shows.
- Astro's content layer caches RENDERED html in `site/node_modules/.astro/data-store.json`, and
  editing a rehype plugin in `astro.config.mjs` does NOT invalidate it — a clean `bun run build`
  emits the OLD markup with no warning, so a correct plugin looks broken and invites a "fix".
  `build-api-reference.ts` now drops that file on every run; if a plugin edit still seems inert,
  delete it before doubting the plugin.
- A gate that screenshots the PAGE can hash its own CONVERGENCE STATE. `#status`'s opacity
  AND its text are a direct function of `map.getMissingTileCount()`
  (`playground/src/demo-runner.ts:1019-1033`), and it overlaps the canvas — so two parity
  gates were printing "loading N tiles…" into the frames they then compared. ~53% of one
  gate's step-0 diff, at maxΔ 218, which reads as a rendering regression. A clipped
  `page.screenshot` over the canvas BOX is not chrome-free: `DEMO_CHROME_IDS`
  (`e2e/helpers/visual.ts`) exists because those elements overlap it. Use `captureMapFrame`.
  → #2120
- Chrome can UN-HIDE itself after the hide. The log overlay rewrites its own inline `display`
  on every console.warn, so a DEV warning landing between two captures (the #2266 owner-leak
  detector under `__XGIS_INVARIANTS`) put the overlay back into the frame — 12962 px of
  "⚠ Errors" text hashed as a recombine regression and bisected to the commit that added the
  WARNING, not to any render change. `hideDemoChrome` now hides by a stylesheet `!important`
  rule, which outranks any inline write; never hide chrome with an inline style, and when a
  gate reddens on the commit that added a diagnostic, read the saved frame before the shader.
  → #2284
- A RENDER INPUT can be a function of WALL-CLOCK. The adaptive quality controller samples
  measured rendered-frame intervals and runs live wherever `?adaptive=0` / `?scenescale` is
  absent; measured on one scene at notch 0 → 3 → 4 with `adaptiveFarLodBoost` 1 → 4, and that
  boost multiplies the tile selector's far-field error ceiling — so the SELECTOR asks for a
  different tile set on a slower machine. A hash-equality rung has no tolerance to absorb it.
  Pin with `?adaptive=0` (applied at module load, before the first frame is sampled).
  `?scenescale=` is NOT a substitute: it pins the dpr half only and leaves the selector
  moving. → #2120
- A DIFF-BASED GATE NEEDS A SAME-STATE CONTROL ARM, captured LAST, or its threshold is
  a coin toss. `_terrain-displacement-gate`'s first draft settled arms with
  `waitForTimeout` and the cut-check then reported DC 56.7% with the displacement
  SEVERED — the scene was still converging between arms, so over half the frame differed
  for reasons unrelated to the thing measured, and a `>0.1%` rung meant nothing. Settling
  with `awaitMapIdle` took the floor to 0.000% against rungs of 41% and 78%. Capture an
  extra arm in the REFERENCE state after all the others, assert that floor BEFORE
  concluding anything from the rungs, and never settle a measured arm with a sleep (§5
  says this; the cost of ignoring it is a gate that looks decisive and is not). → `#2539`
- A pre-push SWEEP must grep the SHORTEST substring a test could assert, and the pre-push
  GATE must be the whole CI shard, not hand-picked suites. Removing a converter note swept
  for the long phrase, ran 7 chosen suites green, and CI then failed on
  `toContain('Batch 4')` in an eighth file — a second test pinning the same bug. Two
  round-trips for one edit. → `#2520`
- CROSS-GATE AGREEMENT is cheap evidence and nobody was using it. Two gates toggling DISJOINT
  flags produced the SAME unexplained hash pair — one pair cannot be caused by two different
  flags, so it had to be the harness (it was boot order). After the fix the two gates agree
  hash-for-hash across four flag states, which no single gate fixed to suit itself could
  fake. When a parity gate is red, check whether a sibling gate on the same scene says the
  same thing. → #2120
- Render-gate ladder: directional diff (DC>0, D1<D0) → threshold DC=0 → hash equality.
  Measure the SAME-CODE noise floor before trusting any rung; a deterministic harness
  (fixed camera, pumped convergence, software rasterizer) makes rung 3 (`md5sum`) reachable.
  → `2026-07-14-the-strongest-render-gate-is-hash-equality.md`
- A metric gradient whose x-axis is "the order I happened to run things" is noise until
  the same commit is re-run. → `2026-07-14-the-map-fossilized-half-loaded.md`
- A pixel-COUNT render gate (nonBg %) passes on broken images — assert STRUCTURE
  (connectedness / no-seam-run / expected shape) or read the frame at full resolution;
  numbers never decide alone (#1221 round 1: 1.5% "green" on a disconnected seam-artifact line).
- An assertion carries information only if it DISTINGUISHES the states of the thing it tests.
  A gate can be deterministic, loud and specific and still be worthless: `_adaptive-quality-
ladder-gate` asserted on triangles, and severing the controller→selector wire it exists to
  watch failed IDENTICALLY to the wire working, so no premise fix could ever green it. Don't
  just check fail-before goes red — CUT THE SPECIFIC MECHANISM and confirm the message names
  the severed half. → `2026-07-28-the-assertion-that-failed-either-way.md`
- One step EARLIER than the entry above: the assertions can be fine and the INPUTS still carry
  no information. A storage-upload rewrite shipped 5 green tests that each passed a WHOLE typed
  array (`byteOffset` 0) — the exact case where the buggy `new Uint32Array(data.buffer)` and the
  correct windowed view are the same line. Production passes frame-arena SUBARRAYS, so WebGL2
  uploaded a neighbouring renderer's bytes and drew nothing. Feed at least one input shaped the
  way real callers shape it, and plant a decoy around it.
  → `2026-08-14-every-test-passed-offset-zero.md`
- One step earlier AGAIN: the assertions and the inputs can both be fine and the INSTRUMENT you
  measure with can still be blind — and a blind instrument reports ZERO, which reads as a
  finding. Counting optimizer opportunities by regex over EMITTED TEXT does exactly this: the
  emitter CSEs every expression into a `let` chain, so `vec2(x,y).x` is spelled `_cseN.y` two
  statements apart and a nested-shape regex finds none of it. 13 of 15 gcc-parity rules
  measured "0 sites" that way; re-measured on the IR with let-bindings resolved,
  member-of-construct alone is 37 sites in the default emit and 2,420 after
  `forceInline('all')`. Worse, the same blind probe produced a FALSE SAFETY claim that reached
  main ("adding this fold changed nothing") when a let-resolving fold deletes
  `renormForCancel`'s twoSum — the #915 guard. Count on the IR, never the text; validate the
  instrument against a KNOWN POSITIVE before believing a zero (one was already in hand, built
  by hand two probes earlier); and read a uniform zero as a broken ruler, not a clean corpus.
  → `#1972`
- A POLLER is an instrument too, and the same zero lies. A CI wait-loop built on unauthenticated
  `curl` got `{"message":"GitHub access is not enabled for this session..."}`, and its
  `d.get('check_runs', [])` turned that into an empty list — no jobs busy, so it printed
  `DONE all-green` on the FIRST poll and the push that followed supersede-cancelled three
  live render shards plus the `render-gate` that runs after them. Two tells were on screen:
  it "passed" in under a second, and the report was used to claim something stronger than the
  authenticated API had actually shown. Never treat a missing key as an empty result — parse
  strictly and fail loud on an unexpected shape; poll the WORKFLOW RUN, not a name-matched
  subset of its jobs (`render-gate` has `needs: render-shard`, so shards-all-green is not
  run-done); and check the wait actually WAITED before believing what it says.
  → `#1972`
- A change that REFACTORS a shared path owes the gates of that path's CONSUMERS, not the gates of
  the feature that motivated it — those are different sets, and the feature's own are the ones you
  will think of. Same incident: the integer-texture gates were run and green; the point/icon/line
  gates that used the rewritten upload were not. → same post
- ORDER decides which half a red run accuses. Once that same gate HAD a distinguishing assertion
  it still mis-attributed: the lever check sat below the selector-outcome checks, and since a dead
  lever and an ignored live one leave the SAME tile histogram, the first assertion to run is the
  one that reports — a controller-half cut died naming the selector. Assert the CAUSE before the
  EFFECT, and cut EACH half separately; one cut only ever proves one message. → `#1444`
- Assert on the quantity the subsystem MOVES, not one downstream of it, and never attribute a
  cause from a COMPOSITE number: triangles = tiles × geometry-per-tile, so a coarser tile set
  read as "the ladder added 44% geometry" when the selector had done exactly its job (tiles
  6→5) and the fixture's un-generalized grid supplied the rest. Decompose before accusing a
  subsystem. → same post
- Attribute against the branch's ACTUAL base, FETCHED — a `git checkout main` that is four
  commits stale turns someone else's regression into yours. Nearly sent a fix into a raster
  cache budget where nothing was wrong; the tell was the CONTROL arm having moved too.
- A Playwright budget declared INSIDE a test body governs the body only — fixture setup is
  still on the config default, which is where a loaded runner actually times out (`Test timeout
of 60000ms exceeded while setting up "context"`). A CLI `--timeout` does not override it
  either, so a probe can silently measure the old budget and "prove" the wrong thing. Declare it
  where it covers setup: `test.describe.configure({ timeout })` or the per-test options object.
  (Body-scope is the repo's prevailing idiom in 320 of 351 specs and is fine where fixtures are
  cheap — this is about the heavy ones, not a ban.)
- A diagnostic nothing can reach is not a diagnostic. `adaptiveQualityStep()` was documented
  "exposed so a gate can assert the controller ACTED" and was surfaced on no public object —
  three rounds of inference circled a question the system already knew. Intent in a comment
  is not wiring; check the accessor is reachable from where a test runs.
- A shader edit-probe that skips `bun run bake:shaders` proves NOTHING, and the way it fails
  is to look like a vacuous gate. The page consumes the BAKED artifact, so cutting a
  `map/src/shaders/dsl/` mechanism and re-running the render gate leaves it GREEN — read as
  "this gate cannot distinguish", which is the opposite of true. Re-baked, the same cut
  reddened naming exactly the severed half. Bake after the cut AND after the restore, and
  assert `git status --porcelain map/src/shaders/baked/` is empty before believing either
  run. → #2117
- A verdict about how code behaves is NOT finished at the first consumer, and the
  refutation is usually already written in a DOCBLOCK one or two files away. Three verdicts
  in one session — "the palette is the carrier for a per-feature pattern", "23 bits is the
  collision space", "text-optional only needs the drop-cascade suppressed" — each died to
  something the trace had not reached, and TWICE the answer sat in the docstring of the very
  function being quoted: `feature-data-pack.ts:19-21` names `shader-gen.ts`'s `% <palette>`
  (space 20, not 2^23 — collisions CERTAIN at 21, not 1% at 411); `text-stage.ts:743-753`
  states the #609 premise `text-optional: true` falsifies (the surviving icon then seeds NO
  obstacle box); `rhi-fill-variant.ts:29-31` names the r32float fence an atlas-of-bboxes
  fails to LINK against on WebGL2. Before acting on "this IS the mechanism" or "this is
  small": name the INVARIANT the verdict rests on and sweep what DEPENDS on it, not merely
  what CALLS it — the third case was no caller at all, it was a separate optimisation
  resting on the same premise. FILING is an action this gate precedes, not a draft of it:
  the one case that skipped it cost an issue filed and closed not-planned. §6's graph is the
  sweep tool (`trace_path`, direction `both`); it flapped all session here and the fallback
  to grep went UNANNOUNCED, which §6.1 forbids for exactly this reason.
  → `#2427` (filed on the refuted premise), `#2440`, `#2439`
- A CI-FAILURE WAKE CAN NAME A COMMIT THAT IS NO LONGER HEAD. `test.yml`'s concurrency
  cancels a PR's in-flight run on the next push, and the two AGGREGATING jobs —
  `test-result` and `render-gate` — conclude `failure` when the jobs they `needs` were
  CANCELLED. So every push to an active PR manufactures two red check_run events against
  the OLD sha, indistinguishable in the wake envelope from a real regression. Cost two
  rounds of investigation in one session before the pattern was named. READ `head_sha`
  AGAINST THE PR'S CURRENT HEAD FIRST (`pull_request_read` `get_check_runs` lists only the
  current head's checks — a failure absent from that list is a superseded run, not a
  regression), and prefer to push EARLY in a run's life: superseding at minute 5 costs
  nothing, at minute 55 it costs the render shards. The sibling of the poller entry above,
  from the reader's side rather than the pusher's. → PR #2533

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

- The data is almost always ALREADY in a standard, and the domain names which one —
  **HDF5 / NetCDF** for scientific gridded data (S-100, NOAA model output), **COG**
  for georeferenced imagery/raster, **PMTiles** for vector tiles, GeoJSON for features.
  Write/reuse a READER for that standard (our HDF5 reader, `geotiff.js`, `pmtiles`) —
  that is legitimate. What is FORBIDDEN is TRANSCODING a standard into a house blob
  (`.xgcov` did exactly this to HDF5 we already had a reader for): a bespoke container
  loses the ecosystem (no GDAL/geotiff.js, none of the data already on the web) AND
  web real-time (a blob has no HTTP-range streaming). Zero-dep-decoder / custom-semantics
  arguments do NOT clear this bar — paid for twice (`.xgvt` → PMTiles, then `.xgcov`).
  PREFER reading the standard IN PLACE via range requests (HDF5 IS range-readable) over
  converting anything; convert only a source that truly cannot be read as-is, server-side,
  only TO a standard. If you're writing a magic number, stop.
  → `2026-07-21-the-custom-format-trap.md`
- A MODULE THAT REUSES ANOTHER'S VERTEX AUTHORITY OWES THAT AUTHORITY'S BINDINGS.
  `hillshade.ts` reuses raster's `vs_tile` byte-for-byte; the moment that fn sampled a new
  DEM texture, hillshade's own `bindings:` list made the WGSL fail to parse
  (`unresolved value 'dem_tex'`). Two more from the same edit, both refused loudly by the
  RHI rather than mis-bound: two textures in one group must BOTH carry `name` (WebGL2
  pairs unnamed entries by ORDER — true for one texture, false for two), and a texture a
  VERTEX stage reads needs `vertexVisible: true` or WebGPU rejects the pipeline. Reflection
  derives stage visibility from usage, but the HOST's hand-written layout does not.
  → `#2539`
- A TEST DOUBLE cast `as unknown as` is invisible to tsc, so adding an UNCONDITIONAL
  production call on a stubbed path compiles green and crashes only in CI
  (`live.renderer.setSeededFeatures is not a function`). When you add a method a
  hand-rolled stub must now carry, grep the stubs and give them the method as a `vi.fn()`
  — then ASSERT the forwarding, so the stub is a gate rather than a hole. → `#2439`
- A pipeline VARIANT is not portable between passes — copying a draper copies an assumption
  about the pass it draws into. `Material` synthesises a depth-stencil from a TRUTHY
  `depthCompare`, so `depthCompare: 'always'` (right in an opaque-pass draper) makes every
  `SetPipeline` on an offscreen COLOUR-ONLY pass a validation error, and the layer never runs
  once. Invisible without a GPU: the step succeeds against a recorder and the only symptom is
  motion that never starts. Re-derive depth/sample state from the TARGET pass, and gate it by
  asserting the created descriptor through the real `Material` path.
  → `2026-07-27-the-pipeline-that-was-right-somewhere-else.md`

This section deliberately has NO separate index file: the posts themselves (their
frontmatter descriptions) are the single authority, and a hand-synced index would be
exactly the two-authorities drift §12's own second-ratchet entry warns about. Add a rule
here only when an incident actually recurred or plausibly will; keep each to one
actionable line plus its citation.

## 13. Session Start — verify what you inherited, don't trust it

A session begins with no memory of the one before it. Everything it inherits — a working
copy, a `node_modules`, a green check, "that flake was fixed" — is a **claim left by
someone who is no longer here.** Three hours went into believing such claims on
2026-08-20, so the first move of a session is to check them, not to build on them.

**Run this before the first substantive change:**

```bash
bun scripts/session-check.ts     # branch / HEAD / dirty / behind-main / dependency drift
```

It owns only the mechanical half — facts about the working copy. It exits non-zero on the
one unambiguous finding: a dependency **declared but not installed**. That is what bit —
`main` gained `shiki` in `site` (#1911) while this container's `node_modules` predated it,
and the symptom was a Rollup `cannot resolve shiki/core` that reads like a code bug. It was
misdiagnosed twice, in opposite directions, before file timestamps settled it. `bun install
--frozen-lockfile --dry-run` cannot see this: it plans against the LOCKFILE and prints
"done" while the tree on disk is stale.

**The other half cannot be scripted — it is re-reading evidence, and it is the half that
costs hours:**

- **A "fixed" flake is not fixed until a run SINCE the fix shows it clean.** `_globe-
dateline-wired-gate` was rewritten in #1897 to remove a flake, flaked again the same day,
  and the fix still looked like a fix. This is now checkable: every render shard prints
  `flaky-report: N flaky in render-shard k/4`, and a recurrence raises a `::warning::`
  annotation (#1924/#1930). **Read it before repeating "that one is handled".**
- **A green check does not mean YOUR gate ran.** The render leg is sharded; a spec you did
  not touch can be the only thing a shard exercised. Confirm the relevant spec appears in a
  shard log before treating green as evidence about your change (§5 is about the same
  vacuity, one level down).
- **`conclusion: success` does not distinguish first-try from retry-recovered.** The
  check-run API carries `output.title` / `output.summary` / `output.text` as EMPTY STRINGS,
  so the UI cannot show you the difference. The marker above is the only place it appears.
- **A decision, measurement or rejected approach recorded on an issue is a FACT, not a
  starting point for re-derivation** (§9.5). Read the issue's COMMENTS, not just its body —
  completion often lives there.

**This is working if** a session never spends its second hour discovering something the
previous session already knew, and never reports "verified" about a gate that did not run.

## 14. Duplication — the ratchet and the consolidation rule

The codebase grew feature-by-feature, and a mechanical survey (2026-09-05, jscpd) found the
debt where that growth pattern leaves it: **sibling families** (retained packers / materials /
DSL shaders / feat-layouts, source backends, paint converters) copied per primitive, and
repetition inside god-files. Fitted code, not generic foundations. The rules that stop it
compounding, borrowed from how large codebases do it (Linux `lib/` + Coccinelle, LLVM
`ADT/Support` + TableGen, rustc `tidy`, the rule of three) — full rationale in
`docs/adr/0013-duplication-ratchet-and-consolidation.md`:

- **`bun run dup` is a CI gate** (the `lint` job, and the first `precheck` step): jscpd
  compares this branch's clone set against the tree of its merge base with `origin/main` and
  reds on any pair the base does not have (≥70 tokens / 5 lines, tests excluded). Nothing is
  stored, so there is no baseline to re-record. That is NOT the same as immunity to base
  movement, and the gate shipped believing it was: `resolveBaseRef` fell back to main's TIP
  when `merge-base` failed, which under CI's shallow checkout was always — so it compared a
  branch against a commit it had not merged, and any commit that re-anchored a clone made
  untouched files look newly duplicated (#2591 / #2593, 2026-09-06). Fixed by deepening and
  throwing instead of guessing, plus `fetch-depth: 0` on the `lint` job. If you ever see it
  again: **merge main into the branch and re-run** — never silence it with `jscpd:ignore`,
  which records a false reason and blinds the gate to a future real paste there. There is no accept command and no
  `--allow-growth`: the only way past the gate is to remove the copy or mark a deliberate
  twin (below).
- **Before authoring a sibling** of an existing packer / material / backend / converter, run
  `bun run dup:report` and read the cluster it will join. The third copy within a package,
  or the SECOND copy across a package boundary, is the moment to extract — not "later".
- **Where the helper lives:** the lowest package on the dependency spine that every user may
  import (the dependency-direction ratchet decides): pure math / collections → `shared/`,
  geodesy → `geo/`, IR walkers → `shader-dsl/src/core/ir`, a render-side family → a
  table-driven base beside it. Never upward, never a new package for one helper.
- **Consolidate = helper + rewrite EVERY copy in the same PR + a guard.** The gate only sees
  what a branch ADDS, so leaving two of five copies behind is GREEN — `bun run dup:report`
  showing the cluster gone is the proof, not the gate. Where a copy is easy to reintroduce,
  add a ratchet test or `no-restricted-syntax` rule naming the helper (the Coccinelle
  pattern: the semantic patch stays in tree).
- **A deliberate twin** is marked `// jscpd:ignore-start — <reason> (#issue)` …
  `// jscpd:ignore-end`; the gate rejects a bare marker. A copy that avoids a dependency
  edge across a boundary can be right (Go: "a little copying is better than a little
  dependency") — say so in the marker.
- Test duplication is reported (`bun run dup:report --tests`), not gated — different remedy
  (shared fixture builders), and a gate on `arrange` blocks gets bypassed.
- **The gate is TOKEN-level, and that is about HALF of what is there.** Measured 2026-09-05,
  both passes summed per pair so the units match: 279 token pairs / 3673 lines, against **241
  further pairs / 3831 lines that appear only once identifiers are erased** — because the
  sibling families differ in exactly the names that say which primitive they serve. A further
  86 pairs EXTEND a pair the gate already flags (the retained drapers: 31 scattered lines
  gated, 77 in one fragment under the lens); those are counted separately, because "the gate
  under-measures this" is a different claim from "the gate is blind to this". `bun run
dup:shape` is the lens (structure-only mirror via the TypeScript scanner, minus what the
  token pass covers — **by range overlap, not by equal start line** — minus two noise classes:
  a list matching itself shifted, and uniform data tables). **Report only, never a gate** — a
  colour table is a legitimate false positive, and gating on a heuristic that calls it
  duplication is ADR-0013 alternative 8 all over again. Read it before consolidating a family:
  scope the work from the cluster, not from the corner the gate shows you.
- **What NOTHING here catches: Type-4** — a helper re-invented under a different name with a
  different shape. No detector in this repo finds it, and none is proposed: a detector that
  reports zero reads as "clean", which is worse than a documented blind spot (#2561). The
  levers are the report plus review, and the co-change signal — but that signal needs a
  MEDIATOR check before it means anything, and needs an import resolver that handles `.js`
  specifiers. Both bit here: `glsl.ts ↔ wgsl.ts` was published as the archetype "with no
  import edge" when `glsl.ts:70` has imported `./wgsl.js` since the backend's first commit —
  missed because `shader-dsl` is the ONLY package writing `.js` specifiers (883 of them;
  every other package: 0), so a resolver that does not rewrite `.js`→`.ts` is blind in
  exactly the package that produced the headline. And the pairs co-change with the file that
  MEDIATES them (RHI adapters: 8 of 8 also touch `rhi/src/rhi.ts`), which reads as
  implementations moving with their interface — the signature of a HEALTHY abstraction, not
  a missing one. Lockstep alone is not evidence. → #2561
- **The detector is token-level and not perfect.** `.jscpd.json` routes `.ts/.tsx` through
  jscpd's JavaScript tokenizer on purpose: the TypeScript one has a deterministic blind spot
  (repro in the ADR), while the JS one flagged every planted whole-function copy above the
  token floor (30 probes). `dup:report --type-insensitive` is the annotation-insensitive lens.
