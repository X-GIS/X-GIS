---
name: squash-merge-branch-cleanup
description: This repo squash-merges every PR, so `git branch --no-merged` and 2-dot `git diff main <branch>` both lie about what's already shipped — classify by ancestry-merged OR merged-PR head list instead
triggers:
  - clean up branches
  - delete merged branches
  - branch cleanup
  - git branch --no-merged wrong
  - is this branch merged
  - stale branches
---

# Squash-merge-aware branch cleanup

## The Insight
This repo squash-merges every PR (PR titles end with `(#NNN)`, single commit on main).
Squash creates a NEW commit on main whose changes equal the branch, but the branch's
own commits are NOT ancestors of main. Consequences when deciding "is this branch safe
to delete":
- `git branch --no-merged main` lists squash-merged branches as "not merged" — FALSE
  positive for unmerged work. Their content IS shipped.
- `git diff main <branch>` (two-dot) is even worse: it shows the symmetric tip diff,
  which is dominated by the ~1000 files **main gained since the branch forked**, so
  every old branch looks like it has huge "unique" content. Useless for this question.

## Why This Matters
Bulk-deleting "unmerged" branches based on `--no-merged` would either (a) refuse to
delete safe shipped branches, or (b) if you trust a bad diff, delete branches that
actually hold the only copy of unmerged WIP. Branch deletion of local-only branches is
irreversible (no remote backup).

## Recognition Pattern
- Asked to "clean up / delete unnecessary branches".
- `git branch --no-merged` returns almost everything (because squash).
- Branch last-commit dates are old but the work shipped via a renamed/squashed PR.

## The Approach
Classify each branch with TWO reliable signals, delete only on a positive:
1. **Ancestry-merged**: `git branch --merged main` / `git branch -r --merged origin/main`
   — definitive (commits are in main).
2. **Merged-PR head**: `gh pr list --state merged --limit 400 --json headRefName` — a
   branch whose PR is in this set shipped via squash even if ancestry says otherwise.
   (Note: `gh pr list --state closed` INCLUDES merged PRs — don't use it to find
   "closed-not-merged"; subtract the merged set.)

Then bucket the remainder (no ancestry, no merged-PR) by intent, and DO NOT bulk-delete:
- asset/diagnostic/experiment branches (`pr-assets-*`, `*-evidence`, `experiment/*`) and
  user-closed-PR branches → safe to drop.
- `feat/*` with unique unmerged code → surface to the user; deleting destroys the only
  copy. Preserve unless explicitly told otherwise.

## Example
```bash
gh pr list --state merged --limit 400 --json headRefName --jq '.[].headRefName' | sort -u > /tmp/merged.txt
# per branch: in /tmp/merged.txt OR `git branch --merged` → safe; else judge by name/intent
```
