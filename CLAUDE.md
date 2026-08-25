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

**Gates / ratchets**

- LOC ceilings now have ONE authority — `map/src/loc-ceiling-ratchet.test.ts`. The second
  (`architecture-invariants`' Gate 3) was retired when `runtime/` was dissolved; the
  surviving structural gates live in `map/src/architecture-invariants.test.ts`. The lesson
  stands: before adding a gate, check whether an existing one already owns the invariant.
  → `2026-07-14-the-second-ratchet.md`
- A ratchet whose allowlist keys are FILE PATHS dies silently when the files move: two
  gates (projType branching, the layer-direction spine) sat vacuously green from the P3
  extraction until the runtime dissolution audited them. Any path-keyed gate needs a
  companion assertion that every key still resolves. → `#996`
- A spec-coverage `supported` flip is a THREE-way sync: the spec-coverage row + the
  regenerated gap-matrix + a `RUNTIME_CAPABILITIES` row (the drift gate
  `spec-coverage-runtime-drift.test.ts` allows <3 orphans and WILL breach).
- Build the pre-merge checklist FROM `.github/workflows/test.yml`'s job matrix — a
  remembered checklist can always be missing a leg CI has; the written-down one cannot.
  → `2026-07-14-the-second-ratchet.md`
- A gate that ran BEFORE the state you commit did not gate it. #1864's `bun run build` and
  its 2133 green tests both passed on a tree that the commit then did not contain, so the
  missing export and the missing emitter reached main under a green local run. Re-run the
  typecheck AFTER the final `git add`, and read `git show --stat HEAD` against the change
  you think you made — a file count that does not match is the tell.

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
