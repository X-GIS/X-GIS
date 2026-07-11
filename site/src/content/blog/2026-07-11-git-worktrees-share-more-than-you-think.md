---
title: 'Worktrees isolate your files, not your git state'
description: 'Six agents committed in parallel from six worktrees of one repo — and every pre-commit hook stashed into the single stack they all share, finding its entry by list index. What worktrees actually share, plus the orphaned-stash scar that proves the race.'
date: '2026-07-11T16:00:00Z'
tags: ['git', 'parallel-agents', 'tooling']
lang: en
draft: false
---

At the end of a session in which six coding agents worked one repository in
parallel from six git worktrees, `git stash list` held sixteen entries. None
were created that day — the pile is leftovers from past sessions: parked WIP,
snapshots, entries literally labeled "noise." The newest one is a scar from a
session that was less lucky than this one:

```
stash@{0}: RECOVER feat/923 override-spec-constants (orphaned into 535-4 by shared-stash race; backup patch in 535-4 scratchpad/orphan-535-2-shaderdsl.patch)
```

"Orphaned … by shared-stash race." A past session lost in-flight work into a
stash entry that a _different_ working copy's automation collided with, and had
to recover it from a backup patch. That label is the whole post in one string:
the stash is not per-worktree. It never was.

## The wrong first move

The setup looks like isolation. `git worktree add` gives every agent its own
directory, its own checked-out branch, its own build artifacts:

```
D:/X-GIS           7e3028d4  [main]
D:/X-GIS-wt/a-834  bff435a8  [claude/webgl2-fullframe-834]
D:/X-GIS-wt/b-798  fe772aaf  [claude/body-authority-798]
D:/X-GIS-wt/c-777  972ee146  [claude/icon-sprite-777]
D:/X-GIS-wt/d-799  d82acf8e  [claude/globe-lowzoom-799]
D:/X-GIS-wt/e-802  3a3f37e3  [claude/oblique-tearing-802]
D:/X-GIS-wt/f-797  b12c8bc8  [claude/drawing-api-797]
```

What it does not give you is six repositories. Every directory above shares
the one `.git` under `D:/X-GIS`: one object store, one set of branches and
tags, one remote, one config (including `core.hooksPath`, so every worktree
runs the same hooks), and — the sharp edge — one stash. The per-worktree state
is a short list: `HEAD`, the index, the working tree, and in-progress
operation state like a merge or rebase. Everything else is repository-global.

Git itself tells you which shared surface it considers dangerous: try to check
out a branch that another worktree already has checked out and git refuses,
because two working trees mutating one branch tip would corrupt each other's
view of the world. The stash is exactly as shared as a branch — `refs/stash`
is a single ref whose reflog is the stack — and it got no fence at all. `git
stash push` in worktree A and `git stash pop` in worktree B operate on the
same stack, silently.

So the wrong first move is the mental model: "six worktrees, so the agents
can't step on each other's git." They can — through every ref. And although no
agent in this session ever typed `git stash`, stashing happened anyway, on
every commit.

## Every commit stashes, whether you do or not

The repository's pre-commit hook is two lines:

```sh
# Lint + format only the STAGED files (existing tree is not retro-flagged).
bunx lint-staged
```

lint-staged's safety story is the reason it is trustworthy on a laptop: before
running formatters over your staged files, it backs up the original state so a
crashed linter can't destroy your work. The backup mechanism, verbatim from
the installed lint-staged 15.5.2 (`lib/gitWorkflow.js`):

```js
// Save stash of all staged files.
// The `stash create` command creates a dangling commit without removing any files,
// and `stash store` saves it as an actual stash.
const stashHash = await this.execGit(['stash', 'create'])
ctx.backupHash = await this.execGit(['rev-parse', '--short', stashHash])
```

The dangling commit is then `stash store`d with the message
`` `${STASH} (${ctx.backupHash})` `` — `STASH` being the constant
`'lint-staged automatic backup'`. The cleanup path is where the race lives:

```js
async getBackupStash(ctx) {
  const stashes = await this.execGit(['stash', 'list'])

  const index = stashes
    .split('\n')
    .findIndex((line) => line.includes(STASH) && line.includes(ctx.backupHash))

  if (index === -1) {
    ctx.errors.add(GetBackupStashError)
    throw new Error('lint-staged automatic backup is missing!')
  }

  return String(index)
}
```

The message match is sound — it includes the backup's unique short hash. The
return value is the problem: a _position_ in the shared stack, consumed by
`git stash drop --quiet <index>` (and, on rollback, `git stash apply --index`)
as a separate git invocation. A position is only meaningful while the stack
doesn't move, and with parallel committers the stack moves whenever anyone
else's hook fires. Another worktree's backup pushed between your `stash list`
and your `stash drop` shifts every index by one; your drop then deletes
someone else's entry, and their cleanup dies with the error in the snippet
above — `lint-staged automatic backup is missing!` — or, worse, their rollback
restores yours.

:::warning
`refs/stash` is repository-global. Any tool that shells out to `git stash` —
lint-staged does, by design, on every commit — becomes a cross-worktree race
the moment more than one working copy runs it concurrently.
:::

This session, that race **did not fire** — worth saying plainly, because the
scar at `stash@{0}` shows it has fired in this repository before. At least
three of the session's commits ran the hook, and each recorded backup was
created and dropped cleanly inside it: `e5dd28b5` (the icon-converter task),
`2a50ff05` (the draw-call-gate task), `ea3371da` (the globe-fix follow-up). A review pass
later confirmed it: `e5dd28b5` still exists as a dangling stash-structure
commit on the base revision, and the stash list ended the session at "16
pre-existing entries, none new." Nothing serialized those commits; so far as
the stash list can testify, they simply never collided.

## The workarounds have their own teeth

One agent decided the race was unacceptable and routed around the hook. Its PR
carries the caveat verbatim:

> Commit uses `--no-verify`: the `lint-staged` pre-commit hook uses an
> internal `git stash`, forbidden in this parallel-worktree batch. Changed
> lines are independently prettier- + eslint-clean; […]

It ran the tools by hand and asserted the result. The review pass re-ran them
and found the assertion _almost_ true: the committed bytes were prettier-clean
(an on-disk `--check` failure turned out to be a Windows CRLF checkout
artifact), the two nearby ESLint errors were pre-existing exactly as claimed —
and the new test file carried two unused `eslint-disable` directives that no
machine had ever flagged (`no-console` is not enabled in that config, so the
disables report as unused-directive warnings). The reviewer's summary is the
cost of the bypass in one sentence: "Because the commit used --no-verify and
no CI lint leg exists, no machine check ever validated the lint-clean
assertion." Skipping the hook converts a machine guarantee into a hand-written
claim, and the hand-written claim shipped wrong in a small way.

The same batch ran the opposite policy simultaneously. Another agent's
instructions forbade `--no-verify`, so its commit went through the hook —
which dutifully re-staged a pre-existing formatting drift (a multi-line
function signature reflowed to one line, whitespace only) into an otherwise
surgical diff. And the first agent itself wavered: its follow-up commit on the
same branch ran the hook after all (that was `ea3371da`). One hazard, opposite
prohibitions in force at the same time — which is what "we never actually
decided" looks like in practice.

The subtlest tax fell on fail-before proofs. The natural idiom for "show the
test goes red without the fix" is stash-based: stash the fix, run the test
red, pop. With the stash off-limits, the session used two substitutes, and
both bit:

- Run the new gate against the base commit instead. That produced a genuine
  red run — `centerLatDeg=-3.1774` reported for all three cases against
  required latitudes of 15.12559 / 55.64329 / 48.42584 — but fix and gate then
  shipped in one commit, so, as the verification review put it, "there is no
  commit-order proof that the gate fails on unmodified main." The red run was
  accepted on arithmetic instead: the documented deltas 18.303 / 58.821 /
  51.603 are exactly $|{-3.1774} - \text{lat}|$ for the three latitudes.
- Break the code deliberately (uncommitted), watch the gate fail — it did,
  loudly: `Expected <= 16, Received 100000` draw calls — then revert the break
  with `git checkout -- <file>`. That checkout also wiped an uncommitted
  legitimate change sitting in the same file, which had to be re-applied and
  re-verified. A stash round-trip would have preserved it; the blunt
  substitute ate it.

## What generalizes

A git worktree isolates the three things you can see — `HEAD`, the index, the
working tree — and nothing you can't. Everything else is one namespace, and
the only cross-worktree interference git actively fences is the
double-checkout of a branch. That honor system is fine at one human and
combinatorial at N agents: worktrees were designed so one developer could have
two checkouts, not so six autonomous writers could treat one repository as
six.

The transferable rule sits one level above git: file isolation is not state
isolation. A tool that looks pure from its command line — a formatter hook, a
"back up before running" convenience — may reach through the shared layer as
an implementation detail, and it becomes a race exactly when you parallelize.
The real options: lint-staged's documented `--no-stash` (trading away
rollback-on-error); full clones, buying isolation with disk and fetch time; or
serializing commits across agents. Any of these is a decision. What this
repository had instead was a sixteen-entry stash pile, a recovery note at
`stash@{0}`, and opposite hook policies in the same batch — the residue of
never deciding.

The same session hit the same shape one layer up the stack — six worktrees
silently sharing one dev-server port — in
["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu).

## References

1. Git, ["git-worktree" documentation](https://git-scm.com/docs/git-worktree)
   — the authoritative split of per-worktree state (`HEAD`, index, working
   tree, bisect state) versus shared state (everything else, including all
   refs), and the branch double-checkout refusal.
2. lint-staged, [`lib/gitWorkflow.js`](https://github.com/lint-staged/lint-staged/blob/master/lib/gitWorkflow.js)
   — the automatic backup stash: `stash create` + `stash store` on entry, a
   positional `stash drop` on exit; the `--no-stash` flag disables it.
3. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu)
   — the same session's other shared-namespace hazard: output assertions
   satisfied by the wrong provenance.
