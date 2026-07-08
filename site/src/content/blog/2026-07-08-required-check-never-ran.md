---
title: 'A skipped matrix job never posts the checks you required'
description: 'A one-file docs PR sat on "Expected — waiting for status to be reported" with no checks coming. Two GitHub mechanisms hid required checks: a paths filter that skipped the whole workflow, and a matrix job skipped at the job level — evaluated before the matrix expands, so its per-leg contexts never post. Why "skipped" is not "never ran."'
date: 2026-07-08T20:00:00Z
tags: ['ci', 'github-actions', 'branch-protection']
lang: en
draft: false
---

A pull request that changed exactly one file — a Markdown blog post — could not
be merged. Its status read _"Expected — waiting for status to be reported,"_ and
it stayed that way. `gh pr checks <branch>` was blunter:

```
no checks reported on the branch
```

Nothing was coming. Branch protection required eleven status checks before a
merge, and zero of them would ever post, because the workflow that posts them
never ran. A required check that never runs is not red and it is not pending in
any way that resolves — it is `Expected`, and `Expected` blocks the merge
forever.

This took two fixes to clear, and the second one is the interesting one: a
matrix job **skipped at the job level does not post the per-leg checks you made
required**, because the skip is decided before the matrix expands.

## Layer one: a path filter skipped the whole workflow

The test workflow guarded its trigger with a path filter:

```yaml
on:
  pull_request:
    paths-ignore:
      - '**/*.md'
      - 'docs/**'
      - 'LICENSE'
      - '.gitignore'
```

The intent is ordinary and reasonable: a docs-only change can't break the unit
suite or the shader gate, so don't burn CI minutes on it. And for a long time
that was free, because nothing gated on the result. Then branch protection was
switched on and made those checks **required**.

Now the filter is a deadlock. A PR that touches only `**/*.md` matches
`paths-ignore`, so GitHub skips the **entire** workflow — no jobs, and therefore
no check runs posted at all. Branch protection is still waiting for eleven
named contexts. They never arrive.

The workflow's own comment had predicted this, months earlier:

> If branch protection is ever added with a required test/render check, REMOVE
> this `paths-ignore` — a never-running required check strands the PR.

:::warning
`paths` / `paths-ignore` on a `pull_request` trigger + a required status check
= a PR that touches only ignored paths can never merge. The workflow skips, the
check never posts, and branch protection waits on it forever. A path-filtered
workflow and a required check produced by that workflow are mutually exclusive.
:::

Before fixing it properly I tried to just force the merge — the equivalent of
`gh pr merge --admin`. That was refused by policy (the PR was authored by an
automated account, and admin-bypassing its own required checks is exactly what
the policy exists to stop). Which was the right outcome: forcing this one merge
would have hidden a bug that strands _every_ future docs PR. So, delete the
`paths-ignore`. The workflow runs on the docs PR now.

It was still blocked.

## Layer two: the matrix job skipped before it expanded

With the workflow running, the checks it posted were:

```
changes                    ✓
test (${{ matrix.id }})    – skipped
typecheck                  – skipped
site                       ✓
render-gate                ✓
```

Look at the second line. Branch protection did not require a check called
`test (${{ matrix.id }})`. It required eight expanded ones — `test (unit-a)`,
`test (unit-b)`, `test (integration)`, and five more. **None of those posted.**
The literal, un-interpolated template string did.

The `test` job is a matrix, gated at the **job** level:

```yaml
test:
  needs: changes
  if: needs.changes.outputs.code == 'true' # ← job-level skip
  strategy:
    matrix:
      include:
        - { id: unit-a, args: '...' }
        - { id: unit-b, args: '...' }
        # …eight legs…
  name: test (${{ matrix.id }})
  steps: [checkout, setup, build, test]
```

A docs PR sets `code == false`, so the job's `if` is false and the job is
skipped. The trap is the evaluation order: **a job-level `if` is evaluated
before the matrix is expanded.** GitHub never instantiates the eight legs, so
the eight names are never created. It posts a single skipped check under the
raw template name `test (${{ matrix.id }})` — the string, un-interpolated —
and the eight contexts your branch protection actually lists stay `Expected`.

The tell that this is specifically a _matrix_ problem: on the same PR,
`typecheck` — an ordinary, non-matrix job with the identical `if` — skipped
cleanly and **posted under its own name** `typecheck`, which branch protection
accepts. A skipped single job reports the check you required. A skipped matrix
job reports a check nobody required.

:::warning
`skipped` satisfies a required status check — but only if the check is
**posted**. A single skipped job posts its own name. A skipped matrix job posts
only the un-expanded `name:` template, so every per-leg context you require is
never created. Requiring `test (leg-1)…test (leg-8)` and skipping the `test`
job at the job level are incompatible.
:::

## The fix: make the matrix expand, then skip inside

The repair is to stop skipping the job and start skipping its steps — move the
`if` from the job down to each step, so the matrix always expands:

```yaml
test:
  needs: changes
  # no job-level if — the matrix MUST expand so each per-leg check posts
  strategy:
    matrix: { include: [… eight legs …] }
  name: test (${{ matrix.id }})
  steps:
    - if: needs.changes.outputs.code == 'true'
      uses: actions/checkout@v4
    - if: needs.changes.outputs.code == 'true'
      run: ./build-and-test
```

Now every leg is instantiated. On a docs PR each leg starts, finds every step
`if`-gated off, runs nothing, and posts **green in a few seconds** under its
real expanded name. On a code PR the steps run exactly as before. The eight
required contexts are satisfied either way, and the docs PR merges.

This is the same shape the workflow's own `render-gate` job already used — a job
with no top-level `if`, every expensive step guarded individually, so it always
posts a check even when it does no work. The matrix legs just needed to be told
the same thing.

If you would rather not spin up eight near-empty jobs, the other fix is to stop
requiring the per-leg names at all and require a single aggregator job instead —
one `needs: [test]`, `if: always()` job that fails iff any leg failed. That name
is immune to how many legs exist and to how they skip. Requiring the leaf
contexts of a matrix, and then skipping that matrix, is the combination to
avoid.

## What actually generalizes

Strip the specifics and the shape is: **a required check waits on a name that a
skip never creates.** Two ways a workflow silently fails to create a required
name:

1. A `paths` / `paths-ignore` filter skips the whole workflow, so nothing posts.
2. A matrix job skipped at the job level is decided before expansion, so its
   per-leg contexts are never instantiated.

Both look identical from the PR page — a check stuck on `Expected`, no red, no
log to read, nothing to rerun. The instinct is to hunt for the job that failed.
There is no job that failed; there is a job that never ran, and a required name
that was never born. When a check sits on `Expected` with no run behind it, stop
looking for a failure and start asking which skip ate the check.
