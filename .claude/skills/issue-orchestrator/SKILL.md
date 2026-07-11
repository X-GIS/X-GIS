---
name: issue-orchestrator
description: Autonomously triage the open GitHub issue backlog and drive the top-N through fix → branch → full gate → PR → CI → merge, with adversarial verification and a final digest. Use when the user asks to "drain the backlog", "batch-fix issues", "resolve the top N issues", or run an autonomous issue-to-merge campaign on X-GIS.
---

# Issue-to-merge orchestrator (X-GIS)

Autonomous loop: open issues → triage → fix top-N → verified merge. Optimized for THIS repo's gates and constraints.

## Hard constraints (X-GIS reality — do not ignore)

- **Agent-tool delegation is BLOCKED here** (OMC hook forces a tmux/WSL swarm that isn't installed). Parallel `Agent` calls fail. Two legal ways to parallelize: the **Workflow tool** (no tmux; needs explicit opt-in) or **sequential in-session** fixes. Do NOT claim parallel fixers ran if they didn't.
- **`bun run build` is the typecheck authority** — vitest does NOT typecheck (CLAUDE.md §11). Watch for TS6133 orphaned-import that `vite build` silently passes.
- **Serialize heavy jobs** — never run vitest + `tsc`/`bun run build` + GPU verify concurrently; they freeze the machine (§7).
- **N-ahead worktree branches lie** — squash-merge leaves stale siblings that look unmerged. Verify redundancy via rebase patch-id skip / commit-title grep on origin/main before doing "new" work.
- Render/parity claims need §5 (directional pixel-diff + 16-split), never a downscaled eyeball.

## Loop

1. **Fetch + triage.** `gh issue list --state open --json number,title,labels`. Rank by difficulty & blast radius; pick top-N (default 5). Skip epics unless asked.
2. **Per issue (sequential, or a Workflow pipeline if opted in):**
   a. Reproduce / locate root cause first (codebase-memory graph FIRST, §6). Reject issues whose premise is already fixed on main (batch history is full of these).
   b. Branch off `origin/main` (`fix/<n>-slug`). Never work on `main`.
   c. Implement the minimal fix (§2 surgical, §3).
   d. Gate: `bun run build` → vitest (affected) → precheck → any render §5 check — **sequentially**.
   e. Open a **draft PR**; `Closes #<n>` in body.
3. **Adversarial self-review** (separate pass, never self-approve in the same lane): prove the fix real with prove-or-refute (witness / invariant), re-check the failing scenario fails-before / passes-after.
4. **CI:** `gh pr checks <pr> --watch`. Remediate failures. A dead branch-protection context (renamed leg) can BLOCK forever — reconcile if so.
5. **Merge** only when local gate AND CI are green: `gh pr merge --squash`. Re-verify mergeable after each merge (prior merges can conflict the next).
6. **Digest:** merged PRs, closed issues, remaining count, and anything deferred (say what was dropped — no silent caps).

## Verify before "done"

Files exist on disk, imports not orphaned, StructuredOutput actually called (if a Workflow ran), CI green, issues actually CLOSED (a PR referencing `#n` without `Closes` leaves it open — close explicitly with evidence).
