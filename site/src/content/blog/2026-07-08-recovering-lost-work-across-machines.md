---
title: 'When two machines both think they finished the same commit'
description: "Uncommitted work vanished on a machine switch, a Linux CI runner had already committed the same change under a different SHA, and a rebuild plus a hard reset had to reconcile them without losing either. An ops post-mortem on branch hygiene across machines."
date: 2026-07-08
tags: ['git', 'ci', 'workflow', 'ops']
lang: en
---

Some of the messiest engineering time isn't spent on code — it's spent proving
that the code you have is the code you think you have. This is a small
post-mortem on a state-reconciliation snarl that cost real minutes during the
device-retirement work, and the habits that dig you out.

## The setup

The last step of a multi-part refactor (call it S6: replacing the forcegl2
no-op device Proxy with a fail-loud stub) was written and *building* on a Windows
dev machine, but **not yet committed**. The build artifacts (`dist/`) existed;
the source edit existed in the working tree; no commit had captured it.

Then the session moved to a different machine. Working-tree changes don't travel
with a branch — only commits do. On the new machine, `git status` was clean and
the S6 edit was simply *gone*: never committed, so never pushed, so not present
where the branch was checked out. The build there didn't have the fail-loud stub.

Meanwhile — and this is what turned a simple "redo the edit" into a reconciliation
— a Linux CI runner working the same branch had **already committed** an
equivalent S6 change, as SHA `819d608d`, and pushed it. So the true state was:

- Machine A (Windows): source edit made, uncommitted, then abandoned on switch.
- Machine B (new): branch clean, no S6 edit locally.
- origin: S6 *already landed* as `819d608d` from the CI runner.

Three views of "is S6 done?" and all three disagreed.

## The wrong reflex

The reflex when your work "disappears" is to redo it immediately: re-apply the
edit, rebuild, commit. I started down that road — `bun install`, rebuild `dist/`,
re-make the S6 source change. It builds. About to commit.

That reflex is a trap here, because origin *already had* S6. Committing my
freshly-redone S6 on top of the branch would have produced a **second** commit
doing the same thing — either a literal duplicate or, worse, a subtly different
implementation of the same change, forking the history into "S6 as CI wrote it"
and "S6 as I redid it." Now a reviewer has two S6s to reconcile and the branch
has a redundant or conflicting commit. Redoing lost work *before checking whether
it's actually lost* manufactures divergence.

## The reconciliation

The correct first move when local and remote disagree is not to write — it's to
*look at origin*:

```bash
git fetch origin
git log --oneline origin/claude/gpu-webgl2-container-ovacvb | head
# → 819d608d  refactor(webgpu): S6 fail-loud stub for forcegl2 device
```

There it is. S6 is already on the branch, authored by the CI runner. My redone
copy is not "the lost work recovered" — it's a *duplicate of work that already
landed*. So the right action is to throw away my local divergence and adopt
origin's truth:

```bash
git reset --hard origin/claude/gpu-webgl2-container-ovacvb
```

`--hard` because I specifically wanted the working tree to match origin exactly —
my redone S6 was redundant with `819d608d`, so discarding it was correct, not
lossy. (On Windows this needed the sandbox override to run, a small friction
worth noting: destructive git operations sometimes trip permission guards and
have to be explicitly allowed.) After the reset, all three views agreed: S6 = one
commit, `819d608d`, and my machine matched it byte-for-byte. Then `bun install` +
rebuild `dist/` to make the local build artifacts consistent with the reset
source, and the state was finally coherent.

## What actually went wrong, and the habits that fix it

The root cause was mundane: **work sat in a working tree instead of a commit
across a context boundary** (the machine switch). Working trees are per-machine
and ephemeral; the only thing that survives a switch is a pushed commit. Two
habits would have prevented the whole snarl:

- **Commit before any boundary.** Before switching machines, before a long pause,
  before handing off to a runner — commit (even a WIP commit you later squash).
  An uncommitted edit is not saved work; it's saved-*looking* work, and the
  distinction bites exactly when you cross to a context that can't see your
  working tree.

- **`git fetch` and read the log before redoing anything.** When work seems lost,
  the first question is not "how do I recreate it" but "did it land somewhere I'm
  not looking?" A branch worked by both a human and a CI runner has two authors;
  either might have committed the thing you think you lost. Thirty seconds of
  `git log origin/...` beats ten minutes of redoing plus the divergence cleanup
  that follows.

The general principle: **treat origin as the source of truth for "is it done,"
not your local working tree or your memory of having written it.** Local state
lies in both directions — it can be missing work that landed remotely, and it can
be holding work that never left. When they disagree, fetch, read the log, and
reconcile *toward* the shared history rather than piling your local guess on top
of it. `reset --hard` toward origin is a scalpel when you've confirmed your local
divergence is redundant; it's a footgun when you haven't checked. The checking is
the whole job.
