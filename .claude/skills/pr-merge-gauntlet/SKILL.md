---
name: pr-merge-gauntlet
description: Merge a verified draft PR into main through THIS repo's full gauntlet — undraft, local main-merge with the ratchet-conflict playbook, the sequential gate ladder (tsc → vitest → §5 render gates with image reads), squash-merge, and issue bookkeeping. Use when asked to "merge the PR(s)", "land the branch", run a merge campaign, or resolve a 405 merge-conflict on a PR. Codified from the 2026-07-20 26-PR campaign.
---

# PR merge gauntlet (X-GIS)

The repo's merge procedure as actually practiced. Local gates + SwiftShader render
verification are the merge authority — do NOT wait on CI (failures arrive via webhooks
and are handled as events). One PR at a time; each merge advances main and re-conflicts
the next PR, so re-run the gauntlet per PR, never batch-resolve.

## Per-PR sequence

1. **Undraft** (`update_pull_request draft:false`) — draft PRs cannot merge.
2. **Try the merge** (`merge_pull_request`, squash). A 405 "merge conflicts" answer means
   local resolution:
3. **Local resolve**: `git fetch origin main && git checkout <branch> && git merge origin/main`,
   then the conflict playbook below, then commit `--no-edit` and `git push -u origin <branch>`.
4. **Gates — sequentially, never two heavy jobs at once (§7)**:
   a. `bunx tsc --build <dep-ordered pkgs>` — see the two tsc traps below.
   b. `bunx vitest run` over: BOTH ratchet authorities + every suite the diff touches;
   after a semantic merge in a shared file, the FULL package suite.
   c. §5 render gates for anything render-touching: run the branch's e2e gate(s) on the
   MERGED tree and READ the produced image at full resolution — a pixel-count
   threshold alone is a tripwire, not a verdict (see §12: structure-blind gates).
5. **Squash-merge**, then bookkeeping: confirm the linked issue actually closed
   (`Closes #n` only; a bare `#n` reference leaves it open — close explicitly with
   evidence), post the epic/tracker status comment if the PR was an increment.
6. **Local hygiene**: `git checkout main && git pull`, delete the merged local branch,
   `git worktree prune` if worktrees were used.

## Conflict playbook (the recurring cases)

- **`map/src/loc-ceiling-ratchet.test.ts` (almost every PR)**: never pick a side and never
  `max()` the two ceilings — stacked non-overlapping edits SUM. Union the comment blocks
  (main's side first, then the branch's, re-labelled "merge union"), then set the ceiling
  to the merged file's ACTUAL `wc -l`. Watch for the auto-merge leaving DUPLICATE keys for
  one file (later key silently wins in a JS object literal) — consolidate to one entry.
- **Second authority (§12)**: `line.ts`/`polygon.ts`-class files are ALSO ceiling-gated in
  `runtime/src/engine/architecture-invariants.test.ts` — union BOTH files in the same commit.
- **`backend-identity-ratchet.test.ts`**: BASELINE is additive across sides — union the
  history comments and set BASELINE to the sum of both sides' deltas over the common
  ancestor, then let the test's own breakdown output confirm the measured count.
- **`pass-order.ts` / `pass-order-parity.test.ts`**: RHI_TWIN_MISSING is shrink-only and
  the parity MARKERS list must mirror PASS_CHAIN_ORDER order — union = keep every side's
  ported-pass removal AND every new pass's marker, in chain order.
- **Interface/descriptor files (rhi.ts etc.)**: conflicts are usually additive field
  unions (keep both fields, both doc comments); afterwards grep consumers for the union
  actually compiling (`tsc --build` the dependents).

## The two tsc traps (both bit us on 2026-07-20)

- **Stale `.tsbuildinfo`**: after branch churn, `tsc --build` can replay a CACHED error
  (e.g. TS2307 for a module that exists). `--force` the reporting package BEFORE
  diagnosing a phantom error.
- **Stale dist / masked deps**: packages whose exports point at `dist` (runtime) serve
  old types until rebuilt — build dep-ordered (`rhi → rhi-webgl2/webgpu → engine → map →
runtime → playground`). A "cannot find module" that survives `--force` means a missing
  `package.json` dependency masked by a tsconfig `paths` mapping in the package's own
  build (fix the dep declaration, not the paths).
- Never launder exit codes: no `tsc | head` / `| tail` — redirect to a file, `echo $?`,
  then read the file (§12).

## Stacked PRs

`base` may be another feature branch, not main (check `base.ref` before assuming) — a
stacked PR squash lands on ITS BASE branch; the content reaches main only with the base
PR's merge. After merging a stack parent, re-fetch the child before touching it.

## After agent-assisted work

Verify `git branch --show-current` and `git log --oneline -1` before building on a tree
an agent touched — subagents have left the repo on a different branch (§12).
