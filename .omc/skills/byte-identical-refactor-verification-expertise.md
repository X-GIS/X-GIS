---
name: byte-identical-refactor-verification
description: A blind before/after pixel-diff cannot prove a byte-identical-by-construction refactor — use a runtime A/B kill-switch, not git-stash
triggers:
  - device-injection
  - DC=0 before after identical
  - ctx.rhi WebGpuDevice inject
  - __xgisVtrFillViaRhi __xgisLineViaRhi kill-switch
  - refactor pixel-diff verify
  - subagent git stash collision zombie
  - "verification did nothing" noop pixel diff
---

# Byte-Identical Refactor Verification (X-GIS §5)

## The Insight
When a refactor is **byte-identical by construction** — it swaps *which object owns* a GPU
call but the emitted command stream is provably unchanged (e.g. renderers stop self-making
`new WebGpuDevice(ctx.device)` and instead read the injected `ctx.rhi`, which wraps the *same*
`GPUDevice` via the same stateless forwarding wrapper) — a **blind before/after pixel-diff is
logically incapable of verifying it.** DC=0 is the *expected* result, so DC=0 is equally
consistent with "the change is correctly identical" AND "my verification harness did nothing"
(vite served the same bundle twice, HMR didn't recompile, the stash didn't take). A passing
DC=0 here carries *zero* information unless you independently guarantee the before-tree's old
code actually ran.

## Why This Matters
This is the exact blind spot the device-injection defect hid in for months: renderers wrapped
the same device, so every DC=0 gate passed while the engine was silently hard-bound to one
backend. CLAUDE.md §5 mandates rendered before/after — but applied naively to a same-output
refactor it produces a false-confidence green. You ship "verified" and it means nothing.

## Recognition Pattern
- The diff you expect is **DC=0** (not "DC>0, direction toward golden"). §5's normal gate
  (DC>0 proves *what* changed, D1<D0 proves *direction*) does not apply — there's nothing to
  move.
- The change touches *object identity / wiring*, not shader code, coordinates, or layout.
- You're about to `git stash` the whole change and re-render to get a "before."

## The Approach
1. **Prefer a runtime A/B kill-switch over git-stash.** This codebase ships per-seam toggles
   exactly for this: `globalThis.__xgisVtrFillViaRhi !== false` (fill), `__xgisLineViaRhi`
   (line). One served bundle, flag on vs off → a *true* raw-vs-RHI A/B with no rebuild
   ambiguity. If the seam you're verifying has such a flag, toggle it in-page (`page.evaluate`)
   and diff — DC=0 then genuinely means identical. If it lacks one and the change is
   seam-shaped, **add the kill-switch as part of the change** so it's verifiable (and so the
   raw fallback can later be deleted with a proven A/B).
2. **If you must git-stash, the before-tree must be genuinely *served*.** HMR or a warm vite
   can serve the post-change bundle for both captures → false DC=0. Required: `git stash push
   runtime/src`, **kill vite (find PID via `netstat -ano | grep :3000`), `rm -rf
   playground/.vite`, restart vite fresh**, capture before, `git stash pop`. Confirm the
   stash took with a grep (`grep -c "new WebGpuDevice" the-edited-file` → expected before-count)
   BEFORE trusting the capture. `.vite` caches *pre-bundled deps* not first-party `runtime/src`,
   but a live HMR server is the real trap — restart, don't rely on HMR.
3. **Always confirm non-blank.** DC=0 of two blank frames is also 0. Programmatically count
   distinct colors / non-bg pixels on the "after" capture, and read one frame, before trusting
   any DC=0.
4. **Back DC=0 with the behavioral surface that the change actually moves.** For a
   construction/wiring refactor that's tsc-0 + the unit/wiring suites (they assert the renderer
   constructs and draws correctly with the injected handle) + a render-error-free smoke. Those
   carry the information the pixel-diff cannot.

## Companion gotcha — long-lived subagent vs main-thread git-stash
If a subagent is still alive (FleetView shows it; `TaskGet` returning "Task not found" does
**not** mean dead) while the main thread runs stash-based verification, the two fight over
`git stash` — the subagent loops on `git stash show`/`pop` and burns tokens (observed: 47 min /
403k tokens). After a subagent's edits are on disk and you've verified them, **`TaskStop` it
explicitly**; never assume it died. And never run stash-based before/after while a writer
subagent on the same repo is live.
