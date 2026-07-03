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

When a refactor is **byte-identical by construction** — it swaps _which object owns_ a GPU
call but the emitted command stream is provably unchanged (e.g. renderers stop self-making
`new WebGpuDevice(ctx.device)` and instead read the injected `ctx.rhi`, which wraps the _same_
`GPUDevice` via the same stateless forwarding wrapper) — a **blind before/after pixel-diff is
logically incapable of verifying it.** DC=0 is the _expected_ result, so DC=0 is equally
consistent with "the change is correctly identical" AND "my verification harness did nothing"
(vite served the same bundle twice, HMR didn't recompile, the stash didn't take). A passing
DC=0 here carries _zero_ information unless you independently guarantee the before-tree's old
code actually ran.

## Why This Matters

This is the exact blind spot the device-injection defect hid in for months: renderers wrapped
the same device, so every DC=0 gate passed while the engine was silently hard-bound to one
backend. CLAUDE.md §5 mandates rendered before/after — but applied naively to a same-output
refactor it produces a false-confidence green. You ship "verified" and it means nothing.

## Recognition Pattern

- The diff you expect is **DC=0** (not "DC>0, direction toward golden"). §5's normal gate
  (DC>0 proves _what_ changed, D1<D0 proves _direction_) does not apply — there's nothing to
  move.
- The change touches _object identity / wiring_, not shader code, coordinates, or layout.
- You're about to `git stash` the whole change and re-render to get a "before."

## The Approach

1. **Prefer a runtime A/B kill-switch over git-stash.** During a flip this codebase shipped
   per-seam toggles exactly for this (e.g. the former `__xgisVtrFillViaRhi` / `__xgisLineViaRhi`
   — a global read like `globalThis.__xgisVtrFillViaRhi !== false`): one served bundle, flag on
   vs off → a _true_ raw-vs-RHI A/B with no rebuild ambiguity. That is the toggle's whole
   lifecycle: **add it as part of a seam-shaped change → use it to prove the new path is DC=0 to
   raw → then DELETE it together with the raw fallback once proven** (both fill + line toggles
   are now gone, the seams fail-closed). So if the seam you're verifying still has such a flag,
   toggle it in-page (`page.evaluate`) and diff — DC=0 then genuinely means identical; if it
   doesn't, add one, prove DC=0, and remove it with the raw path.
2. **If you must git-stash, the before-tree must be genuinely _served_.** HMR or a warm vite
   can serve the post-change bundle for both captures → false DC=0. Required: `git stash push
runtime/src`, **kill vite (find PID via `netstat -ano | grep :3000`), `rm -rf
playground/.vite`, restart vite fresh**, capture before, `git stash pop`. Confirm the
   stash took with a grep (`grep -c "new WebGpuDevice" the-edited-file` → expected before-count)
   BEFORE trusting the capture. `.vite` caches _pre-bundled deps_ not first-party `runtime/src`,
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
