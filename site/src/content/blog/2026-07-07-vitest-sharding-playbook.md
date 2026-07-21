---
title: 'All 2,592 tests passed and the job failed: a vitest sharding playbook'
description: "Three rounds of CI failures where every test was green and the job was red — vitest's worker→main reporter RPC timing out under file-count pressure. The ~110-file floor we split on (set below the lowest count we watched fail), the matrix design that contains it, and the playbook for the next regrowth."
date: 2026-07-07
tags: ['testing', 'ci', 'vitest', 'infrastructure']
lang: en
---

Three times in six weeks, a CI run on this repo ended like this: every test
passed, the job exited red, and the only error line was

```txt
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

Run 27242663060 is representative: 2,592/2,592 tests green, job failed —
twice in a row. The first red read like a flaky test, so the instinct was to
re-run — and it came back red _identically_: same green count, same reporter
error line. A flake that reproduces to the byte on re-run is not a flake, and
that is what turned attention from the tests to the channel reporting them.
This post is the diagnosis, the numbers we measured, and the playbook that has
kept it contained since.

## The mechanism

vitest workers report progress to the main thread over an RPC channel
(birpc); `onTaskUpdate` is the call that streams task state back per test.
The call has a timeout on the order of 60 s [1][2]. Under load the main
thread — which is also running the reporter, aggregating output, and
coordinating pools — falls behind on servicing those calls. RPC state
accumulates as a run progresses, so the failure probability rises with the
number of test files a single worker pool processes: the last files of a big
run are the ones that time out. The symptom is exactly what we saw, and what
others report upstream: **all tests pass, the run fails on the reporter
channel** [1][3].

Two mitigations don't require touching the pool at all:

- `--silent=true` — per-test console chatter keeps the main thread busy
  exactly when workers are waiting on it; failure output is unaffected.
  (Spell the value explicitly: bare `--silent <path>` makes the CLI parser
  eat the path filter as the flag's value.)
- **Fresh pools** — separate vitest _invocations_ each start a new worker
  pool: a new worker carries zero accumulated birpc backlog, so the timeout
  budget effectively resets at every leg boundary.

But the load-bearing variable is files-per-pool.

## The measured threshold: ~110 files per pool

We never found a documented limit; we found ours empirically, three times:

| Date       | Trigger               | Files in the leg     | Outcome                                   | Action                                 |
| ---------- | --------------------- | -------------------- | ----------------------------------------- | -------------------------------------- |
| baseline   | one combined run      | ~590                 | timeouts                                  | split into 5 path-filtered invocations |
| 2026-06-10 | test growth 226 → 262 | 262                  | green tests, red job ×2 (run 27242663060) | split runtime into two ~130-file legs  |
| 2026-06-16 | bug-hunt sweep        | 156 + 156            | flaked again (run 27581620678)            | four legs, each < 110 files            |
| 2026-06-26 | demo-QA sweep         | engine-render at 122 | green tests, red job (run 28186666263)    | `--shard=1/2` → two pools of ~61       |

~110 is a chosen _floor_, not a measured ceiling — and the table is honest
about the gap. The lowest count that has actually flaked here is 122 (the
2026-06-26 engine-render leg), yet the two ~130-file runtime legs from
2026-06-10 held until later growth pushed them past it. So there is no
clean line: the real edge drifts with runner speed and how much RPC a run has
already accumulated (slow CI hits it sooner; locally these all pass). We set
the tripwire at ~110 — deliberately _below_ the 122 we have watched fail — and
split on approach rather than probing for the exact edge on someone else's PR.
Treat it as a conservative budget, not a spec.

## Splitting without silently losing coverage

Two splitting mechanisms, used for different reasons:

- **Path partitions** (`runtime/src/engine/projection runtime/src/engine/text`,
  `--exclude` for the remainder) — readable legs with stable names, but you
  must prove the partition is _complete_: the excludes of one leg must be the
  includes of the others.
- **`vitest --shard=1/2`** [4] — when one directory alone exceeds the
  threshold. Deterministic, disjoint, and complete by construction: no glob
  arithmetic to get wrong.

The failure mode to fear is not a red job — it's a **silently green** one.
This matrix shards by directory, so when a package moves (our `map/` content
was extracted from `runtime/`), its tests stop matching every existing leg
and simply stop running, with nothing turning red. Every extraction now ships
with its own matrix leg, and the config carries the warning for the next one.

## The matrix around the shards

- Each leg is a matrix entry with a distinct check name (`test (engine-render-a)`),
  `fail-fast: false` so one red shard doesn't mask the others.
- A single **`test-result` aggregator** with `if: always()` is the only name
  branch protection should ever require — leg names change every re-split;
  the aggregator treats `success` and `skipped` both as a pass, so
  path-filtered skips [5] never strand a PR.
- The cost of parallel legs is real: the workspace build runs once per leg.
  Wall-clock ≈ the slowest leg (~84 s) instead of the serial ~189 s; the
  trade is runner-minutes for latency.

## The playbook

Written into the workflow file itself, next to the matrix:

1. A leg flakes `onTaskUpdate` after growing past ~110 files → **split that
   leg** (path partition if a directory boundary exists, `--shard=1/N` if
   not).
2. **Never merge legs back** to "rebalance" — the splits exist for the RPC
   ceiling, not for tidiness, and a merge reintroduces the flake months
   later on someone else's PR.
3. New package or extracted directory → **new leg**, in the same commit.

The general lesson: when a test job fails but every test passed, suspect the
_reporting channel_ before the tests — and treat its capacity as a budget
that test-suite growth spends.

## References

1. vitest-dev/vitest, [issue #6479 — `[vitest-worker]: Timeout calling
"onTaskUpdate"` on CI while all tests
   pass](https://github.com/vitest-dev/vitest/issues/6479).
2. vitest-dev/vitest, [issue #8164 — the 60 s birpc default behind the
   timeout](https://github.com/vitest-dev/vitest/issues/8164).
3. vitest-dev/vitest, [issue #4497 — `[birpc] timeout on calling
"onTaskUpdate"`](https://github.com/vitest-dev/vitest/issues/4497).
4. vitest, [CLI `--shard`
   documentation](https://vitest.dev/guide/cli.html).
5. dorny/paths-filter, [conditional job execution by changed
   paths](https://github.com/dorny/paths-filter).
