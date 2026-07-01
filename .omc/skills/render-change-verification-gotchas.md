---
name: render-change-verification-gotchas
description: DC=0 dance git-safety, full-suite (not name-glob), streaming hard-settle, and DC=0-is-no-regression-not-correctness — the traps when verifying an X-GIS render change
triggers:
  - _dc0-diff
  - reloc-dc0
  - DC=0 dance
  - git stash pop wrong stash
  - vitest run point
  - streaming flake settle
  - render refactor verification
  - point-packing verify
---

# Verifying an X-GIS render change: four traps that hid real bugs

## The Insight
The DC=0 pixel-diff dance and a name-globbed `vitest run` feel like enough, but
each has a failure mode this codebase hit:

1. **DC=0 is a NO-REGRESSION gate, not a CORRECTNESS gate.** It proves "unchanged
   vs a baseline," so a bug present in BOTH before+after passes, and an
   offset-dependent memory corruption (see [[point-packer-arena-aliasing]]) is
   byte-invisible at the point-counts/arena-offsets your chosen demo happens to
   use. Pair DC=0 with deterministic GPU-free wiring tests + the FULL vitest.

2. **`vitest run <glob>` misses siblings.** `vitest run point` matches
   `point-*.test.ts` but NOT `circle-radius-wiring.test.ts` — a point/circle test
   under a different name. A shared-module refactor (the point packer) must be
   gated by the **FULL** `vitest run`, not a per-stage name glob; the aliasing
   regression only surfaced in the full suite.

3. **Streaming tile demos flake unless hard-settled.** URL-geojson demos
   (gradient_points, custom_shapes) load tiles async; a 6.5 s settle gives a
   false DC>0 (e.g. custom_shapes 82366) that is pure load-timing, not a real
   diff. Confirm with a same-code double-capture; use a ~11 s hard settle for a
   trustworthy DC number on streaming fixtures.

4. **Perf tests flake under full-suite load.** `merc-high-pitch-drag-perf`
   (p95 latency gate) can FAIL inside the full suite and PASS run in isolation —
   it is a load-induced flake, not a regression. Re-run isolated before treating
   a perf-gate failure as real. (`shader-dsl/loc.test.ts` is a separate
   pre-existing baseline failure on main.)

## Why This Matters
Declaring a render refactor "done" on DC=0 + a name-glob subset shipped a real
inline-path corruption (radius slot = Mercator-y). The full suite + a GPU-free
wiring test caught it after the fact.

## The Approach
For any shared-render-module change: (a) run the FULL `vitest run` before
"done", (b) treat any surviving failure as suspect until you diff it against
`main` (pre-existing?) or re-run isolated (load-flake?), (c) DC=0 the CHANGED
regime vs `main` (the authoritative correct render), not just vs the prior
commit, (d) hard-settle streaming fixtures.

## Example — DC=0 dance git-safety (this bit twice)
Run EVERY git op with `git -C <repo-root>` and guard the stash by name — a
`git stash push <paths>` executed from a subdir (e.g. `playground/`) matches no
pathspec, SILENTLY no-ops, and the later `git stash pop` then pops the WRONG
stash (a stale session-start stash) → leaked files + a UU conflict.
```bash
git -C /d/X-GIS stash push -m TAG -- <paths>
git -C /d/X-GIS stash list | head -1 | grep -q TAG || { echo ABORT; exit 1; }
# … capture BEFORE …
git -C /d/X-GIS stash pop stash@{0}   # by ref, only after the guard
```
Recovery if the wrong stash leaked: `git checkout HEAD -- <leaked files>` +
`rm` the moved copies; the mis-popped stash is preserved (pop kept it on
conflict). See session 2026-07-01 (#722 point-packing).
