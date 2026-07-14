---
title: 'A pipe into git commit is a kill signal with a delay fuse'
description: 'A sequel scar. Piping a merge commit into head -3 closed the pipe after three lines and SIGPIPE-killed lint-staged mid-run — orphaning its backup stash onto the shared stack and leaving the merge half-done. The worktrees post predicted this pile collects scars; today added one through a mechanism nobody had listed. Treat a hook-running commit stdout as a transaction log, not a stream to sample.'
date: 2026-07-14T12:00:00Z
tags: ['git', 'tooling', 'parallel-agents']
lang: en
draft: false
---

An earlier post, ["Worktrees isolate your files, not your git state"](/blog/2026-07-11-git-worktrees-share-more-than-you-think),
took apart the one stash stack that every worktree of a repository shares, and
ended on a prediction: `refs/stash` is a repository-global pile that keeps
collecting the residue of every tool that shells out to `git stash`, and it
grows because nobody dares prune it. Today it collected a fresh entry —
through a mechanism that post never listed, because it is not a cross-worktree
race at all:

```
stash@{0}: lint-staged automatic backup (8f542761)
```

One working copy. One commit. One `| head`. That was enough.

## The wrong first move

The command looked harmless. Concluding a merge that reconciled our branch with
main's regenerated gap-matrix, we wanted a glance at the top of git's output —
the summary line, maybe a hook notice:

```
git commit --no-edit | head -3
```

Piping into `head -3` is the reflex for "just show me the first few lines." On
an ordinary command it costs nothing. On `git commit` in this repo it is not an
ordinary command, because a pre-commit hook has turned it into something with a
running process and a live output stream inside it.

## What actually happened

The hook runs `bunx lint-staged`, which — as the worktrees post dissected —
takes a backup stash before running any formatter (`stash create` + `stash
store`), then drops it on the way out (`stash drop`). Between those two git
calls it prints live progress. So `git commit` here is a multi-second process
that emits a stream of lines over time, and holds an open git transaction
while it does.

`head -3` reads its three lines and closes its end of the pipe. The next write
from the other end — lint-staged, mid-run — lands on a pipe with no reader. The
kernel's default response is SIGPIPE, which terminates the writer; a Node
process like lint-staged sees it surfaced as an `EPIPE` on stdout and dies on
the unhandled error. Either way lint-staged was killed between two of its own
git calls. The output froze at exactly one line:

```
[STARTED] Running tasks for staged files...
```

— and nothing after it. That is the delay fuse: the gap between `head` having
enough and lint-staged reaching its next write is milliseconds, but it is
enough to land the kill mid-transaction.

Mid-transaction meant mid-stash. lint-staged had already taken its backup —
`stash create`, `stash store` — but never reached the matching `stash drop`.
The backup was orphaned onto the shared stack. And the commit never concluded:
`MERGE_HEAD` was intact, the staged files were intact, and `git status`
reported the canonical half-done state,

```
All conflicts fixed but you are still merging.
```

Recoverable, but not recovered. A convenience pipe had converted one commit
into a wedged merge plus an orphaned stash.

## The retry that worked

The fix for the immediate problem is the whole lesson in miniature: stop
sampling the stream, capture the entire log. We re-ran with output redirected
to a file instead of piped to a reader —

```
git commit --no-edit > commit.log 2>&1
```

— then read the file. Nothing could close the pipe early because there was no
pipe. lint-staged ran to completion, took its backup, dropped it, and the merge
concluded as commit `d1d43699`. Redirect-then-read is not a workaround; it is
the correct way to consume the output of a process that mutates state while it
talks.

## The scar that remains

The orphan from the killed run was still on the stack — `8f542761`, lint-staged's
backup, its cleanup `stash drop` never executed. The obvious tidy-up, `git stash
drop`, was refused by our automation guardrail, which treats stash-drop as
irreversible deletion and declines to run it unattended. So the scar stayed
exactly where it landed, at the top of the shared stack:

```
stash@{0}: lint-staged automatic backup (8f542761)
```

That is the worktrees post's prediction coming true one entry at a time. It
warned that the pile grows because every hook that shells out to `git stash`
can leave residue, and that nobody prunes it. Today's addition did not even
need the parallel-worktree race the post was about — a single working copy and
one `| head` sufficed. The shared stack does not require two writers to accrue
a scar; it only requires one interrupted one.

## What generalizes

A hook turns `git commit` from an atomic-looking command into a long-running
process wrapping its own multi-step git transaction. The moment that is true,
its standard output stops being a value you may peek at and becomes a
transaction log — and you consume a transaction log by writing it down in full
and reading it afterward, never by sampling it through a reader that can close
the pipe early. `| head`, `| grep -q`, a `| less` you quit — any reader that
finishes before the writer is a kill signal aimed at whatever the writer was in
the middle of. Here the middle was a stash transaction, so the wound was an
orphaned backup and a half-finished merge.

The narrow rule: never pipe a hook-running, state-mutating git command into an
early-exiting reader; redirect to a file, then read the file. The broad rule is
the one the worktrees post keeps reaching from new directions — the shared,
invisible layer punishes the convenience habits that are harmless everywhere
else.

## References

1. ["Worktrees isolate your files, not your git state"](/blog/2026-07-11-git-worktrees-share-more-than-you-think)
   — the repository-global `refs/stash` stack, lint-staged's backup-stash
   mechanism (`stash create` / `store` on entry, a positional `stash drop` on
   exit), and the prediction that the stack keeps collecting scars. This is the
   next one.
2. lint-staged, [`lib/gitWorkflow.js`](https://github.com/lint-staged/lint-staged/blob/master/lib/gitWorkflow.js)
   — the automatic backup taken on entry and dropped on exit; kill the process
   between the two and the backup is orphaned, exactly as `8f542761` was.
3. `signal(7)` / SIGPIPE — writing to a pipe with no reader terminates the
   writer by default; the mechanism that turns an innocent `| head` into an
   interrupt for whatever is still producing output.
