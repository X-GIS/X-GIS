---
title: 'Sharing a branch with an agent that commits while you are offline'
description: "A refactor step I left uncommitted on one machine had already been authored and pushed to the shared branch by an autonomous agent, under a different SHA. Why 'is it done?' on an agent-shared branch is a distributed-consensus question — and why, before redoing anything, you fetch and read the agent's commits first."
date: 2026-07-08
tags: ['git', 'ci', 'agents', 'workflow', 'ops']
lang: en
---

On the new machine `git status` came up clean — and the last refactor step I'd
left uncommitted on the old one, S6, was simply _gone_. It wasn't lost: the
autonomous agent sharing the branch had already authored and pushed it as
`819d608`, under `Claude <noreply@anthropic.com>`, while I was offline.

Some of the messiest engineering time isn't spent on code — it's spent proving
that the code you have is the code you think you have. That has always been true.
What's new is _who else is committing to your branch._ On this repo a branch
named `claude/…` is not yours alone: an autonomous agent — a Claude session
running on a CI machine — authors and **pushes** commits to it while you are
offline. So "is this step done?" stops being a fact you can read off your own
working tree and becomes a small distributed-consensus problem across you, the
agent, and origin. Here is the snarl that showed me the mental model _my branch,
my work_ is now structurally wrong — and the one habit that actually fixes it.

## The setup

The last step of a multi-part refactor (S6: replacing the forced-WebGL2 boot's
no-op device Proxy with a fail-loud stub) was written and _building_ on my dev
machine, but **not yet committed**. The source edit existed in the working tree;
no commit had captured it. Then the session moved to a different machine — and
working-tree changes don't travel with a branch, only commits do. On the new
machine `git status` was clean and the S6 edit was simply _gone_.

The reflexive read is "I lost my work." But this branch had a second author.
While my edit sat uncommitted, the agent working the same branch had already
authored and pushed the equivalent S6 — not a near-duplicate, the _same step in
the same sequence_, `S4 → S5 → S6`, every commit by `Claude
<noreply@anthropic.com>`. So the true state was three disagreeing answers to one
question:

- **My machine:** S6 written, uncommitted, then gone on the switch.
- **Me, from memory:** "I still need to do S6."
- **origin:** S6 _already landed_ as `819d608`, authored by the agent — with S4
  and S5 pushed ahead of it.

With a human collaborator you'd expect a heads-up: a PR, a message, _something_.
The agent just committed and pushed. Nothing pinged me. The only record that the
work was done lived in `git log`, under an author that wasn't me.

## The wrong reflex

The reflex when work "disappears" is to redo it: re-apply the edit, rebuild,
commit. I started down that road — re-make the S6 change, about to commit. It
builds. And that is exactly the trap, because origin _already had_ S6.
Committing my freshly-redone version would have produced a **second** S6 — a
literal duplicate, or worse a subtly different implementation of the same step —
forking the history into "S6 as the agent wrote it" and "S6 as I redid it." Now
a reviewer has two S6s to reconcile. Redoing lost work _before checking whether
it's actually lost_ manufactures divergence — and an agent-shared branch
manufactures it faster, because the agent commits in parallel with you, not
waiting its turn.

## The reconciliation

The correct first move when local and remote disagree is not to write — it's to
_look at origin_, and specifically at what the **other author** did:

```bash
git fetch origin
git log --oneline --author=Claude origin/claude/gpu-webgl2-container-ovacvb | head -3
# 819d608  refactor(webgl2): #834 device-retirement S6 — fail-loud device stub …
# 5dffce3  refactor(webgl2): #834 device-retirement S5 — fence scene-compile …
# f12ed49  refactor(webgl2): #834 device-retirement S4 — inert sentinel …
```

There it is. S6 is already on the branch, authored by the agent. My redone copy
is not "the lost work recovered" — it's a _duplicate of work that already
landed_. So the right action is to throw away my local divergence and adopt
origin's truth:

```bash
git reset --hard origin/claude/gpu-webgl2-container-ovacvb
```

`--hard` because my redone S6 was redundant with `819d608`, so discarding it was
correct, not lossy. After the reset all three views agreed: S6 is one commit,
`819d608`, and my tree matched it byte-for-byte. A `bun install` + rebuild made
the local artifacts consistent with the reset source, and the state was finally
coherent.

## The habit that actually fixes it

One rule does the real work on an agent-shared branch:

**Before redoing anything an agent might have touched, `git fetch` and read the
_agent's_ commits specifically** — `git log --author` for the account that
shares your branch, not just `git log`. The author who did the work while you
were away is precisely the author you are least likely to check, because your
mental model still says you're the only one writing here. Thirty seconds of
`git log --author=Claude origin/…` would have skipped the rebuild, the redo, and
the divergence cleanup entirely.

The table-stakes git hygiene still applies, but for this audience it's one line
each: **commit before any context boundary** — a machine switch or a handoff; an
uncommitted edit is saved-_looking_, not saved — and **fetch before you redo**,
because work you think you lost may have landed under someone else's name.

The general principle, updated for the world we're actually in: origin — not
your working tree, not your memory — is the source of truth for "is it done,"
_and_ on a branch you share with an autonomous agent it's the source of truth
for "did **I** even do it." The agent authors real commits; "my branch, my work"
was a safe approximation with human-only collaborators and is now simply false.
When local and origin disagree, fetch, read the _other author's_ log, and
reconcile toward the shared history. `reset --hard` toward origin is a scalpel
once you've confirmed your divergence is redundant, a footgun before. The
checking — of the author you forget to check — is the whole job.
